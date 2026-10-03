/**
 * BroadcastBus — publication validation + tick isolation.
 *
 * The bus composes slots on a setInterval, i.e. outside any request scope: a
 * value that throws during composition is an unhandled exception that stops the
 * server. The regression this guards against is a JSON-revived `Blendshapes`
 * (persisted node state round-tripped through SQLite loses class identity and
 * comes back as a plain object) reaching a slot and killing every tick with
 * "slot.blendshapes.entries is not a function".
 *
 * The bus resolves sceneNodeId → sceneId through getDb(), so these tests seed a
 * real scene_nodes row in an in-memory DB rather than mocking the lookup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Blendshapes, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import { BroadcastBus } from '../src/broadcast/bus.js';
import { resetDb } from './helpers/testDb.js';
import { getDb, closeDb } from '../src/db/index.js';

const SCENE = 'scene-1';
const NODE = 'avatar-1';
const BEHAVIOR = 'behavior-1';

function seedSceneNode(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name) VALUES ('p1', 'Test Project')"
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO scene_nodes
       (id, project_id, root_scene_node_id, name, kind, components)
     VALUES (?, 'p1', ?, 'Scene', 'scene', '{}')`
  ).run(SCENE, SCENE);
  db.prepare(
    `INSERT OR IGNORE INTO scene_nodes
       (id, project_id, root_scene_node_id, name, kind, components)
     VALUES (?, 'p1', ?, 'Avatar', 'avatar', '{}')`
  ).run(NODE, SCENE);
}

function makeWsStub() {
  const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  return {
    sent,
    ws: {
      broadcast(kind: string, payload: Record<string, unknown>) {
        sent.push({ kind, payload });
      },
      sendTo() {},
      onClientConnected() {},
    },
  };
}

let bus: BroadcastBus;
let wsStub: ReturnType<typeof makeWsStub>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDb();
  seedSceneNode();
  wsStub = makeWsStub();
  bus = new BroadcastBus();
  bus.init(wsStub.ws as never);
});

afterEach(() => {
  bus.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeDb();
});

/** Run one composition tick (the bus ticks at 60 Hz by default). */
function tick(): void {
  vi.advanceTimersByTime(20);
}

describe('BroadcastBus.publishBlendshapes', () => {
  it('composes and emits a real Blendshapes', () => {
    bus.publishBlendshapes(
      NODE,
      BEHAVIOR,
      Blendshapes.fromRecord({ happy: 0.5 })
    );
    tick();

    const frame = wsStub.sent.find((m) => m.kind === 'vmc_blendshapes');
    expect(frame).toBeDefined();
    expect(frame!.payload.blendshapes).toEqual({ happy: 0.5 });
  });

  it('drops a JSON-revived plain object instead of parking it in a slot', () => {
    // What `JSON.parse(JSON.stringify(new Blendshapes(...)))` yields: the private
    // Map serialises to {} and every method is gone.
    const revived = JSON.parse(
      JSON.stringify(Blendshapes.fromRecord({ happy: 0.5 }))
    ) as Blendshapes;
    expect(typeof (revived as { entries?: unknown }).entries).not.toBe(
      'function'
    );

    bus.publishBlendshapes(NODE, BEHAVIOR, revived);
    expect(() => tick()).not.toThrow();

    expect(wsStub.sent.some((m) => m.kind === 'vmc_blendshapes')).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warns once per behavior, not once per frame', () => {
    const bad = {} as Blendshapes;
    for (let i = 0; i < 5; i++) bus.publishBlendshapes(NODE, BEHAVIOR, bad);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('keeps the last good frame when a later publication is malformed', () => {
    bus.publishBlendshapes(NODE, BEHAVIOR, Blendshapes.fromRecord({ aa: 1 }));
    bus.publishBlendshapes(NODE, BEHAVIOR, {} as Blendshapes);
    tick();

    const frame = wsStub.sent.find((m) => m.kind === 'vmc_blendshapes');
    expect(frame!.payload.blendshapes).toEqual({ aa: 1 });
  });
});

describe('BroadcastBus.publishBones', () => {
  it('composes and emits a real NormalizedPose', () => {
    const pose = new NormalizedPose([['head', new Quaternion(0, 0, 0, 1)]]);
    bus.publishBones(NODE, BEHAVIOR, pose, 0, 'override');
    tick();

    const frame = wsStub.sent.find((m) => m.kind === 'vmc_pose');
    expect(frame).toBeDefined();
    expect(frame!.payload.bones).toHaveProperty('head');
  });

  it('drops a pose that lost its class identity', () => {
    bus.publishBones(NODE, BEHAVIOR, {} as NormalizedPose, 0, 'override');
    expect(() => tick()).not.toThrow();

    expect(wsStub.sent.some((m) => m.kind === 'vmc_pose')).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('BroadcastBus tick isolation', () => {
  it('keeps ticking when composition throws for one scene node', () => {
    const exploding = {
      entries: () => {
        throw new Error('boom');
      },
      toRecord: () => ({}),
    } as unknown as Blendshapes;

    bus.publishBlendshapes(NODE, BEHAVIOR, exploding);
    expect(() => tick()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    // The timer survived: a subsequent good publication still emits.
    bus.publishBlendshapes(NODE, BEHAVIOR, Blendshapes.fromRecord({ ee: 1 }));
    tick();
    expect(wsStub.sent.some((m) => m.kind === 'vmc_blendshapes')).toBe(true);
  });
});
