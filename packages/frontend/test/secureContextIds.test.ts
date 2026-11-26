import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost).
 * Opened from another machine over plain http://<lan-ip>, a direct call throws
 * and the create gesture silently does nothing. Ids come from
 * `randomUUID` in `@vspark/shared/sync`, which falls back to getRandomValues.
 */
const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('ids in non-secure contexts', () => {
  it('no frontend source calls crypto.randomUUID directly', () => {
    const offenders = sources(SRC)
      .filter((f) => /\bcrypto\.randomUUID\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
