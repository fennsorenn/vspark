/**
 * Short-lived TURN credentials via coturn's `use-auth-secret` (TURN REST API):
 * username = `<unix-expiry>:<peerId>`, credential = base64(HMAC-SHA1(secret, username)).
 * Sharing the secret between the rendezvous and coturn means coturn never needs a
 * user DB and can't be used as an open relay (creds expire). See the deploy bundle.
 */
import { createHmac } from 'crypto';

export interface TurnCreds {
  username: string;
  credential: string;
  ttlSec: number;
}

export function mintTurnCreds(
  secret: string,
  peerId: string,
  ttlSec = 600
): TurnCreds {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${peerId}`;
  const credential = createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, credential, ttlSec };
}
