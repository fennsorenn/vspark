/**
 * "This machine" (`self`): connections from the server's own interface
 * addresses — e.g. a browser opening the Docker-bridge link the dev server
 * prints — count as local by default. `VSPARK_ALLOW_LAN` decides who may
 * connect, `VSPARK_TRUSTED_NETWORKS` (default: the same) who skips the code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

// This machine has a Docker bridge and a LAN address.
const OWN = ['172.19.0.1', '192.168.0.246'];
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const iface = (address: string) => ({
    address,
    netmask: '255.255.0.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/16`,
  });
  const networkInterfaces = () => ({
    lo: [{ ...iface('127.0.0.1'), internal: true }],
    br0: [iface('172.19.0.1')],
    eth0: [iface('192.168.0.246')],
  });
  return {
    ...actual,
    networkInterfaces,
    default: { ...actual, networkInterfaces },
  };
});

const { remoteAllowed, trustedNetworkAddress, unknownNetworkEntries } =
  await import('../src/localAccess.js');

const KEYS = ['VSPARK_ALLOW_LAN', 'VSPARK_TRUSTED_NETWORKS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let app: Express;
const enroll = (ip: string) =>
  request(app).post('/api/mesh/enroll').set('X-Forwarded-For', ip).send({});

beforeEach(async () => {
  for (const k of KEYS) delete process.env[k];
  ({ app } = await makeTestApp());
});
afterEach(() => {
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

describe('self — this machine’s own addresses', () => {
  it('by default may connect and joins without a code; other machines may not', async () => {
    for (const ip of [...OWN, '::ffff:172.19.0.1']) {
      expect(remoteAllowed(ip), ip).toBe(true);
      expect((await enroll(ip)).status, ip).toBe(200);
    }
    expect(remoteAllowed('192.168.0.50')).toBe(false);
    expect((await enroll('192.168.0.50')).body.error?.code).toBe(
      'PAIRING_REQUIRED'
    );
  });

  it('sees the device code like localhost', async () => {
    const res = await request(app)
      .get('/api/mesh/pairing-code')
      .set('X-Forwarded-For', '172.19.0.1');
    expect(res.status).toBe(200);
  });

  it('0 turns it off: loopback only', async () => {
    process.env.VSPARK_ALLOW_LAN = '0';
    expect(remoteAllowed('172.19.0.1')).toBe(false);
    expect(remoteAllowed('127.0.0.1')).toBe(true);
    expect((await enroll('172.19.0.1')).status).toBe(403);
  });

  it('a list without self leaves it out (lan still covers private addresses)', () => {
    process.env.VSPARK_ALLOW_LAN = 'tailscale';
    expect(remoteAllowed('172.19.0.1')).toBe(false);
    process.env.VSPARK_ALLOW_LAN = 'self,tailscale';
    expect(remoteAllowed('172.19.0.1')).toBe(true);
    expect(remoteAllowed('100.99.206.51')).toBe(true);
  });
});

describe('VSPARK_TRUSTED_NETWORKS', () => {
  it('defaults to VSPARK_ALLOW_LAN', () => {
    process.env.VSPARK_ALLOW_LAN = 'self,lan';
    expect(trustedNetworkAddress('192.168.0.50')).toBe(true);
  });

  it('separates who may connect from who skips the code', async () => {
    process.env.VSPARK_ALLOW_LAN = 'self,lan';
    process.env.VSPARK_TRUSTED_NETWORKS = 'self';
    expect(remoteAllowed('192.168.0.50')).toBe(true);
    expect((await enroll('192.168.0.50')).body.error?.code).toBe(
      'PAIRING_REQUIRED'
    );
    expect((await enroll('172.19.0.1')).status).toBe(200);
  });

  it('0 makes everyone but localhost enter the code', async () => {
    process.env.VSPARK_TRUSTED_NETWORKS = '0';
    expect(remoteAllowed('172.19.0.1')).toBe(true);
    expect((await enroll('172.19.0.1')).status).toBe(403);
  });

  it('reports its unknown entries apart', () => {
    process.env.VSPARK_TRUSTED_NETWORKS = 'self,nope';
    expect(unknownNetworkEntries()).toEqual([
      { setting: 'VSPARK_TRUSTED_NETWORKS', entry: 'nope' },
    ]);
  });
});
