import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { makeTestApp } from './helpers/testApp.js';
import { UPLOADS_DIR, LIVE2D_SUBFOLDER } from '../src/routes/shared.js';

/**
 * POST /api/projects/:id/assets/bundle — Live2D bundle ingestion.
 *
 * The behaviour under test is the manifest-driven completeness check: a bundle
 * whose `*.model3.json` references files the upload doesn't contain must be
 * rejected with a report naming them, not stored and left to render blank.
 */
const b64 = (s: string) => Buffer.from(s).toString('base64');

interface Manifest {
  Moc?: unknown;
  Textures?: unknown;
  Physics?: string;
  Motions?: unknown;
  Expressions?: unknown;
}
const manifest = (fr: Manifest) =>
  b64(JSON.stringify({ Version: 3, FileReferences: fr }));

/** A complete, minimal bundle: manifest + moc3 + one texture. */
const completeFiles = () => [
  {
    relPath: 'model.model3.json',
    data: manifest({
      Moc: 'model.moc3',
      Textures: ['model.2048/texture_00.png'],
    }),
  },
  { relPath: 'model.moc3', data: b64('moc-bytes') },
  { relPath: 'model.2048/texture_00.png', data: b64('png-bytes') },
];

describe('Live2D bundle upload', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'Live2DProject' });
    projectId = res.body.data.id as string;
  });

  afterEach(() => {
    // Bundles are written to the real uploads dir; don't leave them behind.
    rmSync(join(UPLOADS_DIR, projectId), { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    request(app).post(`/api/projects/${projectId}/assets/bundle`).send(body);

  const upload = (files: unknown, rootName = 'model') =>
    post({ rootName, kind: 'live2d', files });

  const live2dDir = () => join(UPLOADS_DIR, projectId, LIVE2D_SUBFOLDER);
  const bundleDirs = () =>
    existsSync(live2dDir()) ? readdirSync(live2dDir()) : [];

  describe('a complete bundle', () => {
    it('is stored and registered against the manifest', async () => {
      const res = await upload(completeFiles());
      expect(res.status).toBe(201);
      expect(res.body.data.original_name).toBe('model.model3.json');
      expect(res.body.data.mime_type).toBe('application/x-live2d-model');
      expect(res.body.data.missingOptional).toEqual([]);

      // Every file landed at its manifest-relative path.
      const dirs = bundleDirs();
      expect(dirs).toHaveLength(1);
      const dir = join(live2dDir(), dirs[0]);
      expect(existsSync(join(dir, 'model.moc3'))).toBe(true);
      expect(existsSync(join(dir, 'model.2048', 'texture_00.png'))).toBe(true);
    });

    it('appears in the project asset list', async () => {
      await upload(completeFiles());
      const list = await request(app).get(`/api/projects/${projectId}/assets`);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].original_name).toBe('model.model3.json');
    });
  });

  describe('missing required files', () => {
    it('rejects a bundle with no moc3 and names it', async () => {
      const res = await upload([
        {
          relPath: 'model.model3.json',
          data: manifest({ Moc: 'model.moc3', Textures: ['t.png'] }),
        },
        { relPath: 't.png', data: b64('png') },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LIVE2D_BUNDLE_INCOMPLETE');
      expect(res.body.error.message).toContain('model.moc3');
      expect(res.body.error.details.missingRequired).toEqual([
        {
          ref: 'model.moc3',
          relPath: 'model.moc3',
          kind: 'moc',
          required: true,
        },
      ]);
    });

    it('rejects the flattened-bundle case, naming the expected texture paths', async () => {
      // The real hiyori-main failure: files present, but at the wrong paths.
      const res = await upload([
        {
          relPath: 'model.model3.json',
          data: manifest({
            Moc: 'model.moc3',
            Textures: ['model.2048/texture_00.png'],
            Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
          }),
        },
        { relPath: 'model.moc3', data: b64('moc') },
        { relPath: 'texture_00.png', data: b64('png') },
        { relPath: 'm01.motion3.json', data: b64('{}') },
      ]);
      expect(res.status).toBe(400);
      expect(
        res.body.error.details.missingRequired.map(
          (r: { relPath: string }) => r.relPath
        )
      ).toEqual(['model.2048/texture_00.png']);
      // The optional gap is reported too, so the completion UI can list both.
      expect(
        res.body.error.details.missingOptional.map(
          (r: { relPath: string }) => r.relPath
        )
      ).toEqual(['motion/m01.motion3.json']);
    });

    it('writes nothing to disk and registers no asset', async () => {
      const res = await upload([
        {
          relPath: 'model.model3.json',
          data: manifest({ Moc: 'gone.moc3', Textures: ['gone.png'] }),
        },
      ]);
      expect(res.status).toBe(400);
      expect(bundleDirs()).toEqual([]);
      const list = await request(app).get(`/api/projects/${projectId}/assets`);
      expect(list.body.data).toEqual([]);
    });
  });

  describe('missing optional files', () => {
    it('accepts the bundle and reports what is missing', async () => {
      const res = await upload([
        {
          relPath: 'model.model3.json',
          data: manifest({
            Moc: 'model.moc3',
            Textures: ['t.png'],
            Physics: 'model.physics3.json',
            Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
            Expressions: [{ Name: 'f01', File: 'exp/f01.exp3.json' }],
          }),
        },
        { relPath: 'model.moc3', data: b64('moc') },
        { relPath: 't.png', data: b64('png') },
      ]);
      expect(res.status).toBe(201);
      expect(
        res.body.data.missingOptional.map((r: { kind: string }) => r.kind)
      ).toEqual(['physics', 'expression', 'motion']);
      // …and it really is on disk, i.e. a warning, not a rejection.
      expect(bundleDirs()).toHaveLength(1);
    });
  });

  describe('malformed manifests', () => {
    it('rejects a manifest that is not valid JSON', async () => {
      const res = await upload([
        { relPath: 'model.model3.json', data: b64('{ not json') },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LIVE2D_BUNDLE_INCOMPLETE');
      expect(res.body.error.details.errors).toEqual([
        'manifest is not valid JSON',
      ]);
    });

    it('rejects a manifest with no FileReferences', async () => {
      const res = await upload([
        { relPath: 'model.model3.json', data: b64('{"Version":3}') },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.details.errors).toEqual([
        'manifest has no FileReferences block',
      ]);
    });

    it('rejects a manifest whose references escape the bundle', async () => {
      const res = await upload([
        {
          relPath: 'model.model3.json',
          data: manifest({ Moc: '../../../etc/passwd', Textures: ['t.png'] }),
        },
        { relPath: 't.png', data: b64('png') },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.details.errors).toContain(
        'unsafe manifest reference: ../../../etc/passwd'
      );
      expect(bundleDirs()).toEqual([]);
    });
  });

  describe('relPath safety (write path)', () => {
    it.each([
      ['traversal', '../escape.moc3'],
      ['absolute', '/etc/passwd'],
      ['backslash', 'a\\b.moc3'],
    ])(
      'rejects a %s relPath before writing anything',
      async (_label, relPath) => {
        const res = await upload([
          {
            relPath: 'model.model3.json',
            data: manifest({ Moc: 'model.moc3', Textures: ['t.png'] }),
          },
          { relPath, data: b64('evil') },
        ]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('unsafe relPath');
        expect(bundleDirs()).toEqual([]);
      }
    );
  });

  describe('manifest selection', () => {
    it('rejects a bundle with no manifest at all', async () => {
      const res = await upload([{ relPath: 'model.moc3', data: b64('moc') }]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('*.model3.json');
    });

    it('rejects an archive holding several models instead of picking one', async () => {
      const res = await upload([
        ...completeFiles(),
        {
          relPath: 'other/other.model3.json',
          data: manifest({ Moc: 'o.moc3' }),
        },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LIVE2D_MULTIPLE_MANIFESTS');
      expect(res.body.error.details.manifests).toEqual([
        'model.model3.json',
        'other/other.model3.json',
      ]);
      expect(bundleDirs()).toEqual([]);
    });
  });

  describe('request validation', () => {
    it('rejects a non-live2d kind', async () => {
      const res = await post({
        rootName: 'm',
        kind: 'vrm',
        files: completeFiles(),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('only live2d bundles');
    });

    it('rejects an empty files[]', async () => {
      const res = await upload([]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('non-empty files[]');
    });

    it('rejects a file entry missing relPath or data', async () => {
      const res = await upload([{ relPath: 'model.model3.json' }]);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('string relPath + data');
    });
  });
});
