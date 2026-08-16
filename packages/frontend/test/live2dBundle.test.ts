import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import {
  isLive2dManifestPath,
  isZipFile,
  stripCommonPrefix,
  findManifests,
  selectBundle,
  readDroppedFiles,
  expandZip,
  ZipError,
} from '../src/lib/live2dBundle';
import type { BundleFileInput } from '../src/api/client';

const f = (relPath: string, body = 'x'): BundleFileInput => ({
  relPath,
  file: new File([body], relPath.split('/').pop() ?? relPath),
});

const paths = (files: BundleFileInput[]) => files.map((x) => x.relPath);

describe('isLive2dManifestPath / isZipFile', () => {
  it('matches the compound manifest extension, case-insensitively', () => {
    expect(isLive2dManifestPath('a/b/hiyori.Model3.JSON')).toBe(true);
    // The dot matters: `model3.json` with no stem is not a manifest.
    expect(isLive2dManifestPath('model3.json')).toBe(false);
    expect(isLive2dManifestPath('hiyori.moc3')).toBe(false);
    expect(isLive2dManifestPath('settings.json')).toBe(false);
  });

  it('recognises zips by extension or MIME type', () => {
    expect(isZipFile(new File([], 'model.ZIP'))).toBe(true);
    expect(isZipFile(new File([], 'model', { type: 'application/zip' }))).toBe(
      true
    );
    expect(
      isZipFile(new File([], 'm', { type: 'application/x-zip-compressed' }))
    ).toBe(true);
    expect(isZipFile(new File([], 'model.moc3'))).toBe(false);
  });
});

describe('stripCommonPrefix', () => {
  it('drops the single wrapping folder an archive adds', () => {
    const { files, prefix } = stripCommonPrefix([
      f('Hiyori/hiyori.model3.json'),
      f('Hiyori/hiyori.moc3'),
      f('Hiyori/tex/t0.png'),
    ]);
    expect(prefix).toBe('Hiyori');
    expect(paths(files)).toEqual([
      'hiyori.model3.json',
      'hiyori.moc3',
      'tex/t0.png',
    ]);
  });

  it('leaves a bare (already-unwrapped) set alone', () => {
    const input = [f('hiyori.model3.json'), f('tex/t0.png')];
    const { files, prefix } = stripCommonPrefix(input);
    expect(prefix).toBeNull();
    expect(paths(files)).toEqual(['hiyori.model3.json', 'tex/t0.png']);
  });

  it('leaves two top-level folders alone', () => {
    const { prefix } = stripCommonPrefix([f('A/x.png'), f('B/y.png')]);
    expect(prefix).toBeNull();
  });

  it('does not strip when a top-level FILE shares the folder name', () => {
    // `Hiyori` as a file and `Hiyori/…` as a folder — stripping would produce
    // an empty relPath for the file.
    const { prefix } = stripCommonPrefix([f('Hiyori'), f('Hiyori/a.png')]);
    expect(prefix).toBeNull();
  });

  it('handles an empty set', () => {
    expect(stripCommonPrefix([])).toEqual({ files: [], prefix: null });
  });
});

describe('findManifests / selectBundle', () => {
  const multi = [
    f('modelA/a.model3.json'),
    f('modelA/a.moc3'),
    f('modelA/tex/t.png'),
    f('modelB/b.model3.json'),
    f('modelB/b.moc3'),
    f('README.txt'),
  ];

  it('finds every manifest', () => {
    expect(findManifests(multi)).toEqual([
      'modelA/a.model3.json',
      'modelB/b.model3.json',
    ]);
  });

  it('narrows to one model and re-roots its paths', () => {
    expect(paths(selectBundle(multi, 'modelA/a.model3.json'))).toEqual([
      'a.model3.json',
      'a.moc3',
      'tex/t.png',
    ]);
  });

  it('excludes sibling models when the chosen manifest is at the root', () => {
    const rootAndNested = [
      f('root.model3.json'),
      f('root.moc3'),
      f('tex/t.png'),
      f('other/other.model3.json'),
      f('other/other.moc3'),
    ];
    expect(paths(selectBundle(rootAndNested, 'root.model3.json'))).toEqual([
      'root.model3.json',
      'root.moc3',
      'tex/t.png',
    ]);
  });
});

// ─── Zip ─────────────────────────────────────────────────────────────────────

/**
 * ASCII → bytes, deliberately NOT via fflate's `strToU8`.
 *
 * `strToU8` uses `TextEncoder`, and under jsdom that returns a `Uint8Array` from
 * a *different realm* — so `zipSync`'s `instanceof Uint8Array` check fails, it
 * treats the value as a nested directory, and emits one bogus entry per byte.
 * Constructing the array here keeps it in the test's own realm. (Production is
 * unaffected: a browser has one realm, and `expandZip` only ever reads.)
 */
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const makeZip = (entries: Record<string, string>): File =>
  new File(
    [
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([k, v]) => [k, bytes(v)])
        )
      ) as unknown as BlobPart,
    ],
    'bundle.zip'
  );

describe('expandZip', () => {
  it('expands entries, preserving subfolder paths', async () => {
    const files = await expandZip(
      makeZip({
        'Hiyori/hiyori.model3.json': '{}',
        'Hiyori/hiyori.moc3': 'moc',
        'Hiyori/hiyori.2048/texture_00.png': 'png',
      })
    );
    expect(paths(files).sort()).toEqual([
      'Hiyori/hiyori.2048/texture_00.png',
      'Hiyori/hiyori.moc3',
      'Hiyori/hiyori.model3.json',
    ]);
  });

  it('round-trips file contents', async () => {
    const files = await expandZip(
      makeZip({ 'a.model3.json': '{"Version":3}' })
    );
    // jsdom's File has no .text(); read it the way the upload path does.
    const text = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsText(files[0].file);
    });
    expect(text).toBe('{"Version":3}');
  });

  it('drops macOS archive chrome', async () => {
    const files = await expandZip(
      makeZip({
        'model.moc3': 'moc',
        '__MACOSX/._model.moc3': 'junk',
        '.DS_Store': 'junk',
        'sub/.DS_Store': 'junk',
      })
    );
    expect(paths(files)).toEqual(['model.moc3']);
  });

  it('rejects a Zip-Slip entry rather than sanitizing it', async () => {
    await expect(
      expandZip(makeZip({ '../../etc/passwd': 'pwned' }))
    ).rejects.toBeInstanceOf(ZipError);
  });

  it('rejects an absolute entry path', async () => {
    await expect(
      expandZip(makeZip({ '/etc/passwd': 'pwned' }))
    ).rejects.toBeInstanceOf(ZipError);
  });

  it('reports a corrupt archive as a ZipError', async () => {
    await expect(
      expandZip(new File(['not a zip at all'], 'broken.zip'))
    ).rejects.toBeInstanceOf(ZipError);
  });
});

// ─── Drag and drop ───────────────────────────────────────────────────────────

/** Minimal `FileSystemEntry` fakes — jsdom implements none of this API. */
function fileEntry(name: string, body = 'x'): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (cb: (f: File) => void) => cb(new File([body], name)),
  } as unknown as FileSystemEntry;
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      // Mirrors the real API: hands back at most 100 entries per call, then an
      // empty array. A single-read implementation would silently truncate.
      let offset = 0;
      return {
        readEntries(ok: (e: FileSystemEntry[]) => void) {
          const batch = children.slice(offset, offset + 100);
          offset += batch.length;
          ok(batch);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

const dataTransfer = (
  entries: FileSystemEntry[],
  files: File[] = []
): DataTransfer =>
  ({
    items: entries.map((e) => ({
      kind: 'file' as const,
      webkitGetAsEntry: () => e,
    })),
    files,
  }) as unknown as DataTransfer;

describe('readDroppedFiles', () => {
  it('descends into a dropped directory, preserving relative paths', async () => {
    const { files, hadDirectory } = await readDroppedFiles(
      dataTransfer([
        dirEntry('Hiyori', [
          fileEntry('hiyori.model3.json'),
          fileEntry('hiyori.moc3'),
          dirEntry('hiyori.2048', [fileEntry('texture_00.png')]),
        ]),
      ])
    );
    expect(hadDirectory).toBe(true);
    expect(paths(files)).toEqual([
      'Hiyori/hiyori.model3.json',
      'Hiyori/hiyori.moc3',
      'Hiyori/hiyori.2048/texture_00.png',
    ]);
  });

  it('reads past the 100-entry readEntries batch limit', async () => {
    // The truncation bug this guards: 250 motions, read 100 at a time.
    const many = Array.from({ length: 250 }, (_, i) =>
      fileEntry(`m${i}.motion3.json`)
    );
    const { files } = await readDroppedFiles(
      dataTransfer([dirEntry('motion', many)])
    );
    expect(files).toHaveLength(250);
    expect(files[249].relPath).toBe('motion/m249.motion3.json');
  });

  it('keeps plain file drops working, flagged as not-a-directory', async () => {
    const { files, hadDirectory } = await readDroppedFiles(
      dataTransfer([fileEntry('photo.png'), fileEntry('clip.mp4')])
    );
    expect(hadDirectory).toBe(false);
    expect(paths(files)).toEqual(['photo.png', 'clip.mp4']);
  });

  it('falls back to dataTransfer.files where the entries API is absent', async () => {
    const dt = {
      items: [],
      files: [new File(['x'], 'legacy.png')],
    } as unknown as DataTransfer;
    const { files, hadDirectory } = await readDroppedFiles(dt);
    expect(paths(files)).toEqual(['legacy.png']);
    expect(hadDirectory).toBe(false);
  });
});
