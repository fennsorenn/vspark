/**
 * Browser enrollment for the mesh (principle 9). A browser on this machine
 * gets a token directly; any other browser needs the device code. The Vite
 * dev proxy makes every request look local, so the browser's own address is
 * read from X-Forwarded-For — trusted only from a loopback connection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { unknownTrustedNetworkEntries } from '../src/localAccess.js';
import {
  currentPairingCode,
  revokeClient,
  verifyClientToken,
} from '../src/auth/clients.js';

const REMOTE = { 'X-Forwarded-For': '192.168.1.50' };
/** What a remote browser sending a forged header looks like behind the proxy. */
const FORGED = { 'X-Forwarded-For': '127.0.0.1, 192.168.1.50' };

describe('mesh enrollment', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  it('issues a token to a browser on this machine', async () => {
    const res = await request(app)
      .post('/api/mesh/enroll')
      .send({ label: 'test' });
    expect(res.status).toBe(200);
    const { token, clientId } = res.body.data;
    expect(verifyClientToken(token)).toBe(clientId);
  });

  it('is not fooled by a forged loopback entry in front of the proxy one', async () => {
    const res = await request(app)
      .post('/api/mesh/enroll')
      .set(FORGED)
      .send({});
    expect(res.status).toBe(403);
  });

  it('asks a browser on another machine for the device code', async () => {
    const res = await request(app)
      .post('/api/mesh/enroll')
      .set(REMOTE)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PAIRING_REQUIRED');
  });

  it('accepts the device code once, then a new one is needed', async () => {
    const code = currentPairingCode();
    const ok = await request(app)
      .post('/api/mesh/enroll')
      .set(REMOTE)
      .send({ code });
    expect(ok.status).toBe(200);
    expect(verifyClientToken(ok.body.data.token)).toBeTruthy();
    const again = await request(app)
      .post('/api/mesh/enroll')
      .set(REMOTE)
      .send({ code });
    expect(again.status).toBe(403);
    expect(currentPairingCode()).not.toBe(code);
  });

  it('rotates the code after repeated wrong guesses', async () => {
    const code = currentPairingCode();
    for (let i = 0; i < 5; i++)
      await request(app)
        .post('/api/mesh/enroll')
        .set(REMOTE)
        .send({ code: 'nope' + i });
    expect(currentPairingCode()).not.toBe(code);
    const late = await request(app)
      .post('/api/mesh/enroll')
      .set(REMOTE)
      .send({ code });
    expect(late.status).toBe(403);
  });

  it('reads the browser address from the proxy header only on loopback connections', async () => {
    // A remote caller can't claim to be local by sending the header itself:
    // it is only read when the connection comes from loopback (the proxy).
    const { browserAddress } = await import('../src/localAccess.js');
    const req = (socket: string, fwd?: string) =>
      ({
        socket: { remoteAddress: socket },
        headers: fwd ? { 'x-forwarded-for': fwd } : {},
      }) as never;
    expect(browserAddress(req('127.0.0.1', '10.0.0.9'))).toBe('10.0.0.9');
    expect(browserAddress(req('10.0.0.9', '127.0.0.1'))).toBe('10.0.0.9');
    // Through the proxy, a forged entry comes first; the proxy's own is last.
    expect(browserAddress(req('127.0.0.1', '127.0.0.1, 10.0.0.9'))).toBe(
      '10.0.0.9'
    );
    expect(browserAddress(req('::1'))).toBe('::1');
  });

  it('shows the device code only to local callers', async () => {
    const local = await request(app).get('/api/mesh/pairing-code');
    expect(local.body.data.code).toBe(currentPairingCode());
    const remote = await request(app).get('/api/mesh/pairing-code').set(REMOTE);
    expect(remote.status).toBe(403);
  });

  it('a revoked browser is no longer accepted', async () => {
    const res = await request(app).post('/api/mesh/enroll').send({});
    const { token, clientId } = res.body.data;
    revokeClient(clientId);
    expect(verifyClientToken(token)).toBeNull();
  });
});

describe('VSPARK_ALLOW_LAN: trusted networks join without the device code', () => {
  let app: Express;
  const prev = process.env.VSPARK_ALLOW_LAN;
  const from = (ip: string) => ({ 'X-Forwarded-For': ip });
  const enroll = (ip: string) =>
    request(app).post('/api/mesh/enroll').set(from(ip)).send({});

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.VSPARK_ALLOW_LAN;
    else process.env.VSPARK_ALLOW_LAN = prev;
  });

  it('trusts nothing but this machine when unset or 0', async () => {
    delete process.env.VSPARK_ALLOW_LAN;
    expect((await enroll('192.168.1.50')).status).toBe(403);
    process.env.VSPARK_ALLOW_LAN = '0';
    expect((await enroll('192.168.1.50')).status).toBe(403);
  });

  it('1 trusts the local network only', async () => {
    process.env.VSPARK_ALLOW_LAN = '1';
    for (const ip of [
      '192.168.1.50',
      '10.1.2.3',
      '172.20.0.5',
      '169.254.9.9',
      'fd12::1',
      'fe80::1',
      '::ffff:192.168.0.7',
    ])
      expect((await enroll(ip)).status, ip).toBe(200);
    for (const ip of ['100.99.206.51', '8.8.8.8', '172.32.0.1', '2a02:908::1'])
      expect((await enroll(ip)).body.error?.code, ip).toBe('PAIRING_REQUIRED');
  });

  it('a list adds tailscale, ranges and single addresses', async () => {
    process.env.VSPARK_ALLOW_LAN = 'tailscale, 203.0.113.0/24, 198.51.100.7';
    for (const ip of [
      '100.99.206.51',
      'fd7a:115c:a1e0::ed36:ce33',
      '203.0.113.200',
      '198.51.100.7',
    ])
      expect((await enroll(ip)).status, ip).toBe(200);
    // lan isn't listed, so the local network now needs the code
    for (const ip of ['192.168.1.50', '198.51.100.8'])
      expect((await enroll(ip)).status, ip).toBe(403);
  });

  it('any trusts every address; unknown entries are ignored', async () => {
    process.env.VSPARK_ALLOW_LAN = 'any';
    expect((await enroll('8.8.8.8')).status).toBe(200);
    process.env.VSPARK_ALLOW_LAN = 'lan,bogus,10.0.0.0/99';
    expect(unknownTrustedNetworkEntries()).toEqual(['bogus', '10.0.0.0/99']);
    expect((await enroll('192.168.1.50')).status).toBe(200);
  });

  it('still shows the device code only to this machine', async () => {
    process.env.VSPARK_ALLOW_LAN = '1';
    const res = await request(app)
      .get('/api/mesh/pairing-code')
      .set(from('192.168.1.50'));
    expect(res.status).toBe(403);
  });
});
