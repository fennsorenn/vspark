/**
 * Getting a Live2D bundle out of whatever the user gave us.
 *
 * A Live2D model is a folder whose `*.model3.json` references its siblings by
 * relative path, so the *only* thing that matters here is producing
 * `{ relPath, file }[]` with those paths intact. Three sources produce it:
 *
 *   - the folder picker (`webkitdirectory` → `File.webkitRelativePath`),
 *   - a folder dropped onto the dock (`DataTransferItem.webkitGetAsEntry()`),
 *   - a `.zip`, expanded here in the browser.
 *
 * Zips are expanded client-side deliberately: the upload endpoint keeps the one
 * shape it already validates, and untrusted-archive handling stays out of the
 * server. Entry paths are still checked — a zip is arbitrary attacker-supplied
 * input, and `../` in an entry name is the classic Zip-Slip — but a rejected
 * entry here only means a file the user never gets to upload, not a file written
 * outside a directory.
 */
import { unzipSync } from 'fflate';
import { normalizeBundlePath } from '@vspark/shared/live2d';
import type { BundleFileInput } from '../api/client';

/** A `*.model3.json`, identified by its compound extension. */
export function isLive2dManifestPath(path: string): boolean {
  return path.toLowerCase().endsWith('.model3.json');
}

export function isZipFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

/** Bundle-root-relative path of a file's containing directory (`''` at root). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/**
 * Drop the single top-level folder an archive or picked directory wraps
 * everything in, so `Hiyori/foo.model3.json` becomes `foo.model3.json` — the
 * same shape the folder picker produces.
 *
 * Only strips when *every* entry shares one first segment; an archive with
 * files at the root, or with two top-level folders, is left alone. Returns the
 * stripped name too, since it is the best label for the bundle.
 */
export function stripCommonPrefix(files: BundleFileInput[]): {
  files: BundleFileInput[];
  prefix: string | null;
} {
  if (files.length === 0) return { files, prefix: null };
  const first = files[0].relPath.split('/')[0];
  const allNested = files.every(
    (f) =>
      f.relPath.startsWith(`${first}/`) && f.relPath.length > first.length + 1
  );
  if (!allNested) return { files, prefix: null };
  return {
    files: files.map((f) => ({
      ...f,
      relPath: f.relPath.slice(first.length + 1),
    })),
    prefix: first,
  };
}

/**
 * Every `*.model3.json` in a file set. More than one means the source held
 * several models and the user has to say which — silently taking the first
 * stores the others as dead weight under a model they didn't pick.
 */
export function findManifests(files: BundleFileInput[]): string[] {
  return files
    .filter((f) => isLive2dManifestPath(f.relPath))
    .map((f) => f.relPath);
}

/**
 * Narrow a multi-model file set to the one bundle containing `manifestRelPath`,
 * re-rooting every path at that manifest's directory.
 *
 * Files outside that directory are dropped: they belong to a sibling model (or
 * are archive chrome like a top-level README), and carrying them in would store
 * unrelated bytes under this model's directory.
 */
export function selectBundle(
  files: BundleFileInput[],
  manifestRelPath: string
): BundleFileInput[] {
  const base = dirOf(manifestRelPath);
  if (base) {
    const prefix = `${base}/`;
    return files
      .filter((f) => f.relPath.startsWith(prefix))
      .map((f) => ({ ...f, relPath: f.relPath.slice(prefix.length) }));
  }
  // The chosen manifest sits at the root, so "its bundle" is everything except
  // the other models — their manifests and whatever lives under them.
  const rivalDirs = findManifests(files)
    .filter((m) => m !== manifestRelPath)
    .map((m) => dirOf(m))
    .filter((d) => d !== '');
  return files.filter(
    (f) =>
      (f.relPath === manifestRelPath || !isLive2dManifestPath(f.relPath)) &&
      !rivalDirs.some((d) => f.relPath.startsWith(`${d}/`))
  );
}

// ─── Repairing a rearranged bundle ───────────────────────────────────────────

/** One missing reference matched to a file sitting somewhere else in the upload. */
export interface Relocation {
  /** Where the manifest wants the file. */
  relPath: string;
  /** Where the file actually is in the upload. */
  foundAt: string;
  /** True when only a case-insensitive comparison matched the two names. */
  caseOnly: boolean;
}

/** A missing reference several stray files could plausibly satisfy. */
export interface AmbiguousRelocation {
  relPath: string;
  /** Candidate source paths, for the user to choose between. */
  candidates: string[];
}

export interface RelocationPlan {
  relocations: Relocation[];
  ambiguous: AmbiguousRelocation[];
}

const lastSegment = (p: string) => p.split('/').pop() ?? p;

/**
 * Match manifest references that resolved to nothing against files that ARE in
 * the upload, just at a different path — the "someone rearranged the folder"
 * case, where every file is present but the structure the manifest describes is
 * gone.
 *
 * Matching is by file name, exact first and case-insensitively only as a
 * fallback (archives round-tripped through a case-insensitive filesystem are a
 * real source of this). A file already sitting at a path the manifest
 * references is never a candidate — it is doing its job where it is, and moving
 * it would break the reference it currently satisfies.
 *
 * A match is only proposed when it is unambiguous **in both directions**: one
 * candidate for the slot, and that candidate wanted by no other slot. Anything
 * else lands in `ambiguous` for the user to decide, because picking wrong here
 * produces a model that loads *looking* wrong — harder to notice, and harder to
 * debug, than one that refuses to load.
 *
 * This only ever proposes. Applying it is `applyRelocations`, and the caller is
 * expected to show the user what would move before doing so.
 */
export function planRelocations(
  presentPaths: string[],
  missingPaths: string[],
  referencedPaths: string[]
): RelocationPlan {
  const spokenFor = new Set(referencedPaths);
  const strays = presentPaths.filter((p) => !spokenFor.has(p));

  const candidatesFor = (want: string): string[] => {
    const name = lastSegment(want);
    const exact = strays.filter((p) => lastSegment(p) === name);
    if (exact.length > 0) return exact;
    const lower = name.toLowerCase();
    return strays.filter((p) => lastSegment(p).toLowerCase() === lower);
  };

  const bySlot = new Map(missingPaths.map((m) => [m, candidatesFor(m)]));

  // How many slots each stray file could fill — a file wanted by two slots
  // cannot be handed to either without asking.
  const demand = new Map<string, number>();
  for (const cands of bySlot.values())
    for (const c of cands) demand.set(c, (demand.get(c) ?? 0) + 1);

  const relocations: Relocation[] = [];
  const ambiguous: AmbiguousRelocation[] = [];
  for (const [relPath, cands] of bySlot) {
    if (cands.length === 0) continue;
    if (cands.length === 1 && demand.get(cands[0]) === 1) {
      relocations.push({
        relPath,
        foundAt: cands[0],
        caseOnly: lastSegment(cands[0]) !== lastSegment(relPath),
      });
      continue;
    }
    ambiguous.push({ relPath, candidates: cands });
  }
  return { relocations, ambiguous };
}

/**
 * Re-path each located file to where the manifest expects it.
 *
 * The file is **moved**, not copied: leaving the original behind would upload
 * the same bytes twice and store a stray the model never references.
 */
export function applyRelocations(
  files: BundleFileInput[],
  relocations: Relocation[]
): BundleFileInput[] {
  const moveTo = new Map(relocations.map((r) => [r.foundAt, r.relPath]));
  return files.map((f) => {
    const dest = moveTo.get(f.relPath);
    return dest ? { ...f, relPath: dest } : f;
  });
}

// ─── Drag and drop ───────────────────────────────────────────────────────────

/**
 * `readEntries` returns **at most 100 entries per call** and must be called
 * repeatedly until it yields an empty array. Reading once silently truncates a
 * large bundle rather than erroring — the single most common bug in this API,
 * and one that would quietly drop the 100th-plus motion of a real model.
 */
function readAllEntries(reader: {
  readEntries: (
    ok: (entries: FileSystemEntry[]) => void,
    err: (e: unknown) => void
  ) => void;
}): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Depth-first walk of one dropped entry, accumulating `{ relPath, file }`. */
async function walkEntry(
  entry: FileSystemEntry,
  base: string,
  out: BundleFileInput[]
): Promise<void> {
  const relPath = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ relPath, file: await entryFile(entry as FileSystemFileEntry) });
    return;
  }
  if (!entry.isDirectory) return;
  const entries = await readAllEntries(
    (entry as FileSystemDirectoryEntry).createReader()
  );
  // Sequential rather than parallel: directory readers are stateful, and a
  // bundle is small enough that the wall-clock difference is irrelevant.
  for (const child of entries) await walkEntry(child, relPath, out);
}

export interface DroppedFiles {
  /** Every file, with paths relative to the drop (directories descended into). */
  files: BundleFileInput[];
  /** True when at least one dropped item was a directory. */
  hadDirectory: boolean;
}

/**
 * Read a drop, descending into any dropped directories.
 *
 * `e.dataTransfer.files` does not descend — dropping a model folder yields
 * either nothing or a pile of loose files with no relative paths, so the
 * manifest's `foo.2048/texture_00.png` could never resolve. `webkitGetAsEntry()`
 * is what actually walks the tree.
 *
 * Falls back to `dataTransfer.files` where the entries API is unavailable, so
 * ordinary single-file drops keep working regardless.
 */
export async function readDroppedFiles(
  dataTransfer: DataTransfer
): Promise<DroppedFiles> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  if (entries.length === 0)
    return {
      files: Array.from(dataTransfer.files).map((file) => ({
        relPath: file.name,
        file,
      })),
      hadDirectory: false,
    };

  const files: BundleFileInput[] = [];
  for (const entry of entries) await walkEntry(entry, '', files);
  return { files, hadDirectory: entries.some((e) => e.isDirectory) };
}

// ─── Zip ─────────────────────────────────────────────────────────────────────

export class ZipError extends Error {}

/**
 * Blob → bytes. Prefers `Blob.arrayBuffer()`, falling back to `FileReader` —
 * which older Safari needs, and which is also the only path jsdom implements.
 */
function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function')
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Expand a `.zip` into bundle files.
 *
 * Directory entries and macOS archive chrome (`__MACOSX/`, `.DS_Store`) are
 * dropped — they are never part of a model and would otherwise be uploaded as
 * dead bytes. An entry whose path is absolute, backslashed or escapes the
 * archive root is rejected outright rather than sanitized: a zip has no
 * legitimate reason to carry one, and silently rewriting it would hide a
 * hostile archive rather than surface it.
 */
export async function expandZip(file: File): Promise<BundleFileInput[]> {
  const buf = await readBytes(file);
  // `unzipSync`, not the async `unzip`: the async variant offloads to a Worker
  // created from a blob URL, and where that is unavailable — a CSP forbidding
  // `worker-src blob:`, or a non-browser host — fflate degrades to *silently
  // wrong* output (every entry comes back split into bogus directory names)
  // rather than erroring. A wrong bundle that looks fine is exactly the failure
  // mode this whole feature exists to remove. The cost is a main-thread pause
  // while decompressing, which is small next to the base64 encode + single-request
  // upload that follows it.
  let entries;
  try {
    entries = unzipSync(buf);
  } catch (e) {
    throw new ZipError(
      e instanceof Error ? e.message : 'could not read archive'
    );
  }

  const out: BundleFileInput[] = [];
  for (const [rawPath, bytes] of Object.entries(entries)) {
    if (rawPath.endsWith('/')) continue; // directory entry
    if (rawPath.startsWith('__MACOSX/') || rawPath.endsWith('.DS_Store'))
      continue;
    const relPath = normalizeBundlePath(rawPath);
    if (!relPath)
      throw new ZipError(`archive contains an unsafe path: ${rawPath}`);
    out.push({
      relPath,
      file: new File([bytes as BlobPart], relPath.split('/').pop() ?? relPath),
    });
  }
  return out;
}
