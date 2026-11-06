import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getDb } from '../src/db/index.js';
import { logicManager } from '../src/logic/manager.js';
import { initOverliveManager } from '../src/overlive/manager.js';
import { triggerRouter } from '../src/triggers/router.js';
import { readVariable } from '../src/variables/store.js';
import {
  ACTION_KINDS,
  RESPONSE_TYPE_IDS,
  actionGraphId,
} from '@vspark/shared/actions';

/**
 * The Phase-3 Action kinds (chat command / pattern / keyword, keyword combo,
 * redemption) run end to end: created over REST, their generated graphs
 * started by LogicManager, and overlive events delivered the way production
 * delivers them — through OverliveManager's routing (account resolved from the
 * action's `account` setting, wired into the trigger node). Replies, redemption
 * status calls and triggers are observed on the manager / router.
 */
type Json = Record<string, any>;

const ACC = 'acc-1';
const ACC2 = 'acc-2';

const ol = initOverliveManager();
// routeEvent is the manager's private entry point for adapter events.
const route = (projectId: string, ev: Json) =>
  (ol as unknown as { routeEvent: (p: string, e: Json) => void }).routeEvent(
    projectId,
    ev
  );

const base = (type: string, source = ACC) => ({
  type,
  id: 'evt',
  platform: 'twitch',
  sourceInstanceId: source,
  channel: 'chan',
  timestamp: new Date(),
  raw: null,
});

const commandEvent = (
  command: string,
  args: string[] = [],
  over: Json = {},
  source = ACC
) => ({
  ...base('chat.command', source),
  data: {
    messageId: 'm1',
    username: 'alice',
    displayName: 'Alice',
    command,
    prefix: '!',
    args,
    text: `!${command} ${args.join(' ')}`.trim(),
    badges: [],
    isMod: false,
    isSub: false,
    isBroadcaster: false,
    ...over,
  },
});

const chatEvent = (text: string, username = 'alice', over: Json = {}) => ({
  ...base('chat.message'),
  data: {
    messageId: 'm1',
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    text,
    tokens: [],
    badges: [],
    isMod: false,
    isSub: false,
    isBroadcaster: false,
    isAction: false,
    isHighlighted: false,
    ...over,
  },
});

const redemptionEvent = (rewardTitle: string, message = 'hello there') => ({
  ...base('redemption'),
  id: 'red-1',
  data: {
    username: 'bob',
    displayName: 'Bob',
    currency: {
      kind: 'channel_points',
      amount: 100,
      rewardTitle,
      rewardId: 'rw-1',
      requiresApproval: true,
    },
    message,
  },
});

let app: Express;
let projectId: string;
let sent: ReturnType<typeof vi.spyOn>;
let status: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

const create = async (kind: string, settings: Json, id = kind) => {
  const res = await request(app)
    .post(`/api/projects/${projectId}/actions`)
    .send({ id, kind, settings });
  expect(res.status).toBe(201);
  return res.body.data as Json;
};
const replies = () => sent.mock.calls.map((c: unknown[]) => c[2]);
const nodeIn = (actionId: string, nodeId: string, port: string) =>
  logicManager.getStates(actionGraphId(actionId))?.nodes[nodeId]?.portValues[
    `in:${port}`
  ];

beforeEach(async () => {
  ({ app } = await makeTestApp({ mesh: true }));
  projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
    .body.data.id as string;
  const ins = (id: string, label: string, isDefault: number) =>
    getDb()
      .prepare(
        `INSERT INTO overlive_accounts (id, project_id, platform, label, is_default)
         VALUES (?, ?, 'twitch', ?, ?)`
      )
      .run(id, projectId, label, isDefault);
  ins(ACC, 'Main', 1);
  ins(ACC2, 'Bot', 0);
  sent = vi.spyOn(ol, 'sendChat').mockResolvedValue(undefined);
  status = vi.spyOn(ol, 'updateRedemptionStatus').mockResolvedValue(undefined);
  warn = vi.spyOn(console, 'warn');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logicManager.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('every kind', () => {
  it('every template starts with no dropped edge, for every response type', async () => {
    let n = 0;
    for (const def of ACTION_KINDS) {
      const types = def.fields.some((f) => f.path === 'response.type')
        ? RESPONSE_TYPE_IDS
        : [undefined];
      for (const type of types) {
        const a = await create(
          def.kind,
          type ? { response: { type } } : {},
          `${def.kind}-${n++}`
        );
        expect(a.modified).toBe(false);
        expect(logicManager.getRunningDescriptors().map((r) => r.id)).toContain(
          a.graphId
        );
      }
    }
    const dropped = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('dropped edge')
    );
    expect(dropped).toEqual([]);
  });
});

describe('Chat command', () => {
  it('chat command: aliases, reply fields, counter, rank and args pattern', async () => {
    await create('chat_command', {
      command: '!hug',
      aliases: 'cuddle, Snuggle',
      cooldown: { seconds: 0 },
      reply: '${user} hugs ${args} (${count})',
      counter: { enabled: true, name: 'hugs' },
    });
    route(projectId, commandEvent('hug', ['Bob']));
    route(projectId, commandEvent('SNUGGLE', ['Carol']));
    route(projectId, commandEvent('other', ['x']));
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[0]).toEqual([ACC, undefined, 'Alice hugs Bob (1)']);
    expect(replies()[1]).toBe('Alice hugs Carol (2)');
    // A named counter is shared (scope '') and persistent by default.
    expect(readVariable({ projectId, scope: '', name: 'hugs' })).toBe(2);
    expect(
      getDb()
        .prepare(
          'SELECT value FROM variables WHERE project_id = ? AND name = ?'
        )
        .get(projectId, 'hugs')
    ).toBeTruthy();

    // Rank and args pattern are value settings: no rebuild, applied live.
    const before = (await request(app).get('/api/actions/chat_command')).body
      .data;
    await request(app)
      .put('/api/actions/chat_command')
      .send({
        settings: {
          minRank: 'mod',
          argsPattern: '^@?(?<target>\\w+)$',
          reply: 'hug → ${target}',
        },
      });
    const after = (await request(app).get('/api/actions/chat_command')).body
      .data;
    expect(after.templateFingerprint).toBe(before.templateFingerprint);
    expect(after.modified).toBe(false);
    sent.mockClear();
    route(projectId, commandEvent('hug', ['@Dave']));
    expect(sent).not.toHaveBeenCalled(); // not a mod
    route(projectId, commandEvent('hug', ['@Dave'], { isMod: true }));
    route(
      projectId,
      commandEvent('hug', ['two', 'words'], { isBroadcaster: true })
    );
    expect(replies()).toEqual(['hug → Dave']); // args pattern rejected the 2nd
  });

  it('chat command: an unnamed counter is graph-local; a disabled one does not count', async () => {
    await create('chat_command', {
      command: 'lurk',
      cooldown: { seconds: 0 },
      reply: 'lurk #${count}',
      counter: { enabled: true },
    });
    route(projectId, commandEvent('lurk'));
    route(projectId, commandEvent('lurk'));
    expect(replies()).toEqual(['lurk #1', 'lurk #2']);
    const scope = actionGraphId('chat_command');
    expect(readVariable({ projectId, scope, name: 'count' })).toBe(2);
    expect(
      readVariable({ projectId, scope: '', name: 'count' })
    ).toBeUndefined();

    await request(app)
      .put('/api/actions/chat_command')
      .send({ settings: { counter: { enabled: false } } });
    route(projectId, commandEvent('lurk'));
    expect(replies()[2]).toBe('lurk #2');
  });

  it('chat command: a cooldown group is shared across two commands', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await create(
      'chat_command',
      { command: 'a', reply: 'A', cooldown: { seconds: 30, group: 'fun' } },
      'ca'
    );
    await create(
      'chat_command',
      { command: 'b', reply: 'B', cooldown: { seconds: 30, group: 'fun' } },
      'cb'
    );
    await create(
      'chat_command',
      { command: 'c', reply: 'C', cooldown: { seconds: 30 } },
      'cc'
    );
    route(projectId, commandEvent('a'));
    route(projectId, commandEvent('b')); // same group: blocked
    route(projectId, commandEvent('c')); // private cooldown: passes
    route(projectId, commandEvent('c')); // its own cooldown: blocked
    expect(replies()).toEqual(['A', 'C']);
    now += 31_000;
    route(projectId, commandEvent('b'));
    route(projectId, commandEvent('a')); // b just started the shared cooldown
    expect(replies()).toEqual(['A', 'C', 'B']);
  });

  it('routes by the account setting; empty = the project default account', async () => {
    await create(
      'chat_command',
      { command: 'hi', reply: 'hi', cooldown: { seconds: 0 }, account: ACC2 },
      'bot'
    );
    route(projectId, commandEvent('hi')); // from ACC: not this action's account
    expect(sent).not.toHaveBeenCalled();
    route(projectId, commandEvent('hi', [], {}, ACC2));
    expect(sent.mock.calls[0][0]).toBe(ACC2);
    // Value edit → live: switching to the default account.
    await request(app)
      .put('/api/actions/bot')
      .send({ settings: { account: '' } });
    route(projectId, commandEvent('hi'));
    expect(sent.mock.calls[1][0]).toBe(ACC);
  });
});

describe('Chat pattern', () => {
  it('chat pattern: the whole message must match; named groups fill the reply', async () => {
    await create('chat_pattern', {
      pattern: '"(?<quote>.+)" - (?<character>[^.]+)\\. (?<year>\\d{4})',
      cooldown: { seconds: 0 },
      reply: '${user} quoted ${character} (${year}): ${quote}',
      counter: { enabled: true, name: 'quotes', persistent: false },
    });
    route(projectId, chatEvent('"I am inevitable" - Thanos. 2019'));
    route(projectId, chatEvent('so "I am inevitable" - Thanos. 2019 lol'));
    expect(replies()).toEqual(['Alice quoted Thanos (2019): I am inevitable']);
    expect(readVariable({ projectId, scope: '', name: 'quotes' })).toBe(1);
    // Not persistent: no SQLite row.
    expect(
      getDb().prepare('SELECT 1 FROM variables WHERE name = ?').get('quotes')
    ).toBeUndefined();
  });
});
