/**
 * ifacialmocap.protocol.test.ts
 *
 * Unit tests for the iFacialMocap wire parser. Unlike the VMC OSC parser — which
 * lives unexported inside its manager and can only be tested through a
 * reimplementation (see subsystems.parse.test.ts) — this parser is a pure
 * exported module, so these tests exercise the real production code.
 */

import { describe, it, expect } from 'vitest';
import { ARKIT_SHAPES } from '@vspark/shared/arkit';
import {
  IFM_DEFAULT_PORT,
  IFM_HANDSHAKE,
  normalizeShapeName,
  parseIFacialMocapPacket,
  unityEulerToQuaternion,
} from '../src/behaviors/ifacialmocap_receiver/protocol.js';

const SIGNATURE_LENGTH =
  3 /* bones */ * 3 /* euler axes */ + ARKIT_SHAPES.length;

describe('iFacialMocap constants', () => {
  it('uses the documented port', () => {
    expect(IFM_DEFAULT_PORT).toBe(49983);
  });

  it('requests the v2 payload in the handshake', () => {
    expect(IFM_HANDSHAKE).toContain(
      'iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719'
    );
    expect(IFM_HANDSHAKE).toContain('sendDataVersion=v2');
  });
});

describe('normalizeShapeName', () => {
  it('expands the side suffixes to ARKit spelling', () => {
    expect(normalizeShapeName('browDown_L')).toBe('browDownLeft');
    expect(normalizeShapeName('mouthSmile_R')).toBe('mouthSmileRight');
  });

  it('leaves side-less names alone', () => {
    expect(normalizeShapeName('jawOpen')).toBe('jawOpen');
    expect(normalizeShapeName('tongueOut')).toBe('tongueOut');
  });
});

describe('unityEulerToQuaternion', () => {
  it('maps a zero rotation to identity', () => {
    expect(unityEulerToQuaternion(0, 0, 0)).toEqual([0, 0, 0, 1]);
  });

  it('maps a 90° yaw to a Y-axis quarter turn', () => {
    const [x, y, z, w] = unityEulerToQuaternion(0, 90, 0);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(Math.SQRT1_2, 10);
    expect(z).toBeCloseTo(0, 10);
    expect(w).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('produces unit quaternions for mixed angles', () => {
    const q = unityEulerToQuaternion(17, -43, 88);
    const len = Math.hypot(...q);
    expect(len).toBeCloseTo(1, 10);
  });
});

describe('parseIFacialMocapPacket — v2 (& separated)', () => {
  const packet =
    'browDown_L&12|browDown_R&8|jawOpen&50|tongueOut&0|' +
    '=head#10,20,30,0.1,0.2,0.3|rightEye#1,2,3|leftEye#-1,-2,-3|';

  it('parses blendshapes into 0..1 ARKit-named weights', () => {
    const frame = parseIFacialMocapPacket(packet)!;
    expect(frame.arkit.browDownLeft).toBeCloseTo(0.12);
    expect(frame.arkit.browDownRight).toBeCloseTo(0.08);
    expect(frame.arkit.jawOpen).toBeCloseTo(0.5);
    expect(frame.arkit.tongueOut).toBe(0);
  });

  it('parses head and both eyes into Unity-named bone quaternions', () => {
    const frame = parseIFacialMocapPacket(packet)!;
    expect(Object.keys(frame.bones).sort()).toEqual([
      'Head',
      'LeftEye',
      'RightEye',
    ]);
    expect(frame.bones.Head).toEqual(unityEulerToQuaternion(10, 20, 30));
    expect(frame.bones.RightEye).toEqual(unityEulerToQuaternion(1, 2, 3));
    expect(frame.bones.LeftEye).toEqual(unityEulerToQuaternion(-1, -2, -3));
  });

  it('emits a fixed-length signature covering eulers then all 52 shapes', () => {
    const frame = parseIFacialMocapPacket(packet)!;
    expect(frame.signature).toHaveLength(SIGNATURE_LENGTH);
    // Head euler leads, in IFM_BONES order.
    expect(frame.signature.slice(0, 3)).toEqual([10, 20, 30]);
    // Missing shapes contribute a zero rather than shifting later entries.
    const jawIdx = 9 + ARKIT_SHAPES.indexOf('jawOpen');
    expect(frame.signature[jawIdx]).toBeCloseTo(0.5);
  });

  it('ignores the trailing marker and unknown shape names', () => {
    const frame = parseIFacialMocapPacket(
      'jawOpen&50|notAnArkitShape&99|___iFacialMocap'
    )!;
    expect(Object.keys(frame.arkit)).toEqual(['jawOpen']);
  });
});

describe('parseIFacialMocapPacket — v1 (- separated)', () => {
  it('parses the legacy hyphen form', () => {
    const frame = parseIFacialMocapPacket(
      'eyeBlink_L-100|eyeBlink_R-0|=head#0,0,0,0,0,0|'
    )!;
    expect(frame.arkit.eyeBlinkLeft).toBe(1);
    expect(frame.arkit.eyeBlinkRight).toBe(0);
    expect(frame.bones.Head).toEqual([0, 0, 0, 1]);
  });
});

describe('parseIFacialMocapPacket — axis flips', () => {
  it('negates the requested axes before building the quaternion', () => {
    const text = '=head#10,20,30,0,0,0|';
    const flipped = parseIFacialMocapPacket(text, {
      invertPitch: true,
      invertRoll: true,
    })!;
    expect(flipped.bones.Head).toEqual(unityEulerToQuaternion(-10, 20, -30));
    // The signature stays on the raw device values, so toggling a flip mid-
    // session doesn't register as a one-frame motion spike.
    expect(flipped.signature.slice(0, 3)).toEqual([10, 20, 30]);
  });

  it('is a no-op when no flips are set', () => {
    const text = '=head#10,20,30,0,0,0|';
    expect(parseIFacialMocapPacket(text, {})!.bones.Head).toEqual(
      parseIFacialMocapPacket(text)!.bones.Head
    );
  });
});

describe('parseIFacialMocapPacket — rejection', () => {
  it('returns null for traffic that carries nothing recognisable', () => {
    expect(parseIFacialMocapPacket('')).toBeNull();
    expect(parseIFacialMocapPacket('hello world')).toBeNull();
    expect(parseIFacialMocapPacket('|||')).toBeNull();
    expect(parseIFacialMocapPacket('unknownShape&50')).toBeNull();
  });

  it('skips malformed euler segments without discarding the frame', () => {
    const frame = parseIFacialMocapPacket('jawOpen&50|=head#nope,nope|')!;
    expect(frame.bones.Head).toBeUndefined();
    expect(frame.arkit.jawOpen).toBeCloseTo(0.5);
  });

  it('tolerates a head segment without the position triple', () => {
    const frame = parseIFacialMocapPacket('=head#5,6,7|')!;
    expect(frame.bones.Head).toEqual(unityEulerToQuaternion(5, 6, 7));
  });
});
