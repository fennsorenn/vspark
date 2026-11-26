/**
 * Client credentials — how a browser tab proves it may join this server's
 * mesh (principle 9: every participant authenticates).
 *
 * A browser enrolls once and keeps a random bearer token; the server stores
 * only its SHA-256. Every `/mesh` hello carries the token, and a hello whose
 * token isn't on file is refused before any mesh message is handled.
 *
 * Enrollment is automatic for a browser on this machine. A browser anywhere
 * else needs the current pairing code, which the server prints on start and
 * shows to local callers; a code is single-use, and a few wrong guesses rotate
 * it.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function issueClientToken(label: string): {
  clientId: string;
  token: string;
} {
  const clientId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  getDb()
    .prepare(
      'INSERT INTO client_credentials (id, token_hash, label) VALUES (?, ?, ?)'
    )
    .run(clientId, hash(token), label.slice(0, 120));
  return { clientId, token };
}

/** The client a token belongs to, or null when it isn't (or no longer) valid. */
export function verifyClientToken(token: string): string | null {
  if (!token) return null;
  const row = getDb()
    .prepare(
      'SELECT id FROM client_credentials WHERE token_hash = ? AND revoked_at IS NULL'
    )
    .get(hash(token)) as { id: string } | undefined;
  if (!row) return null;
  getDb()
    .prepare(
      "UPDATE client_credentials SET last_seen = datetime('now') WHERE id = ?"
    )
    .run(row.id);
  return row.id;
}

export function revokeClient(clientId: string): void {
  getDb()
    .prepare(
      "UPDATE client_credentials SET revoked_at = datetime('now') WHERE id = ?"
    )
    .run(clientId);
}

// --- pairing ---------------------------------------------------------------

/** Wrong guesses allowed before the code rotates. */
const MAX_ATTEMPTS = 5;

const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

let code = newCode();
let attempts = 0;
const listeners: ((code: string) => void)[] = [];

/** The code a browser on another machine enters to enroll. */
export function currentPairingCode(): string {
  return code;
}

/** Be told whenever the code changes (e.g. to print it). */
export function onPairingCode(cb: (code: string) => void): void {
  listeners.push(cb);
}

function rotate(): void {
  code = newCode();
  attempts = 0;
  for (const cb of listeners) cb(code);
}

/** Check a submitted code. A correct code is used up; too many wrong ones
 *  rotate it, so it can't be brute-forced. */
export function consumePairingCode(submitted: unknown): boolean {
  const a = Buffer.from(typeof submitted === 'string' ? submitted : '');
  const b = Buffer.from(code);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) rotate();
  else if (++attempts >= MAX_ATTEMPTS) rotate();
  return ok;
}
