import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as schema from '../src/schema.js';

// All exported zod schemas, discovered generically.
const allSchemas = Object.entries(schema).filter(
  (e): e is [string, z.ZodTypeAny] => e[1] instanceof z.ZodType
);

describe('schema module surface', () => {
  it('exports a substantial body of zod schemas', () => {
    expect(allSchemas.length).toBeGreaterThan(30);
  });

  it('every schema safeParses garbage without throwing', () => {
    for (const [name, s] of allSchemas) {
      const r = s.safeParse(undefined);
      expect(typeof r.success, `${name}.safeParse(undefined)`).toBe('boolean');
    }
  });
});

describe('targeted validation', () => {
  it('createProjectSchema: name required, description optional', () => {
    expect(schema.createProjectSchema.safeParse({ name: 'P' }).success).toBe(
      true
    );
    expect(
      schema.createProjectSchema.safeParse({ name: 'P', description: 'd' })
        .success
    ).toBe(true);
    expect(schema.createProjectSchema.safeParse({}).success).toBe(false);
    expect(schema.createProjectSchema.safeParse({ name: '' }).success).toBe(
      false
    );
  });

  it('createSceneSchema: non-empty name', () => {
    expect(schema.createSceneSchema.safeParse({ name: 'S' }).success).toBe(
      true
    );
    expect(schema.createSceneSchema.safeParse({ name: '' }).success).toBe(
      false
    );
  });

  it('createSceneNodeSchema: name + valid kind enum', () => {
    expect(
      schema.createSceneNodeSchema.safeParse({ name: 'n', kind: 'group' })
        .success
    ).toBe(true);
    expect(
      schema.createSceneNodeSchema.safeParse({ name: 'n', kind: 'not_a_kind' })
        .success
    ).toBe(false);
  });

  it('createAnimationClipSchema applies defaults for absent fields', () => {
    const r = schema.createAnimationClipSchema.parse({
      name: 'clip',
      sourceFilePath: '/a.glb',
      duration: 2,
    });
    expect(r).toMatchObject({ clipIndex: 0, startTime: 0, fps: 30 });
  });

  it('fireGraphEventSchema needs nodeId + port', () => {
    expect(
      schema.fireGraphEventSchema.safeParse({ nodeId: 'a', port: 'fire' })
        .success
    ).toBe(true);
    expect(schema.fireGraphEventSchema.safeParse({ nodeId: 'a' }).success).toBe(
      false
    );
  });

  it('apiControllerBlendshapesSchema accepts either union arm', () => {
    expect(
      schema.apiControllerBlendshapesSchema.safeParse({ preset: 'smile' })
        .success
    ).toBe(true);
    expect(
      schema.apiControllerBlendshapesSchema.safeParse({
        blendshapes: { happy: 0.5 },
      }).success
    ).toBe(true);
    expect(
      schema.apiControllerBlendshapesSchema.safeParse({ nonsense: true })
        .success
    ).toBe(false);
  });

  it('presenceStateSchema enforces tuple shapes', () => {
    const ok = {
      sessionId: 's',
      nodeId: 'n',
      position: [0, 1, 2],
      rotation: [0, 0, 0],
      updatedAt: 'now',
    };
    expect(schema.presenceStateSchema.safeParse(ok).success).toBe(true);
    expect(
      schema.presenceStateSchema.safeParse({ ...ok, position: [0, 1] }).success
    ).toBe(false);
  });
});
