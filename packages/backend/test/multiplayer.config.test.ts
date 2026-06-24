/**
 * Multiplayer config — resolveRendezvousUrl pure logic.
 *
 * Three branches:
 *   - env var unset → public default
 *   - env var set to a URL → that URL
 *   - env var set to '' (empty) → disable / ''
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const DEFAULT = 'wss://vspark-rdv.fennsorenn.com';

describe('resolveRendezvousUrl', () => {
  const saved = process.env.MULTIPLAYER_RENDEZVOUS_URL;

  afterEach(() => {
    // Restore whatever was there before each test.
    if (saved === undefined) {
      delete process.env.MULTIPLAYER_RENDEZVOUS_URL;
    } else {
      process.env.MULTIPLAYER_RENDEZVOUS_URL = saved;
    }
  });

  it('returns the public default when the env var is not set', async () => {
    delete process.env.MULTIPLAYER_RENDEZVOUS_URL;
    const { resolveRendezvousUrl } = await import(
      '../src/multiplayer/config.js'
    );
    expect(resolveRendezvousUrl()).toBe(DEFAULT);
  });

  it('returns the override URL when the env var is a non-empty string', async () => {
    process.env.MULTIPLAYER_RENDEZVOUS_URL = 'wss://my-rdv.example.com';
    const { resolveRendezvousUrl } = await import(
      '../src/multiplayer/config.js'
    );
    expect(resolveRendezvousUrl()).toBe('wss://my-rdv.example.com');
  });

  it('returns an empty string when the env var is explicitly set to empty (disabled)', async () => {
    process.env.MULTIPLAYER_RENDEZVOUS_URL = '';
    const { resolveRendezvousUrl } = await import(
      '../src/multiplayer/config.js'
    );
    expect(resolveRendezvousUrl()).toBe('');
  });

  it('DEFAULT_RENDEZVOUS_URL is the expected wss endpoint', async () => {
    const { DEFAULT_RENDEZVOUS_URL } = await import(
      '../src/multiplayer/config.js'
    );
    expect(DEFAULT_RENDEZVOUS_URL).toBe(DEFAULT);
  });
});
