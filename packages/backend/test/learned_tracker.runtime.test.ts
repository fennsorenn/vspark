/**
 * learned_tracker.runtime.test.ts
 *
 * LearnedRuntime (behaviors/learned_tracker/runtime.ts) against a fake runtime: a small Node
 * script speaking the same JSON-lines protocol as motiontracker's `mtservice --stdio`. It
 * reports `ready` and a `status`, echoes every command it receives back as an `error` event
 * (so the test can see what was sent), crashes on `{"cmd":"crash"}` and exits when stdin
 * closes, like the real runtime.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LearnedRuntime,
  learnedRuntimeDir,
  type CommandBuilder,
  type RuntimeOptions,
  type RuntimeStatus,
} from '../src/behaviors/learned_tracker/runtime.js';

const FAKE = `
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ event: 'ready', model: { run: 'fake-v1' }, bones: [] });
out({ event: 'status', fps: 10, detect_ms: 20, model_ms: 1.5, latency_ms: 40, present: 1 });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.cmd === 'crash') { process.stderr.write('[mtservice] error: boom\\n'); process.exit(3); }
    if (cmd.cmd === 'stop') continue;
    out({ event: 'error', message: 'got ' + JSON.stringify(cmd) });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const dir = mkdtempSync(join(tmpdir(), 'learned-runtime-'));
mkdirSync(join(dir, 'service'), { recursive: true });
writeFileSync(join(dir, 'service', 'pyproject.toml'), '');
const script = join(dir, 'fake.cjs');
writeFileSync(script, FAKE);

const fakeCommand: CommandBuilder = (o) => ({
  cmd: process.execPath,
  args: [script, String(o.camera), String(o.port)],
});

const opts = (patch: Partial<RuntimeOptions> = {}): RuntimeOptions => ({
  runtimeDir: dir,
  camera: 0,
  port: 39999,
  vrmPath: null,
  ...patch,
});

async function until(
  statuses: RuntimeStatus[],
  pred: (s: RuntimeStatus) => boolean,
  ms = 5000
): Promise<RuntimeStatus> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = statuses.find(pred);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `no matching status; got ${JSON.stringify(statuses.map((s) => s.state))}`
  );
}

describe('LearnedRuntime', () => {
  const runtimes: LearnedRuntime[] = [];
  const make = (statuses: RuntimeStatus[], cmd = fakeCommand) => {
    const rt = new LearnedRuntime('test', (s) => statuses.push(s), cmd);
    runtimes.push(rt);
    return rt;
  };
  afterEach(() => {
    for (const rt of runtimes.splice(0)) rt.stop();
  });

  it('starts, reports ready and status', async () => {
    const statuses: RuntimeStatus[] = [];
    make(statuses).apply(opts());
    expect(statuses[0].state).toBe('starting');
    await until(statuses, (s) => s.model === 'fake-v1');
    const st = await until(statuses, (s) => s.fps === 10);
    expect(st).toMatchObject({ state: 'running', latencyMs: 40, modelMs: 1.5 });
  });

  it('sends camera and avatar changes over stdin without restarting', async () => {
    const statuses: RuntimeStatus[] = [];
    const rt = make(statuses);
    rt.apply(opts());
    await until(statuses, (s) => s.state === 'running');
    rt.apply(opts({ camera: 2, vrmPath: '/x/avatar.vrm' }));
    await until(statuses, (s) => !!s.message?.includes('"cmd":"camera","index":2'));
    await until(statuses, (s) => !!s.message?.includes('"vrm_path":"/x/avatar.vrm"'));
    expect(statuses.filter((s) => s.state === 'starting')).toHaveLength(1);
  });

  it('restarts on a port change', async () => {
    const statuses: RuntimeStatus[] = [];
    const rt = make(statuses);
    rt.apply(opts());
    await until(statuses, (s) => s.state === 'running');
    rt.apply(opts({ port: 40000 }));
    await until(
      statuses,
      (s) => s.state === 'starting' && statuses.indexOf(s) > 0
    );
  });

  it('reports a crash with the runtime log line and schedules a restart', async () => {
    const statuses: RuntimeStatus[] = [];
    const rt = make(statuses);
    rt.apply(opts());
    await until(statuses, (s) => s.state === 'running');
    (rt as unknown as { send: (c: object) => void }).send({ cmd: 'crash' });
    const err = await until(statuses, (s) => s.state === 'error');
    expect(err.message).toContain('code 3');
    expect(err.message).toContain('boom');
    expect(err.message).toContain('retrying');
  });

  it('stops when told to', async () => {
    const statuses: RuntimeStatus[] = [];
    const rt = make(statuses);
    rt.apply(opts());
    await until(statuses, (s) => s.state === 'running');
    rt.stop();
    expect(rt.current.state).toBe('stopped');
  });

  it('reports a missing checkout instead of spawning', () => {
    const statuses: RuntimeStatus[] = [];
    make(statuses).apply(opts({ runtimeDir: join(dir, 'nope') }));
    expect(statuses).toHaveLength(1);
    expect(statuses[0].state).toBe('error');
    expect(statuses[0].message).toContain('not found');
  });

  it('reports a missing executable', async () => {
    const statuses: RuntimeStatus[] = [];
    make(statuses, () => ({ cmd: 'definitely-not-a-command-xyz', args: [] })).apply(opts());
    const err = await until(statuses, (s) => s.state === 'error');
    expect(err.message).toContain('not found');
  });

  it('takes the checkout from VSPARK_MOTIONTRACKER_PATH', () => {
    const prev = process.env.VSPARK_MOTIONTRACKER_PATH;
    process.env.VSPARK_MOTIONTRACKER_PATH = dir;
    try {
      expect(learnedRuntimeDir()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.VSPARK_MOTIONTRACKER_PATH;
      else process.env.VSPARK_MOTIONTRACKER_PATH = prev;
    }
  });
});
