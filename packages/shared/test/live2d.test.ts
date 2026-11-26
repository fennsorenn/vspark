import { describe, it, expect } from 'vitest';
import {
  normalizeBundlePath,
  parseLive2dManifest,
  checkLive2dBundle,
  isLive2dBundleBlocked,
} from '../src/live2d.js';

/** A minimal but realistic Hiyori-shaped manifest. */
const FULL_MANIFEST = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'hiyori.moc3',
    Textures: ['hiyori.2048/texture_00.png', 'hiyori.2048/texture_01.png'],
    Physics: 'hiyori.physics3.json',
    Pose: 'hiyori.pose3.json',
    DisplayInfo: 'hiyori.cdi3.json',
    UserData: 'hiyori.userdata3.json',
    Expressions: [
      { Name: 'f01', File: 'exp/f01.exp3.json' },
      { Name: 'f02', File: 'exp/f02.exp3.json' },
    ],
    Motions: {
      Idle: [
        { File: 'motion/hiyori_m01.motion3.json' },
        { File: 'motion/hiyori_m02.motion3.json', Sound: 'sound/m02.wav' },
      ],
      TapBody: [{ File: 'motion/hiyori_m03.motion3.json' }],
    },
  },
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }],
  HitAreas: [{ Id: 'HitAreaBody', Name: 'Body' }],
});

const ALL_FILES = [
  'hiyori.model3.json',
  'hiyori.moc3',
  'hiyori.2048/texture_00.png',
  'hiyori.2048/texture_01.png',
  'hiyori.physics3.json',
  'hiyori.pose3.json',
  'hiyori.cdi3.json',
  'hiyori.userdata3.json',
  'exp/f01.exp3.json',
  'exp/f02.exp3.json',
  'motion/hiyori_m01.motion3.json',
  'motion/hiyori_m02.motion3.json',
  'sound/m02.wav',
  'motion/hiyori_m03.motion3.json',
];

describe('normalizeBundlePath', () => {
  it('passes through an already-clean path', () => {
    expect(normalizeBundlePath('a/b/c.png')).toBe('a/b/c.png');
  });

  it('collapses empty and "." segments', () => {
    expect(normalizeBundlePath('./a//b/./c.png')).toBe('a/b/c.png');
  });

  it('resolves ".." against earlier segments', () => {
    expect(normalizeBundlePath('a/b/../c.png')).toBe('a/c.png');
  });

  it.each([
    ['absolute', '/etc/passwd'],
    ['backslash', 'a\\b.png'],
    ['NUL byte', 'a\0b.png'],
    ['empty', ''],
    ['escaping ..', '../outside.png'],
    ['escaping deeper ..', 'a/../../outside.png'],
    ['only dots', './.'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeBundlePath(input)).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(normalizeBundlePath(42 as unknown as string)).toBeNull();
  });
});

describe('parseLive2dManifest', () => {
  it('collects every FileReferences kind', () => {
    const { refs, errors } = parseLive2dManifest(
      'hiyori.model3.json',
      FULL_MANIFEST
    );
    expect(errors).toEqual([]);
    const byKind = (k: string) =>
      refs.filter((r) => r.kind === k).map((r) => r.relPath);
    expect(byKind('moc')).toEqual(['hiyori.moc3']);
    expect(byKind('texture')).toEqual([
      'hiyori.2048/texture_00.png',
      'hiyori.2048/texture_01.png',
    ]);
    expect(byKind('physics')).toEqual(['hiyori.physics3.json']);
    expect(byKind('pose')).toEqual(['hiyori.pose3.json']);
    expect(byKind('displayInfo')).toEqual(['hiyori.cdi3.json']);
    expect(byKind('userData')).toEqual(['hiyori.userdata3.json']);
    expect(byKind('expression')).toEqual([
      'exp/f01.exp3.json',
      'exp/f02.exp3.json',
    ]);
    expect(byKind('motion')).toEqual([
      'motion/hiyori_m01.motion3.json',
      'motion/hiyori_m02.motion3.json',
      'motion/hiyori_m03.motion3.json',
    ]);
    expect(byKind('motionSound')).toEqual(['sound/m02.wav']);
  });

  it('marks only Moc and Textures as required', () => {
    const { refs } = parseLive2dManifest('hiyori.model3.json', FULL_MANIFEST);
    const required = refs.filter((r) => r.required).map((r) => r.kind);
    expect(new Set(required)).toEqual(new Set(['moc', 'texture']));
  });

  it('labels expressions by name and motions by group + index', () => {
    const { refs } = parseLive2dManifest('hiyori.model3.json', FULL_MANIFEST);
    expect(refs.find((r) => r.relPath === 'exp/f01.exp3.json')?.label).toBe(
      'f01'
    );
    expect(
      refs.find((r) => r.relPath === 'motion/hiyori_m01.motion3.json')?.label
    ).toBe('Idle[0]');
    expect(
      refs.find((r) => r.relPath === 'motion/hiyori_m03.motion3.json')?.label
    ).toBe('TapBody[0]');
    expect(refs.find((r) => r.relPath === 'sound/m02.wav')?.label).toBe(
      'Idle[1]'
    );
  });

  it('does NOT treat Groups / HitAreas as file references', () => {
    const { refs } = parseLive2dManifest('hiyori.model3.json', FULL_MANIFEST);
    expect(refs.some((r) => r.relPath.includes('EyeBlink'))).toBe(false);
    expect(refs.some((r) => r.relPath.includes('HitArea'))).toBe(false);
  });

  it('resolves references relative to the manifest, not the bundle root', () => {
    const { refs } = parseLive2dManifest(
      'Hiyori/runtime/hiyori.model3.json',
      JSON.stringify({
        FileReferences: { Moc: 'hiyori.moc3', Textures: ['tex/t0.png'] },
      })
    );
    expect(refs.map((r) => r.relPath)).toEqual([
      'Hiyori/runtime/hiyori.moc3',
      'Hiyori/runtime/tex/t0.png',
    ]);
    // The manifest-relative form is preserved for display.
    expect(refs[1].ref).toBe('tex/t0.png');
  });

  it('deduplicates a file cited twice, keeping required', () => {
    const { refs } = parseLive2dManifest(
      'm.model3.json',
      JSON.stringify({
        FileReferences: {
          Moc: 'shared.bin',
          Textures: ['shared.bin', 't.png'],
          Motions: { Idle: [{ File: 't.png' }] },
        },
      })
    );
    expect(refs.map((r) => r.relPath)).toEqual(['shared.bin', 't.png']);
    // 'shared.bin' first seen as moc (required); the texture occurrence must not
    // create a duplicate, and 't.png' first seen as a required texture must not
    // be downgraded by the later optional motion reference.
    expect(refs.every((r) => r.required)).toBe(true);
  });

  it.each([
    ['unparseable JSON', 'not json{', 'manifest is not valid JSON'],
    ['a JSON array', '[]', 'manifest is not a JSON object'],
    ['a JSON scalar', '"hello"', 'manifest is not a JSON object'],
    [
      'no FileReferences',
      '{"Version":3}',
      'manifest has no FileReferences block',
    ],
    [
      'a non-object FileReferences',
      '{"FileReferences":[]}',
      'manifest has no FileReferences block',
    ],
  ])('errors on %s', (_label, text, message) => {
    const { refs, errors } = parseLive2dManifest('m.model3.json', text);
    expect(refs).toEqual([]);
    expect(errors).toEqual([message]);
  });

  it('errors when Moc or Textures are absent from an otherwise valid manifest', () => {
    const { errors } = parseLive2dManifest(
      'm.model3.json',
      JSON.stringify({ FileReferences: { Physics: 'p.json' } })
    );
    expect(errors).toEqual([
      'manifest has no FileReferences.Moc — nothing to render',
      'manifest has no FileReferences.Textures — nothing to draw',
    ]);
  });

  it('errors on a reference escaping the bundle instead of resolving it', () => {
    const { refs, errors } = parseLive2dManifest(
      'm.model3.json',
      JSON.stringify({
        FileReferences: {
          Moc: '../../../etc/passwd',
          Textures: ['/abs.png', 't.png'],
        },
      })
    );
    expect(errors).toContain('unsafe manifest reference: ../../../etc/passwd');
    expect(errors).toContain('unsafe manifest reference: /abs.png');
    // The safe reference still comes through.
    expect(refs.map((r) => r.relPath)).toEqual(['t.png']);
  });

  it('ignores malformed entries rather than throwing', () => {
    const { refs, errors } = parseLive2dManifest(
      'm.model3.json',
      JSON.stringify({
        FileReferences: {
          Moc: 'm.moc3',
          Textures: ['t.png', '', 42, null],
          Physics: 99,
          Expressions: [
            'not-an-object',
            { Name: 'x' },
            { File: 'exp/ok.exp3.json' },
          ],
          Motions: {
            Idle: 'not-an-array',
            Tap: [null, { File: 'motion/ok.json' }],
          },
        },
      })
    );
    expect(errors).toEqual([]);
    expect(refs.map((r) => r.relPath)).toEqual([
      'm.moc3',
      't.png',
      'exp/ok.exp3.json',
      'motion/ok.json',
    ]);
    // An expression with no File contributes nothing, and no label leaks onto it.
    expect(
      refs.find((r) => r.relPath === 'exp/ok.exp3.json')?.label
    ).toBeUndefined();
  });
});

describe('checkLive2dBundle', () => {
  it('reports nothing missing for a complete bundle', () => {
    const report = checkLive2dBundle(
      'hiyori.model3.json',
      FULL_MANIFEST,
      ALL_FILES
    );
    expect(report.errors).toEqual([]);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional).toEqual([]);
    expect(isLive2dBundleBlocked(report)).toBe(false);
    expect(report.manifest).toBe('hiyori.model3.json');
  });

  it('splits missing files into required and optional', () => {
    // The real hiyori-main failure: a flattened folder where every file sits at
    // the root but the manifest expects subdirectories.
    const flattened = [
      'hiyori.model3.json',
      'hiyori.moc3',
      'texture_00.png',
      'texture_01.png',
      'hiyori.physics3.json',
    ];
    const report = checkLive2dBundle(
      'hiyori.model3.json',
      FULL_MANIFEST,
      flattened
    );
    expect(report.missingRequired.map((r) => r.relPath)).toEqual([
      'hiyori.2048/texture_00.png',
      'hiyori.2048/texture_01.png',
    ]);
    expect(report.missingOptional.map((r) => r.relPath)).toContain(
      'motion/hiyori_m01.motion3.json'
    );
    // Physics IS present at its expected path, so it must not be reported.
    expect(report.missingOptional.map((r) => r.relPath)).not.toContain(
      'hiyori.physics3.json'
    );
    expect(isLive2dBundleBlocked(report)).toBe(true);
  });

  it('is not blocked when only optional files are missing', () => {
    const report = checkLive2dBundle('hiyori.model3.json', FULL_MANIFEST, [
      'hiyori.model3.json',
      'hiyori.moc3',
      'hiyori.2048/texture_00.png',
      'hiyori.2048/texture_01.png',
    ]);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional.length).toBeGreaterThan(0);
    expect(isLive2dBundleBlocked(report)).toBe(false);
  });

  it('normalizes both sides before matching', () => {
    const report = checkLive2dBundle(
      './m.model3.json',
      JSON.stringify({
        FileReferences: { Moc: './m.moc3', Textures: ['tex/../t.png'] },
      }),
      ['./m.model3.json', 'm.moc3', './t.png']
    );
    expect(report.missingRequired).toEqual([]);
    expect(report.manifest).toBe('m.model3.json');
  });

  it('ignores unusable entries in the present-file list', () => {
    const report = checkLive2dBundle(
      'm.model3.json',
      JSON.stringify({
        FileReferences: { Moc: 'm.moc3', Textures: ['t.png'] },
      }),
      ['m.moc3', 't.png', '', '../escape.png']
    );
    expect(report.missingRequired).toEqual([]);
  });

  it('matches case-sensitively rather than guessing', () => {
    const report = checkLive2dBundle(
      'm.model3.json',
      JSON.stringify({
        FileReferences: { Moc: 'M.moc3', Textures: ['T.png'] },
      }),
      ['m.moc3', 't.png']
    );
    expect(report.missingRequired.map((r) => r.relPath)).toEqual([
      'M.moc3',
      'T.png',
    ]);
  });

  it('is blocked by a manifest-level error even with every file present', () => {
    const report = checkLive2dBundle('m.model3.json', 'garbage{', ['m.moc3']);
    expect(report.errors).toEqual(['manifest is not valid JSON']);
    expect(report.refs).toEqual([]);
    expect(isLive2dBundleBlocked(report)).toBe(true);
  });

  it('falls back to the raw manifest path when it cannot be normalized', () => {
    const report = checkLive2dBundle('', '{}', []);
    expect(report.manifest).toBe('');
  });
});
