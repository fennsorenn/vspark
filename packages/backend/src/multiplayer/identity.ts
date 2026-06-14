/**
 * This server's stable cryptographic identity for cross-server multiplayer.
 *
 * An Ed25519 keypair generated once and persisted in `server_identity`. The
 * public key's fingerprint is the **peer id** — the stable handle other servers
 * store (= the sync envelope `origin` / HLC `n`), unchanged across IP changes.
 * The private key never leaves this server; it signs presence nonces and the
 * mutual auth challenge so a compromised rendezvous can't impersonate anyone.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign as edSign,
  verify as edVerify,
  createHash,
  type KeyObject,
} from 'crypto';
import { getDb } from '../db/index.js';

export interface ServerIdentity {
  /** Public-key fingerprint — the stable peer id. */
  peerId: string;
  /** base64 SPKI-DER Ed25519 public key (shareable). */
  publicKey: string;
}

interface IdentityRow {
  peer_id: string;
  public_key: string;
  private_key: string;
}

/** Fingerprint a base64 SPKI public key → url-safe sha256, the peer id. */
export function fingerprint(publicKeyB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('base64url');
}

let _privateKey: KeyObject | null = null;
let _identity: ServerIdentity | null = null;

/** Load the persisted identity, generating + storing one on first run. */
export function initIdentity(): ServerIdentity {
  if (_identity) return _identity;
  const db = getDb();
  const row = db
    .prepare(
      'SELECT peer_id, public_key, private_key FROM server_identity WHERE id = 1'
    )
    .get() as unknown as IdentityRow | undefined;

  if (row) {
    _privateKey = createPrivateKey({
      key: Buffer.from(row.private_key, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    _identity = { peerId: row.peer_id, publicKey: row.public_key };
    return _identity;
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const privB64 = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  const peerId = fingerprint(pubB64);
  db.prepare(
    'INSERT INTO server_identity (id, peer_id, public_key, private_key) VALUES (1, ?, ?, ?)'
  ).run(peerId, pubB64, privB64);
  _privateKey = privateKey;
  _identity = { peerId, publicKey: pubB64 };
  return _identity;
}

export function getIdentity(): ServerIdentity {
  if (!_identity) return initIdentity();
  return _identity;
}

/** Sign arbitrary bytes with this server's private key → base64 signature. */
export function signBytes(data: string | Buffer): string {
  if (!_privateKey) initIdentity();
  return edSign(null, Buffer.from(data), _privateKey!).toString('base64');
}

/** Verify a base64 signature against a peer's base64 SPKI public key. */
export function verifyBytes(
  publicKeyB64: string,
  data: string | Buffer,
  signatureB64: string
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return edVerify(
      null,
      Buffer.from(data),
      key,
      Buffer.from(signatureB64, 'base64')
    );
  } catch {
    return false;
  }
}
