/**
 * Multiplayer rendezvous URL resolution.
 *
 * vspark ships with a **public default rendezvous** so multiplayer works out of
 * the box, but the default is deliberately kept reversible: what's compiled in
 * is a DNS name we control, not a fixed server. To retire or move the public
 * default later, repoint `vspark-rdv.fennsorenn.com` in DNS (no client update
 * needed) or change/empty `DEFAULT_RENDEZVOUS_URL` and ship a release.
 *
 * Resolution (env var wins so operators can override or disable):
 *   - `MULTIPLAYER_RENDEZVOUS_URL` unset  -> the public default (multiplayer on)
 *   - `MULTIPLAYER_RENDEZVOUS_URL=<url>`  -> point at that rendezvous instead
 *   - `MULTIPLAYER_RENDEZVOUS_URL=` (empty) -> disable multiplayer entirely
 *
 * The empty-string opt-out is intentional: turning the default on means every
 * server connects out on startup unless told not to, so there is an explicit
 * off switch. `manager.init` treats an empty/undefined url as "disabled".
 */
export const DEFAULT_RENDEZVOUS_URL = 'wss://vspark-rdv.fennsorenn.com';

/** The rendezvous URL to use, or '' when explicitly disabled. */
export function resolveRendezvousUrl(): string {
  const env = process.env.MULTIPLAYER_RENDEZVOUS_URL;
  // `undefined` (unset) -> default; '' (explicit) -> disabled; else the override.
  return env ?? DEFAULT_RENDEZVOUS_URL;
}
