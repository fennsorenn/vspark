/**
 * Multiplayer identity — pure function coverage.
 *
 * `fingerprint` is a pure crypto helper that doesn't touch the DB.
 * `signBytes`/`verifyBytes` are also pure but `signBytes` lazily calls
 * `initIdentity` which writes to the DB, so both sets of tests use a
 * makeTestApp()-equivalent in-memory DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createHash } from 'crypto';

// ---------------------------------------------------------------------------
// fingerprint — pure sha256url over the SPKI public-key DER blob.
// ---------------------------------------------------------------------------

describe('fingerprint', () => {
  it('round-trips: fingerprinting the same key twice yields the same id', async () => {
    const { fingerprint } = await import('../src/multiplayer/identity.js');
    const { publicKey } = generateKeyPairSync('ed25519');
    const b64 = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    expect(fingerprint(b64)).toBe(fingerprint(b64));
  });

  it('produces a url-safe base64url string (no + / = chars)', async () => {
    const { fingerprint } = await import('../src/multiplayer/identity.js');
    const { publicKey } = generateKeyPairSync('ed25519');
    const b64 = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    const fp = fingerprint(b64);
    expect(fp).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('matches manual sha256url calculation', async () => {
    const { fingerprint } = await import('../src/multiplayer/identity.js');
    const { publicKey } = generateKeyPairSync('ed25519');
    const buf = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const b64 = buf.toString('base64');
    const expected = createHash('sha256').update(buf).digest('base64url');
    expect(fingerprint(b64)).toBe(expected);
  });

  it('different keys produce different fingerprints', async () => {
    const { fingerprint } = await import('../src/multiplayer/identity.js');
    const { publicKey: k1 } = generateKeyPairSync('ed25519');
    const { publicKey: k2 } = generateKeyPairSync('ed25519');
    const fp1 = fingerprint(
      k1.export({ type: 'spki', format: 'der' }).toString('base64')
    );
    const fp2 = fingerprint(
      k2.export({ type: 'spki', format: 'der' }).toString('base64')
    );
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// verifyBytes — pure path: inject a known keypair, no DB needed.
// ---------------------------------------------------------------------------

describe('verifyBytes (pure path with injected key)', () => {
  it('accepts a valid Ed25519 signature over the matching public key', async () => {
    const { verifyBytes } = await import('../src/multiplayer/identity.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    // Sign directly using Node crypto (bypassing the module's private key
    // cache so no DB is needed here).
    const { sign: edSign } = await import('crypto');
    const sig = edSign(null, Buffer.from('test payload'), privateKey).toString(
      'base64'
    );

    expect(verifyBytes(pubB64, 'test payload', sig)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const { verifyBytes } = await import('../src/multiplayer/identity.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    const { sign: edSign } = await import('crypto');
    const sig = edSign(null, Buffer.from('original'), privateKey).toString(
      'base64'
    );

    expect(verifyBytes(pubB64, 'tampered', sig)).toBe(false);
  });

  it('rejects a corrupted signature', async () => {
    const { verifyBytes } = await import('../src/multiplayer/identity.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    const { sign: edSign } = await import('crypto');
    const sig = edSign(null, Buffer.from('data'), privateKey).toString('base64');
    const raw = Buffer.from(sig, 'base64');
    raw[0] ^= 0xff;
    const badSig = raw.toString('base64');

    expect(verifyBytes(pubB64, 'data', badSig)).toBe(false);
  });

  it('returns false (does not throw) for a garbage public key', async () => {
    const { verifyBytes } = await import('../src/multiplayer/identity.js');
    expect(verifyBytes('bm90YWtleQ==', 'data', 'bm90YXNpZw==')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initIdentity / getIdentity / signBytes (DB-required path).
// ---------------------------------------------------------------------------

describe('initIdentity + signBytes (in-memory DB)', () => {
  beforeEach(async () => {
    process.env.VSPARK_DB_PATH = ':memory:';
    const { closeDb } = await import('../src/db/index.js');
    closeDb();
    const { runMigrations } = await import('../src/db/index.js');
    await runMigrations();
  });

  it('generates a peerId that is the fingerprint of publicKey', async () => {
    const { initIdentity, fingerprint } = await import(
      '../src/multiplayer/identity.js'
    );
    const id = initIdentity();
    expect(id.peerId).toBe(fingerprint(id.publicKey));
  });

  it('getIdentity returns the same values as initIdentity', async () => {
    const { initIdentity, getIdentity } = await import(
      '../src/multiplayer/identity.js'
    );
    const id1 = initIdentity();
    const id2 = getIdentity();
    expect(id1.peerId).toBe(id2.peerId);
    expect(id1.publicKey).toBe(id2.publicKey);
  });

  it('signBytes + verifyBytes form a valid round-trip', async () => {
    const { initIdentity, signBytes, verifyBytes } = await import(
      '../src/multiplayer/identity.js'
    );
    const identity = initIdentity();
    const message = 'nonce:12345';
    const sig = signBytes(message);
    expect(verifyBytes(identity.publicKey, message, sig)).toBe(true);
  });

  it('signBytes over different data verifies as false with wrong payload', async () => {
    const { initIdentity, signBytes, verifyBytes } = await import(
      '../src/multiplayer/identity.js'
    );
    const identity = initIdentity();
    const sig = signBytes('correct');
    expect(verifyBytes(identity.publicKey, 'wrong', sig)).toBe(false);
  });
});
