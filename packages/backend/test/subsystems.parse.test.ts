/**
 * Parse subsystem tests.
 *
 * Covers:
 *  1. applyBoneMapping (rhylive_bone_mapper.ts) — VMC → VRM name mapping,
 *     coordinate-system correction (y/z negation), mirror mode, unknown bone
 *     filtering, and invalid-quaternion guard.
 *  2. VRM skeleton loader (vrm/skeleton.ts) guard branches — non-existent
 *     file, non-GLB magic bytes, GLB with no humanoid extension, VRM 0.x vs
 *     VRM 1.0 extension detection. Full skeleton parsing is gated behind a
 *     real GLB file so only structural / error paths are exercised here.
 *  3. OSC/VMC packet framing — a self-contained OSC buffer builder mirrors the
 *     format the internal parsePacket() function expects. We verify:
 *       a. that BoneRotations.fromRecord produces the same quaternion values
 *          as those encoded in an OSC message's float args at positions 4-7,
 *       b. that the RhyLive /Body flat-float layout (220 floats = 55 bones × 4)
 *          maps to the expected bone at each index,
 *       c. that a minimal OSC bundle (8-byte magic + timetag + size-prefixed
 *          elements) is structurally valid.
 *
 * NOTE: The internal `parseMsg`/`parsePacket` functions in
 *   `behaviors/vmc_receiver/manager.ts` are not exported. This file tests the
 *   downstream data model they produce (BoneRotations, NormalizedPose) and the
 *   pure mapping layer that consumes them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BoneRotations,
  Blendshapes,
  Quaternion,
  NormalizedPose,
} from '@vspark/shared/signal';
import { applyBoneMapping } from '../src/signal/nodes/rhylive_bone_mapper.js';
import { loadVrmSkeleton } from '../src/vrm/skeleton.js';

// ---------------------------------------------------------------------------
// Silence console noise from the skeleton loader warnings.
// ---------------------------------------------------------------------------
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

// ===========================================================================
// OSC buffer builder helpers
// These mirror the on-wire format that parsePacket() in vmc_receiver/manager
// consumes, allowing protocol-level assertions without touching internal code.
// ===========================================================================

function writeOscString(str: string): Buffer {
  // Null-terminated, padded to 4-byte boundary.
  const raw = Buffer.from(str + '\0', 'utf8');
  const padded = Math.ceil(raw.length / 4) * 4;
  const buf = Buffer.alloc(padded);
  raw.copy(buf);
  return buf;
}

function buildOscMessage(
  address: string,
  typeTags: string,
  writeArgs: (buf: Buffer, offset: number) => number
): Buffer {
  // Each arg-writing call returns the end offset.
  const addressBuf = writeOscString(address);
  const typeTagBuf = writeOscString(',' + typeTags);
  // Determine arg byte count by calling writeArgs with a scratch buffer.
  // We allocate a generous scratch buffer, call writeArgs to find end offset.
  const scratch = Buffer.alloc(1024);
  const argsLen = writeArgs(scratch, 0) - 0;
  const argsBuf = scratch.slice(0, argsLen);

  return Buffer.concat([addressBuf, typeTagBuf, argsBuf]);
}

function buildFloatArgs(values: number[]): (buf: Buffer, off: number) => number {
  return (buf, off) => {
    for (const v of values) {
      buf.writeFloatBE(v, off);
      off += 4;
    }
    return off;
  };
}

function buildStringThenFloats(
  str: string,
  values: number[]
): (buf: Buffer, off: number) => number {
  return (buf, off) => {
    const strBuf = writeOscString(str);
    strBuf.copy(buf, off);
    off += strBuf.length;
    for (const v of values) {
      buf.writeFloatBE(v, off);
      off += 4;
    }
    return off;
  };
}

function buildOscBundle(messages: Buffer[]): Buffer {
  // OSC bundle: '#bundle\0' (8 bytes) + timetag (8 bytes) + for each message: uint32 size + message
  const header = Buffer.alloc(16);
  header.write('#bundle\0', 0, 'utf8');
  // timetag: immediate = (0, 1) — two uint32 big-endian
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(1, 12);

  const parts: Buffer[] = [header];
  for (const msg of messages) {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(msg.length, 0);
    parts.push(sizeBuf, msg);
  }
  return Buffer.concat(parts);
}

// ===========================================================================
// applyBoneMapping
// ===========================================================================

describe('applyBoneMapping', () => {
  describe('basic VMC → VRM name translation', () => {
    it('maps Hips → hips with coordinate correction (y,z negated)', () => {
      // Original quaternion: (x=0.1, y=0.2, z=0.3, w=0.9)
      // After correction: (x=0.1, y=-0.2, z=-0.3, w=0.9)
      const bones = BoneRotations.fromRecord({
        Hips: [0.1, 0.2, 0.3, 0.9],
      });
      const pose = applyBoneMapping(bones);
      const q = pose.get('hips');
      expect(q).toBeDefined();
      expect(q!.x).toBeCloseTo(0.1);
      expect(q!.y).toBeCloseTo(-0.2);
      expect(q!.z).toBeCloseTo(-0.3);
      expect(q!.w).toBeCloseTo(0.9);
    });

    it('maps Head → head', () => {
      const bones = BoneRotations.fromRecord({ Head: [0, 0, 0, 1] });
      const pose = applyBoneMapping(bones);
      expect(pose.get('head')).toBeDefined();
    });

    it('maps LeftUpperArm → leftUpperArm', () => {
      const bones = BoneRotations.fromRecord({ LeftUpperArm: [0, 0, 0, 1] });
      const pose = applyBoneMapping(bones);
      expect(pose.get('leftUpperArm')).toBeDefined();
    });

    it('maps RightHand → rightHand', () => {
      const bones = BoneRotations.fromRecord({ RightHand: [0, 0, 0, 1] });
      const pose = applyBoneMapping(bones);
      expect(pose.get('rightHand')).toBeDefined();
    });

    it('maps LeftThumbProximal → leftThumbMetacarpal (VRM rename)', () => {
      const bones = BoneRotations.fromRecord({
        LeftThumbProximal: [0, 0, 0, 1],
      });
      const pose = applyBoneMapping(bones);
      expect(pose.get('leftThumbMetacarpal')).toBeDefined();
    });

    it('maps RightThumbIntermediate → rightThumbProximal (VRM rename)', () => {
      const bones = BoneRotations.fromRecord({
        RightThumbIntermediate: [0, 0, 0, 1],
      });
      const pose = applyBoneMapping(bones);
      expect(pose.get('rightThumbProximal')).toBeDefined();
    });
  });

  describe('coordinate-system correction', () => {
    it('identity quaternion passes through unchanged (0,0,0,1) → (0,-0,-0,1)', () => {
      const bones = BoneRotations.fromRecord({ Spine: [0, 0, 0, 1] });
      const pose = applyBoneMapping(bones);
      const q = pose.get('spine')!;
      // y and z are negated, but -0 === 0 in JS
      expect(q.x).toBeCloseTo(0);
      expect(q.y).toBeCloseTo(0);
      expect(q.z).toBeCloseTo(0);
      expect(q.w).toBeCloseTo(1);
    });

    it('non-trivial quaternion has y and z negated', () => {
      const bones = BoneRotations.fromRecord({ Neck: [0.5, 0.3, 0.1, 0.8] });
      const pose = applyBoneMapping(bones);
      const q = pose.get('neck')!;
      expect(q.x).toBeCloseTo(0.5);
      expect(q.y).toBeCloseTo(-0.3);
      expect(q.z).toBeCloseTo(-0.1);
      expect(q.w).toBeCloseTo(0.8);
    });
  });

  describe('unknown bone names are silently dropped', () => {
    it('bone name not in VMC_TO_VRM mapping is omitted from output', () => {
      const bones = BoneRotations.fromRecord({
        UnknownBone: [0, 0, 0, 1],
        Hips: [0, 0, 0, 1],
      });
      const pose = applyBoneMapping(bones);
      // UnknownBone has no VRM mapping, so only hips appears.
      expect(pose.size).toBe(1);
      expect(pose.get('hips')).toBeDefined();
    });

    it('empty BoneRotations produces empty NormalizedPose', () => {
      const bones = BoneRotations.fromRecord({});
      const pose = applyBoneMapping(bones);
      expect(pose.size).toBe(0);
    });
  });

  describe('invalid quaternion guard', () => {
    it('zero quaternion (not valid) is filtered out', () => {
      // A quaternion with near-zero magnitude is considered invalid.
      const bones = BoneRotations.fromRecord({ Hips: [0, 0, 0, 0] });
      const pose = applyBoneMapping(bones);
      // The zero quaternion fails isValid check and is dropped.
      expect(pose.size).toBe(0);
    });

    it('near-zero magnitude is also filtered', () => {
      const bones = BoneRotations.fromRecord({ Chest: [1e-6, 0, 0, 0] });
      const pose = applyBoneMapping(bones);
      expect(pose.size).toBe(0);
    });
  });

  describe('mirror mode', () => {
    it('with mirror=true, LeftUpperArm reads from RightUpperArm', () => {
      // In mirror mode the *output* slot for LeftUpperArm reads from
      // MIRROR_VMC[LeftUpperArm] = RightUpperArm's source quaternion.
      const bones = BoneRotations.fromRecord({
        LeftUpperArm: [0, 0, 0, 1], // present to create output slot
        RightUpperArm: [0.1, 0.2, 0.3, 0.9], // source for mirrored left
      });
      const pose = applyBoneMapping(bones, true);
      const leftArmQ = pose.get('leftUpperArm');
      expect(leftArmQ).toBeDefined();
      // Source is RightUpperArm = (0.1, 0.2, 0.3, 0.9); after coord correction y/z negated.
      expect(leftArmQ!.x).toBeCloseTo(0.1);
      expect(leftArmQ!.y).toBeCloseTo(-0.2);
      expect(leftArmQ!.z).toBeCloseTo(-0.3);
      expect(leftArmQ!.w).toBeCloseTo(0.9);
    });

    it('with mirror=false (default), each bone reads its own quaternion', () => {
      const bones = BoneRotations.fromRecord({
        LeftUpperArm: [0.4, 0.0, 0.0, 0.9],
        RightUpperArm: [0.1, 0.2, 0.3, 0.9],
      });
      const poseMirrored = applyBoneMapping(bones, false);
      const leftQ = poseMirrored.get('leftUpperArm')!;
      // Non-mirrored: LeftUpperArm → leftUpperArm, source = LeftUpperArm itself.
      expect(leftQ.x).toBeCloseTo(0.4);
    });

    it('mirror=true on a bone without a mirror partner uses itself as source', () => {
      // Hips has no entry in MIRROR_VMC — falls back to vmcName itself.
      const bones = BoneRotations.fromRecord({ Hips: [0.1, 0.2, 0.3, 0.9] });
      const pose = applyBoneMapping(bones, true);
      const q = pose.get('hips');
      // Falls back to Hips' own quaternion.
      expect(q).toBeDefined();
      expect(q!.x).toBeCloseTo(0.1);
    });
  });

  describe('multiple bones in one call', () => {
    it('maps several VMC bones to VRM in a single call', () => {
      const bones = BoneRotations.fromRecord({
        Hips: [0, 0, 0, 1],
        Spine: [0, 0, 0, 1],
        Chest: [0, 0, 0, 1],
        Head: [0, 0, 0, 1],
        LeftUpperArm: [0, 0, 0, 1],
        RightUpperArm: [0, 0, 0, 1],
      });
      const pose = applyBoneMapping(bones);
      expect(pose.size).toBe(6);
      expect(pose.get('hips')).toBeDefined();
      expect(pose.get('spine')).toBeDefined();
      expect(pose.get('chest')).toBeDefined();
      expect(pose.get('head')).toBeDefined();
      expect(pose.get('leftUpperArm')).toBeDefined();
      expect(pose.get('rightUpperArm')).toBeDefined();
    });
  });
});

// ===========================================================================
// OSC protocol structure tests
// Validates that the on-wire format understood by parsePacket() / parseMsg()
// in behaviors/vmc_receiver/manager.ts is structurally sound, without calling
// those private functions directly.
// ===========================================================================

describe('OSC buffer format (protocol contract)', () => {
  describe('VMC /VMC/Ext/Bone/Pos message encoding', () => {
    it('an encoded VMC bone message contains the bone name at arg[0] and xyzw at args[4-7]', () => {
      // Build a VMC /VMC/Ext/Bone/Pos message:
      // address: /VMC/Ext/Bone/Pos
      // type tags: ,sfffff (bone name + x,y,z,qx,qy,qz,qw)
      // args[0] = bone name (string), args[1..3] = position (float), args[4..7] = rotation (float)
      const boneName = 'Hips';
      const px = 0.0, py = 0.9, pz = 0.0; // position
      const qx = 0.1, qy = 0.2, qz = 0.3, qw = 0.9; // rotation

      // Encode address + type tags
      const addressBuf = writeOscString('/VMC/Ext/Bone/Pos');
      const typeTagBuf = writeOscString(',sfffffff');
      // Encode args: string, then 7 floats
      const nameBuf = writeOscString(boneName);
      const floatBuf = Buffer.alloc(7 * 4);
      floatBuf.writeFloatBE(px, 0);
      floatBuf.writeFloatBE(py, 4);
      floatBuf.writeFloatBE(pz, 8);
      floatBuf.writeFloatBE(qx, 12);
      floatBuf.writeFloatBE(qy, 16);
      floatBuf.writeFloatBE(qz, 20);
      floatBuf.writeFloatBE(qw, 24);

      const msg = Buffer.concat([addressBuf, typeTagBuf, nameBuf, floatBuf]);

      // Verify the first byte of the address is '/' (0x2f) — the parseMsg guard checks this.
      expect(msg[0]).toBe(0x2f);

      // Decode the bone name from the message to confirm the encoded string is correct.
      // The address occupies bytes 0..addressBuf.length-1; type tags follow.
      // Arg string starts at addressBuf.length + typeTagBuf.length.
      const argStart = addressBuf.length + typeTagBuf.length;
      let nameEnd = argStart;
      while (nameEnd < msg.length && msg[nameEnd] !== 0) nameEnd++;
      const decodedName = msg.toString('utf8', argStart, nameEnd);
      expect(decodedName).toBe('Hips');

      // Decode the rotation quaternion from the expected position in the buffer.
      const rotStart = argStart + nameBuf.length + 3 * 4; // skip 3 position floats
      const decodedQx = msg.readFloatBE(rotStart + 0);
      const decodedQy = msg.readFloatBE(rotStart + 4);
      const decodedQz = msg.readFloatBE(rotStart + 8);
      const decodedQw = msg.readFloatBE(rotStart + 12);
      expect(decodedQx).toBeCloseTo(qx, 4);
      expect(decodedQy).toBeCloseTo(qy, 4);
      expect(decodedQz).toBeCloseTo(qz, 4);
      expect(decodedQw).toBeCloseTo(qw, 4);
    });

    it('BoneRotations.fromRecord reproduces the same quaternion values', () => {
      // Simulates what the VMC parser does after extracting float args from the packet.
      const rawBones: Record<string, [number, number, number, number]> = {
        Hips: [0.1, 0.2, 0.3, 0.9],
        Head: [0.0, 0.0, 0.5, 0.866],
      };
      const bones = BoneRotations.fromRecord(rawBones);
      expect(bones.size).toBe(2);

      const hipsQ = bones.get('Hips')!;
      expect(hipsQ.x).toBeCloseTo(0.1);
      expect(hipsQ.y).toBeCloseTo(0.2);
      expect(hipsQ.z).toBeCloseTo(0.3);
      expect(hipsQ.w).toBeCloseTo(0.9);
    });
  });

  describe('RhyLive /Body flat-float layout', () => {
    it('RHYLIVE_BONES index 0 maps to Hips at float positions [0..3]', () => {
      // The /Body message sends 55 bones × 4 floats = 220 floats.
      // Index 0 = Hips, index 7 = Spine, index 10 = Head.
      // We can verify the index convention by checking BoneRotations.fromRecord
      // with the expected layout.
      const RHYLIVE_BONES_SAMPLE = [
        'Hips',         // 0
        'LeftUpperLeg', // 1
        'RightUpperLeg',// 2
        'LeftLowerLeg', // 3
        'RightLowerLeg',// 4
        'LeftFoot',     // 5
        'RightFoot',    // 6
        'Spine',        // 7
        'Chest',        // 8
        'Neck',         // 9
        'Head',         // 10
      ];

      // Construct a fake /Body message with known values for each bone slot.
      const args: number[] = new Array(220).fill(0);
      // Bone at index 0 (Hips): qx=0.1, qy=0.2, qz=0.3, qw=0.9
      args[0] = 0.1; args[1] = 0.2; args[2] = 0.3; args[3] = 0.9;
      // Bone at index 7 (Spine): qx=0, qy=0, qz=0, qw=1
      args[7 * 4 + 3] = 1;
      // Bone at index 10 (Head): qx=0.5, qy=0, qz=0, qw=0.866
      args[10 * 4] = 0.5; args[10 * 4 + 3] = 0.866;

      // Simulate the vmc_receiver extraction loop.
      const rawBones: Record<string, [number, number, number, number]> = {};
      for (let i = 0; i < RHYLIVE_BONES_SAMPLE.length; i++) {
        rawBones[RHYLIVE_BONES_SAMPLE[i]] = [
          args[i * 4],
          args[i * 4 + 1],
          args[i * 4 + 2],
          args[i * 4 + 3],
        ];
      }
      const bones = BoneRotations.fromRecord(rawBones);
      expect(bones.get('Hips')!.x).toBeCloseTo(0.1);
      expect(bones.get('Spine')!.w).toBeCloseTo(1);
      expect(bones.get('Head')!.x).toBeCloseTo(0.5);
      expect(bones.get('Head')!.w).toBeCloseTo(0.866);
    });

    it('/Body layout produces 220 args for 55 bones × 4 floats', () => {
      // Sanity-check: a /Body message must carry at least 220 float args.
      const BONE_COUNT = 55; // RhyLive sends all 55 HumanBodyBones slots
      const FLOATS_PER_BONE = 4; // x, y, z, w quaternion
      expect(BONE_COUNT * FLOATS_PER_BONE).toBe(220);
    });
  });

  describe('OSC bundle framing', () => {
    it('bundle starts with #bundle\\0 magic (8 bytes)', () => {
      const bundle = buildOscBundle([]);
      // First 8 bytes should be '#bundle\0'
      expect(bundle.toString('utf8', 0, 8)).toBe('#bundle\0');
    });

    it('bundle with one message has correct size prefix', () => {
      const boneName = 'Hips';
      const addressBuf = writeOscString('/VMC/Ext/Bone/Pos');
      const typeTagBuf = writeOscString(',sfffffff');
      const nameBuf = writeOscString(boneName);
      const floatBuf = Buffer.alloc(7 * 4);
      const msg = Buffer.concat([addressBuf, typeTagBuf, nameBuf, floatBuf]);

      const bundle = buildOscBundle([msg]);
      // After 16-byte header: 4-byte size field.
      const size = bundle.readUInt32BE(16);
      expect(size).toBe(msg.length);
    });

    it('a non-bundle message starts with "/" (0x2f)', () => {
      const addressBuf = writeOscString('/VMC/Ext/Bone/Pos');
      // First byte of OSC message must be '/'
      expect(addressBuf[0]).toBe(0x2f);
    });
  });

  describe('Blendshapes / ARKit face data', () => {
    it('Blendshapes.fromRecord preserves all shape weights', () => {
      // Simulates /Face message extraction (52 floats → ARKIT_SHAPES names).
      const faceData: Record<string, number> = {
        eyeBlinkLeft: 0.7,
        eyeBlinkRight: 0.5,
        jawOpen: 0.3,
        mouthSmileLeft: 0.8,
        mouthSmileRight: 0.9,
      };
      const bs = Blendshapes.fromRecord(faceData);
      expect(bs.get('eyeBlinkLeft')).toBeCloseTo(0.7);
      expect(bs.get('eyeBlinkRight')).toBeCloseTo(0.5);
      expect(bs.get('jawOpen')).toBeCloseTo(0.3);
      // Unknown shape → returns 0 (default)
      expect(bs.get('nonExistentShape')).toBe(0);
    });

    it('Blendshapes.fromRecord accepts 52 shapes without error', () => {
      // The ARKit spec defines exactly 52 blendshape channels.
      const ARKit52 = [
        'browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight',
        'cheekPuff','cheekSquintLeft','cheekSquintRight',
        'eyeBlinkLeft','eyeBlinkRight','eyeLookDownLeft','eyeLookDownRight',
        'eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight',
        'eyeLookUpLeft','eyeLookUpRight','eyeSquintLeft','eyeSquintRight',
        'eyeWideLeft','eyeWideRight',
        'jawForward','jawLeft','jawOpen','jawRight',
        'mouthClose','mouthDimpleLeft','mouthDimpleRight','mouthFrownLeft','mouthFrownRight',
        'mouthFunnel','mouthLeft','mouthLowerDownLeft','mouthLowerDownRight',
        'mouthPressLeft','mouthPressRight','mouthPucker','mouthRight',
        'mouthRollLower','mouthRollUpper','mouthShrugLower','mouthShrugUpper',
        'mouthSmileLeft','mouthSmileRight','mouthStretchLeft','mouthStretchRight',
        'mouthUpperUpLeft','mouthUpperUpRight',
        'noseSneerLeft','noseSneerRight',
        'tongueOut',
      ];
      expect(ARKit52).toHaveLength(52);

      const record: Record<string, number> = {};
      for (const name of ARKit52) record[name] = 0.5;
      const bs = Blendshapes.fromRecord(record);
      expect(bs.size).toBe(52);
    });
  });
});

// ===========================================================================
// VRM Skeleton loader — guard branches
// ===========================================================================

describe('loadVrmSkeleton', () => {
  const tmpDir = tmpdir();

  it('throws when file does not exist', () => {
    expect(() =>
      loadVrmSkeleton(join(tmpDir, '__nonexistent_file__.vrm'))
    ).toThrow();
  });

  it('throws when file does not have GLB magic bytes', () => {
    // Write a file with wrong magic
    const badFile = join(tmpDir, '__bad_magic__.glb');
    writeFileSync(badFile, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
    try {
      expect(() => loadVrmSkeleton(badFile)).toThrow(/Not a GLB/);
    } finally {
      unlinkSync(badFile);
    }
  });

  it('throws when GLB JSON chunk type is not 0x4E4F534A (JSON)', () => {
    // Build a minimal GLB with correct magic but wrong chunk type
    const wrongChunkFile = join(tmpDir, '__wrong_chunk__.glb');
    const buf = Buffer.alloc(28);
    // Magic: 0x46546C67 ('glTF' LE)
    buf.writeUInt32LE(0x46546c67, 0);
    // Version: 2
    buf.writeUInt32LE(2, 4);
    // Total length
    buf.writeUInt32LE(28, 8);
    // Chunk 0 length = 4
    buf.writeUInt32LE(4, 12);
    // Chunk 0 type = wrong (BIN = 0x004E4942 instead of JSON)
    buf.writeUInt32LE(0x004e4942, 16);
    // Chunk 0 data (4 bytes)
    buf.writeUInt32LE(0, 20);

    writeFileSync(wrongChunkFile, buf);
    try {
      expect(() => loadVrmSkeleton(wrongChunkFile)).toThrow(/chunk 0 is not JSON/i);
    } finally {
      unlinkSync(wrongChunkFile);
    }
  });

  it('throws when GLB has no humanoid bones in any extension', () => {
    // Build a valid minimal GLB with correct JSON chunk but no VRM extension
    const json = JSON.stringify({ nodes: [], extensions: {} });
    const jsonBuf = Buffer.from(json, 'utf8');
    // Pad to 4-byte boundary
    const padded = Math.ceil(jsonBuf.length / 4) * 4;
    const jsonPadded = Buffer.alloc(padded, 0x20); // pad with spaces
    jsonBuf.copy(jsonPadded);

    const totalLength = 12 + 8 + padded; // header + chunk header + chunk data
    const glbBuf = Buffer.alloc(totalLength);
    // GLB magic
    glbBuf.writeUInt32LE(0x46546c67, 0);
    // version 2
    glbBuf.writeUInt32LE(2, 4);
    // total length
    glbBuf.writeUInt32LE(totalLength, 8);
    // chunk 0 length
    glbBuf.writeUInt32LE(padded, 12);
    // chunk 0 type = JSON (0x4E4F534A)
    glbBuf.writeUInt32LE(0x4e4f534a, 16);
    // chunk 0 data
    jsonPadded.copy(glbBuf, 20);

    const noBonesFile = join(tmpDir, '__no_bones__.glb');
    writeFileSync(noBonesFile, glbBuf);
    try {
      expect(() => loadVrmSkeleton(noBonesFile)).toThrow(/No VRM humanoid bones/);
    } finally {
      unlinkSync(noBonesFile);
    }
  });

  it('parses VRM 0.x humanBones array format', () => {
    // Build a GLB with VRM 0.x extension: extensions.VRM.humanoid.humanBones = [{bone, node}]
    const json = JSON.stringify({
      nodes: [
        { name: 'Hips', translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { name: 'Spine', children: [0] }, // Spine is parent of Hips (for parent lookup test)
      ],
      extensions: {
        VRM: {
          humanoid: {
            humanBones: [
              { bone: 'hips', node: 0 },
              { bone: 'spine', node: 1 },
            ],
          },
        },
      },
    });
    const jsonBuf = Buffer.from(json, 'utf8');
    const padded = Math.ceil(jsonBuf.length / 4) * 4;
    const jsonPadded = Buffer.alloc(padded, 0x20);
    jsonBuf.copy(jsonPadded);

    const totalLength = 12 + 8 + padded;
    const glbBuf = Buffer.alloc(totalLength);
    glbBuf.writeUInt32LE(0x46546c67, 0);
    glbBuf.writeUInt32LE(2, 4);
    glbBuf.writeUInt32LE(totalLength, 8);
    glbBuf.writeUInt32LE(padded, 12);
    glbBuf.writeUInt32LE(0x4e4f534a, 16);
    jsonPadded.copy(glbBuf, 20);

    const vrm0File = join(tmpDir, '__vrm0__.glb');
    writeFileSync(vrm0File, glbBuf);
    try {
      const skeleton = loadVrmSkeleton(vrm0File);
      expect(skeleton).toBeDefined();
      expect(skeleton.hips).toBeDefined();
      expect(skeleton.hips.localTranslation).toEqual([0, 1, 0]);
      expect(skeleton.hips.localRotation).toEqual([0, 0, 0, 1]);
      // Spine node (index 1) has child node 0 (Hips), so Hips' parent is Spine.
      expect(skeleton.hips.parent).toBe('spine');
      // Spine's parent: no node has Spine (index 1) as a child → null
      expect(skeleton.spine.parent).toBeNull();
    } finally {
      unlinkSync(vrm0File);
    }
  });

  it('parses VRM 1.0 humanBones record format', () => {
    // Build a GLB with VRM 1.0 extension: extensions.VRMC_vrm.humanoid.humanBones = {boneName: {node}}
    const json = JSON.stringify({
      nodes: [
        { name: 'Hips', translation: [0, 0.9, 0], rotation: [0, 0, 0, 1] },
        { name: 'Head', translation: [0, 0.2, 0], rotation: [0, 0, 0, 1] },
      ],
      extensions: {
        VRMC_vrm: {
          humanoid: {
            humanBones: {
              hips: { node: 0 },
              head: { node: 1 },
            },
          },
        },
      },
    });
    const jsonBuf = Buffer.from(json, 'utf8');
    const padded = Math.ceil(jsonBuf.length / 4) * 4;
    const jsonPadded = Buffer.alloc(padded, 0x20);
    jsonBuf.copy(jsonPadded);

    const totalLength = 12 + 8 + padded;
    const glbBuf = Buffer.alloc(totalLength);
    glbBuf.writeUInt32LE(0x46546c67, 0);
    glbBuf.writeUInt32LE(2, 4);
    glbBuf.writeUInt32LE(totalLength, 8);
    glbBuf.writeUInt32LE(padded, 12);
    glbBuf.writeUInt32LE(0x4e4f534a, 16);
    jsonPadded.copy(glbBuf, 20);

    const vrm1File = join(tmpDir, '__vrm1__.glb');
    writeFileSync(vrm1File, glbBuf);
    try {
      const skeleton = loadVrmSkeleton(vrm1File);
      expect(skeleton).toBeDefined();
      expect(skeleton.hips).toBeDefined();
      expect(skeleton.head).toBeDefined();
      expect(skeleton.hips.localTranslation).toEqual([0, 0.9, 0]);
      // Neither hips nor head has a parent in the nodes list.
      expect(skeleton.hips.parent).toBeNull();
      expect(skeleton.head.parent).toBeNull();
    } finally {
      unlinkSync(vrm1File);
    }
  });

  it('node missing translation/rotation defaults to zero translation and identity rotation', () => {
    // Node with no translation or rotation fields should get defaults.
    const json = JSON.stringify({
      nodes: [
        { name: 'Hips' }, // no translation, no rotation
      ],
      extensions: {
        VRMC_vrm: {
          humanoid: {
            humanBones: {
              hips: { node: 0 },
            },
          },
        },
      },
    });
    const jsonBuf = Buffer.from(json, 'utf8');
    const padded = Math.ceil(jsonBuf.length / 4) * 4;
    const jsonPadded = Buffer.alloc(padded, 0x20);
    jsonBuf.copy(jsonPadded);

    const totalLength = 12 + 8 + padded;
    const glbBuf = Buffer.alloc(totalLength);
    glbBuf.writeUInt32LE(0x46546c67, 0);
    glbBuf.writeUInt32LE(2, 4);
    glbBuf.writeUInt32LE(totalLength, 8);
    glbBuf.writeUInt32LE(padded, 12);
    glbBuf.writeUInt32LE(0x4e4f534a, 16);
    jsonPadded.copy(glbBuf, 20);

    const defaultsFile = join(tmpDir, '__defaults__.glb');
    writeFileSync(defaultsFile, glbBuf);
    try {
      const skeleton = loadVrmSkeleton(defaultsFile);
      expect(skeleton.hips.localTranslation).toEqual([0, 0, 0]);
      expect(skeleton.hips.localRotation).toEqual([0, 0, 0, 1]);
    } finally {
      unlinkSync(defaultsFile);
    }
  });
});

// ===========================================================================
// Shared signal data types — unit tests for BoneRotations and NormalizedPose
// ===========================================================================

describe('BoneRotations', () => {
  it('fromRecord produces correct Quaternion instances', () => {
    const br = BoneRotations.fromRecord({ Hips: [0, 0, 0, 1] });
    const q = br.get('Hips')!;
    expect(q).toBeInstanceOf(Quaternion);
    expect(q.w).toBeCloseTo(1);
  });

  it('has() returns true for present bones', () => {
    const br = BoneRotations.fromRecord({ Head: [0, 0, 0, 1] });
    expect(br.has('Head')).toBe(true);
    expect(br.has('Spine')).toBe(false);
  });

  it('size reflects number of bones', () => {
    const br = BoneRotations.fromRecord({
      Hips: [0, 0, 0, 1],
      Head: [0, 0, 0, 1],
    });
    expect(br.size).toBe(2);
  });

  it('toRecord round-trips values', () => {
    const input = { Hips: [0.1, 0.2, 0.3, 0.9] as [number, number, number, number] };
    const br = BoneRotations.fromRecord(input);
    const out = br.toRecord();
    expect(out.Hips[0]).toBeCloseTo(0.1);
    expect(out.Hips[1]).toBeCloseTo(0.2);
    expect(out.Hips[2]).toBeCloseTo(0.3);
    expect(out.Hips[3]).toBeCloseTo(0.9);
  });

  it('map() transforms all quaternions', () => {
    const br = BoneRotations.fromRecord({
      Hips: [0, 0, 0, 1],
      Head: [0.1, 0, 0, 0.9],
    });
    const negated = br.map((q) => new Quaternion(-q.x, -q.y, -q.z, q.w));
    expect(negated.get('Head')!.x).toBeCloseTo(-0.1);
  });
});

describe('Blendshapes', () => {
  it('fromRecord stores and retrieves values', () => {
    const bs = Blendshapes.fromRecord({ eyeBlinkLeft: 0.8 });
    expect(bs.get('eyeBlinkLeft')).toBeCloseTo(0.8);
  });

  it('get() returns 0 for absent key', () => {
    const bs = Blendshapes.fromRecord({ eyeBlinkLeft: 0.5 });
    expect(bs.get('notAShape')).toBe(0);
  });

  it('with() returns a new instance with the updated field', () => {
    const bs = Blendshapes.fromRecord({ jawOpen: 0.2 });
    const bs2 = bs.with('jawOpen', 0.9);
    expect(bs2.get('jawOpen')).toBeCloseTo(0.9);
    // Original unchanged
    expect(bs.get('jawOpen')).toBeCloseTo(0.2);
  });

  it('with() clamps values to [0, 1]', () => {
    const bs = Blendshapes.fromRecord({});
    expect(bs.with('x', 1.5).get('x')).toBeCloseTo(1);
    expect(bs.with('x', -0.3).get('x')).toBeCloseTo(0);
  });

  it('toRecord() produces a plain object with all values', () => {
    const bs = Blendshapes.fromRecord({ a: 0.1, b: 0.2 });
    const rec = bs.toRecord();
    expect(rec.a).toBeCloseTo(0.1);
    expect(rec.b).toBeCloseTo(0.2);
  });
});
