/**
 * Minimal Ed25519 verification + peer-id fingerprinting for the rendezvous.
 * Mirrors packages/backend/src/multiplayer/identity.ts (kept inline so the
 * rendezvous stays a zero-dependency standalone service).
 */
import { createPublicKey, verify as edVerify, createHash } from 'crypto';

/** sha256 fingerprint (url-safe base64) of a base64 SPKI public key = peer id. */
export function fingerprint(publicKeyB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('base64url');
}

/** Verify a base64 signature against a base64 SPKI Ed25519 public key. */
export function verifyBytes(
  publicKeyB64: string,
  data: string,
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
