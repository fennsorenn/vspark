import { describe, it, expect } from 'vitest';
import * as A from '../src/actions';
import {
  ACTION_KINDS,
  RESPONSE_TYPE_IDS,
  SETTINGS_NODE_KIND,
  actionKind,
  buildActionGraph,
  changesShape,
  escapeRegExp,
  normalizeSettings,
  settingClassOf,
  shapeOf,
  templateFingerprint,
  type ActionSettings,
} from '../src/actions';
import type { GraphDescriptor } from '../src/signal';

/**
 * The chat / redemption kinds: settings normalization and the derived values
 * the graphs read, template structure, value-vs-shape stability of the
 * fingerprint, previews. The graphs RUNNING is pinned in
 * backend/test/actions.kinds.test.ts.
 */
const CHAT_KINDS = ACTION_KINDS.map((k) => k.kind).filter(
  (k) => k !== 'hotkey'
);
const hasResponse = (kind: string) =>
  actionKind(kind)!.fields.some((f) => f.path === 'response.type');

const norm = (kind: string, over: Record<string, unknown> = {}) =>
  normalizeSettings(kind, { ...actionKind(kind)!.defaults(), ...over });
const graph = (kind: string, over: Record<string, unknown> = {}) =>
  buildActionGraph(kind, norm(kind, over), 'g', 'L');
const edgeStrs = (g: GraphDescriptor) =>
  g.edges.map((e) => `${e.fromNodeId}.${e.fromPort}>${e.toNodeId}.${e.toPort}`);
const nodeOf = (g: GraphDescriptor, id: string) =>
  g.nodes.find((n) => n.id === id);
const derived = (s: ActionSettings) => s.derived as Record<string, string>;
const preview = (kind: string, over: Record<string, unknown> = {}) =>
  actionKind(kind)!.preview(norm(kind, over));

/** Every value a form can edit, set to something recognizable. */
const ALL_VALUES = {
  command: 'zzcmd',
  aliases: 'zzalias',
  pattern: 'zzpat',
  argsPattern: 'zzargs',
  keywords: 'zzkw',
  reward: 'zzreward',
  reply: 'zzreply',
  endMessage: 'zzend',
  trigger: 'zztrigger',
  account: 'zzacc',
  minRank: 'mod',
  threshold: 9,
  window: 3,
  uniqueChatters: false,
  markComplete: true,
  cooldown: { seconds: 99, group: 'zzgroup' },
  counter: { enabled: true, name: 'zzcounter', step: 3, persistent: false },
  response: { type: 'play_clip', clipId: 'zzclip' },
};

describe('chat / redemption kinds (all)', () => {
  it('escapeRegExp escapes syntax characters only (valid with the u flag)', () => {
    expect(new RegExp(escapeRegExp('a+b (c)?')).test('a+b (c)?')).toBe(true);
    expect(() => new RegExp(escapeRegExp('a-b/c'), 'u')).not.toThrow();
  });

  it('defaults are normalized; normalize is idempotent', () => {
    for (const kind of CHAT_KINDS) {
      const def = actionKind(kind)!;
      expect(def.normalize(def.defaults())).toEqual(def.defaults());
      expect(def.normalize(null)).toMatchObject({ account: '' });
      const once = def.normalize({
        cooldown: { seconds: '7' },
        counter: { step: 'x' },
      });
      expect(def.normalize(once)).toEqual(once);
    }
  });

  it('typical edits are value edits: only a response type changes the shape', () => {
    for (const kind of CHAT_KINDS) {
      const a = norm(kind);
      const b = norm(kind, ALL_VALUES);
      expect(changesShape(kind, a, b), kind).toBe(false);
      expect(settingClassOf(kind, 'reply')).toBe('value');
      if (!hasResponse(kind)) {
        expect(shapeOf(kind, b)).toEqual({});
        continue;
      }
      expect(settingClassOf(kind, 'response.type')).toBe('shape');
      expect(settingClassOf(kind, 'response.clipId')).toBe('value');
      expect(
        changesShape(kind, a, norm(kind, { response: { type: 'spawn_clip' } }))
      ).toBe(true);
      expect(changesShape(kind, a, norm(kind, { response: {} }))).toBe(true);
    }
  });

  it('unknown response types are dropped; the default response is play_clip', () => {
    for (const kind of CHAT_KINDS.filter(hasResponse)) {
      expect(norm(kind).response).toEqual({ type: 'play_clip' });
      expect(
        norm(kind, { response: { type: 'nope', clipId: 'c' } }).response
      ).toEqual({
        clipId: 'c',
      });
      expect(norm(kind, { response: 'junk' }).response).toEqual({});
    }
  });

  it('no value is baked into any template', () => {
    for (const kind of CHAT_KINDS)
      expect(JSON.stringify(graph(kind, ALL_VALUES)), kind).not.toMatch(/zz/);
  });

  it('fingerprints are stable across builds and differ per kind', () => {
    const fps = ACTION_KINDS.map((k) =>
      templateFingerprint(k.kind, k.defaults())
    );
    expect(new Set(fps).size).toBe(fps.length);
    for (const kind of CHAT_KINDS)
      expect(templateFingerprint(kind, norm(kind))).toBe(
        templateFingerprint(kind, actionKind(kind)!.defaults())
      );
  });

  it('settings nodes read declared fields, one node per field', () => {
    for (const kind of CHAT_KINDS) {
      const roots = new Set(
        actionKind(kind)!.fields.map((f) => f.path.split('.')[0])
      );
      for (const type of hasResponse(kind) ? RESPONSE_TYPE_IDS : ['']) {
        const g = graph(kind, { response: { type } });
        const fields = g.nodes
          .filter((n) => n.kind === SETTINGS_NODE_KIND)
          .map((n) => String(n.defaultConfig?.field));
        for (const f of fields)
          expect(roots.has(f.split('.')[0]), `${kind}: ${f}`).toBe(true);
        expect(new Set(fields).size).toBe(fields.length);
      }
    }
  });
});

describe('Chat command', () => {
  it('commandNames strips "!", splits aliases, drops empties and duplicates', () => {
    expect(A.commandNames('!hug', 'cuddle, !Snuggle  HUG,,')).toEqual([
      'hug',
      'cuddle',
      'Snuggle',
    ]);
    expect(A.commandNames('', '')).toEqual([]);
    expect(A.commandNames(7, null)).toEqual([]);
  });

  it('commandPattern matches exactly one name, case-insensitively', () => {
    const re = new RegExp(A.commandPattern(['hug', 'c.d']), 'i');
    expect(re.test('HUG')).toBe(true);
    expect(re.test('hugs')).toBe(false);
    expect(re.test('c.d')).toBe(true);
    expect(re.test('cxd')).toBe(false); // escaped
    expect(A.commandPattern([])).toBe('');
  });

  it('normalizes and derives the command pattern and counter variable', () => {
    const s = norm('chat_command', {
      command: ' !hug ',
      aliases: 'cuddle',
      minRank: 'vip',
      cooldown: { seconds: -4, group: ' fun ' },
      counter: { enabled: true, name: ' hugs ', step: '2' },
    });
    expect(s.command).toBe('!hug');
    expect(s.minRank).toBe('everyone');
    expect(s.cooldown).toEqual({ seconds: 0, group: 'fun' });
    expect(s.counter).toEqual({
      enabled: true,
      name: 'hugs',
      step: 2,
      persistent: true,
    });
    expect(derived(s)).toEqual({
      commandPattern: '^(?:hug|cuddle)$',
      counterName: 'hugs',
      counterScope: '',
    });
    // An unnamed counter is graph-local: the scope template renders the graph id.
    expect(derived(norm('chat_command'))).toMatchObject({
      counterName: 'count',
      counterScope: '${id}',
    });
  });

  it('template: command match → rank → args → cooldown → counter → reply', () => {
    const g = graph('chat_command');
    expect(nodeOf(g, 'trigger')?.kind).toBe('overlive_chat_command');
    expect(nodeOf(g, 'command_match')?.defaultConfig).toEqual({ flags: 'i' });
    expect(nodeOf(g, 'reply')?.defaultConfig).toEqual({
      fields: ['user', 'args', 'count'],
    });
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'cfg_account.value>trigger.account',
        'cfg_account.value>send.account',
        'trigger.command>command_match.text',
        'cfg_derived_commandPattern.value>command_match.pattern',
        'trigger.event>command_gate.in',
        'command_gate.then>rank_gate.in',
        'cfg_minRank.value>rank.minRank',
        'rank_gate.then>args_skip.in',
        'cfg_argsPattern.value>args_optional.a',
        'args_skip.then>cooldown.in',
        'args_skip.else>args_gate.in',
        'args_gate.then>cooldown.in',
        'cfg_cooldown_group.value>cooldown.group',
        'cooldown.out>counter_gate.in',
        'counter_gate.then>counter.fire',
        'counter.done>send.fire',
        'counter_gate.else>send.fire',
        'this_logic.id>counter_scope.id',
        'cfg_derived_counterScope.value>counter_scope.template',
        'counter_scope.text>counter.scope',
        'counter_scope.text>count.scope',
        'cfg_derived_counterName.value>count.name',
        'trigger.displayName>reply.user',
        'trigger.args>reply.args',
        'count.value>reply.count',
        'args_match.groups>reply.values',
        'reply.text>send.template',
      ])
    );
  });

  it('preview: commands, rank, cooldown, counter; reply and args pattern', () => {
    const p = preview('chat_command', {
      command: 'hug',
      aliases: 'cuddle',
      minRank: 'sub',
      cooldown: { seconds: 30, group: 'fun' },
      counter: { enabled: true, name: 'hugs' },
      reply: '${user} hugs ${args}',
      argsPattern: '\\w+',
    });
    expect(p.headline).toEqual([
      { t: 'text', text: '!hug' },
      { t: 'text', text: '!cuddle' },
      { t: 'msg', key: 'preview.rank.sub' },
      {
        t: 'msg',
        key: 'preview.cooldownGroup',
        params: { s: 30, group: 'fun' },
      },
      { t: 'msg', key: 'preview.counter', params: { name: 'hugs' } },
    ]);
    expect(p.lines).toEqual([
      [{ t: 'text', text: '“${user} hugs ${args}”' }],
      [
        { t: 'msg', key: 'preview.argsPattern' },
        { t: 'text', text: '/\\w+/' },
      ],
    ]);
    const empty = preview('chat_command', { cooldown: { seconds: 0 } });
    expect(empty.headline).toEqual([{ t: 'msg', key: 'preview.noCommand' }]);
    expect(empty.lines).toEqual([[{ t: 'msg', key: 'preview.noReply' }]]);
    expect(
      preview('chat_command', {
        counter: { enabled: true },
        cooldown: { seconds: 5 },
      }).headline
    ).toEqual([
      { t: 'msg', key: 'preview.noCommand' },
      { t: 'msg', key: 'preview.cooldown', params: { s: 5 } },
      { t: 'msg', key: 'preview.counterOwn' },
    ]);
  });
});

describe('Chat pattern', () => {
  it('fullTextPattern anchors the pattern to the whole text', () => {
    expect(A.fullTextPattern('ab')).toBe('^(?:ab)$');
    expect(A.fullTextPattern('')).toBe('');
    expect(derived(norm('chat_pattern', { pattern: 'a|b' })).fullPattern).toBe(
      '^(?:a|b)$'
    );
  });

  it('template: full-text match; message + groups reach the reply', () => {
    const g = graph('chat_pattern');
    expect(nodeOf(g, 'trigger')?.kind).toBe('overlive_chat_message');
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'cfg_derived_fullPattern.value>pattern_match.pattern',
        'pattern_gate.then>rank_gate.in',
        'rank_gate.then>cooldown.in',
        'trigger.text>reply.message',
        'pattern_match.groups>reply.values',
      ])
    );
  });

  it('preview: the pattern, or "no pattern"', () => {
    expect(preview('chat_pattern', { pattern: 'a+' }).headline[0]).toEqual({
      t: 'text',
      text: '/a+/',
    });
    expect(preview('chat_pattern').headline[0]).toEqual({
      t: 'msg',
      key: 'preview.noPattern',
    });
  });
});

describe('Chat keyword', () => {
  it('keywordPattern finds whole words / phrases / emotes, case-insensitively', () => {
    const re = new RegExp(
      A.keywordPattern(A.keywordList('LUL, :), good night, Kappa')),
      A.KEYWORD_FLAGS
    );
    expect(re.test('haha lul')).toBe(true);
    expect(re.test('LUL!')).toBe(true);
    expect(re.test('LULZ')).toBe(false);
    expect(re.test('xLUL')).toBe(false);
    expect(re.test('bye :)')).toBe(true);
    expect(re.test('good   night')).toBe(true);
    expect(re.test('ÜLUL')).toBe(false); // letters beyond ASCII count as word chars
    expect(A.keywordPattern([])).toBe('');
    expect(A.keywordList(' a ,\nb\n, A ,')).toEqual(['a', 'b']);
    expect(
      derived(norm('chat_keyword', { keywords: 'LUL' })).keywordPattern
    ).toBe(A.keywordPattern(['LUL']));
  });

  it('template: keyword match → cooldown → response + trigger', () => {
    const g = graph('chat_keyword', { response: { type: 'control_media' } });
    expect(nodeOf(g, 'keyword_match')?.defaultConfig).toEqual({
      flags: A.KEYWORD_FLAGS,
    });
    expect(nodeOf(g, 'response')?.kind).toBe('media_control');
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'keyword_gate.then>cooldown.in',
        'cooldown.out>response.fire',
        'cfg_response_target.value>response.target',
        'cfg_response_action.value>response.action',
        'cooldown.out>emit.fire',
        'cfg_trigger.value>emit.name',
        'trigger.data>emit.payload',
      ])
    );
    expect(
      nodeOf(graph('chat_keyword', { response: {} }), 'response')
    ).toBeUndefined();
  });

  it('preview: keywords + cooldown; response and trigger lines', () => {
    const p = preview('chat_keyword', {
      keywords: 'LUL, KEKW',
      trigger: 'laugh',
      response: { type: 'play_clip', clipId: 'c1' },
    });
    expect(p.headline).toEqual([
      { t: 'text', text: 'LUL, KEKW' },
      { t: 'msg', key: 'preview.cooldown', params: { s: 10 } },
    ]);
    expect(p.lines).toEqual([
      [
        { t: 'msg', key: 'responses.play_clip' },
        { t: 'ref', ref: 'clip', id: 'c1' },
      ],
      [{ t: 'msg', key: 'preview.trigger', params: { name: 'laugh' } }],
    ]);
    expect(preview('chat_keyword').headline[0]).toEqual({
      t: 'msg',
      key: 'preview.noKeywords',
    });
  });
});

describe('Keyword combo', () => {
  it('normalizes threshold / window and derives the combo key', () => {
    const combo = norm('keyword_combo', { threshold: 0, window: -1 });
    expect([combo.threshold, combo.window, combo.uniqueChatters]).toEqual([
      1,
      0,
      true,
    ]);
    expect(combo.mode).toBe('threshold');
    expect(norm('keyword_combo', { mode: 'timeout' }).mode).toBe('timeout');
    expect(norm('keyword_combo', { mode: 'bogus' }).mode).toBe('threshold');
    expect(derived(combo).comboKey).toBe('${user}');
    expect(
      derived(norm('keyword_combo', { uniqueChatters: false })).comboKey
    ).toBe('');
  });

  it('template: both combo nodes from the same hit; end message gated on "reached"', () => {
    const g = graph('keyword_combo');
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'keyword_gate.then>threshold.in',
        'keyword_gate.then>timeout.in',
        'combo_key.text>threshold.key',
        'combo_key.text>timeout.key',
        'trigger.username>combo_key.user',
        'cfg_window.value>threshold.window',
        'cfg_window.value>timeout.timeout',
        'threshold.reached>response.fire',
        'threshold.reached>reached_set.fire',
        'timeout.ended>end_gate.in',
        'reached.value>end_gate.condition',
        'end_gate.then>reached_clear.fire',
        'end_gate.then>end_send.fire',
        'timeout.count>end_text.count',
        'this_logic.id>reached.scope',
      ])
    );
    expect(nodeOf(g, 'reached_set')?.defaultConfig).toEqual({
      name: 'comboReached',
      value: true,
      persistent: false,
    });
  });

  it('timeout mode: the response runs when a combo that reached the threshold ends', () => {
    const g = graph('keyword_combo', { mode: 'timeout' });
    const edges = edgeStrs(g);
    expect(edges).toContain('end_gate.then>response.fire');
    expect(edges).not.toContain('threshold.reached>response.fire');
    // "reached" is still recorded, and the end message still goes out.
    expect(edges).toEqual(
      expect.arrayContaining([
        'threshold.reached>reached_set.fire',
        'end_gate.then>end_send.fire',
      ])
    );
    // The mode is a shape setting: switching it changes the template, and a
    // missing mode (actions made before modes existed) is threshold mode.
    expect(A.settingClassOf('keyword_combo', 'mode')).toBe('shape');
    expect(
      A.changesShape(
        'keyword_combo',
        norm('keyword_combo'),
        norm('keyword_combo', { mode: 'timeout' })
      )
    ).toBe(true);
    expect(A.templateFingerprint('keyword_combo', { response: {} })).toBe(
      A.templateFingerprint('keyword_combo', {
        mode: 'threshold',
        response: {},
      })
    );
  });

  it('preview: timeout mode names the minimum and the wait', () => {
    expect(
      preview('keyword_combo', { mode: 'timeout', threshold: 3, window: 5 })
        .headline[1]
    ).toEqual({
      t: 'msg',
      key: 'preview.comboTimeout',
      params: { n: 3, s: 5 },
    });
  });

  it('preview: keyword, threshold in window, unique; response and end message', () => {
    const p = preview('keyword_combo', {
      keywords: 'Pog',
      threshold: 4,
      window: 8,
      endMessage: '${count}!',
    });
    expect(p.headline).toEqual([
      { t: 'text', text: 'Pog' },
      { t: 'msg', key: 'preview.combo', params: { n: 4, s: 8 } },
      { t: 'msg', key: 'preview.unique' },
    ]);
    expect(p.lines[1]).toEqual([
      { t: 'msg', key: 'preview.endMessage' },
      { t: 'text', text: '“${count}!”' },
    ]);
    expect(
      preview('keyword_combo', { uniqueChatters: false }).headline
    ).toHaveLength(2);
  });
});

describe('Redemption', () => {
  it('rewardPattern matches the title exactly, case-insensitively', () => {
    const r = new RegExp(A.rewardPattern(' Hydrate! '), 'i');
    expect(r.test('  hydrate! ')).toBe(true);
    expect(r.test('hydrate!!')).toBe(false);
    expect(A.rewardPattern('  ')).toBe('');
    expect(
      derived(norm('redemption', { reward: 'Hydrate' })).rewardPattern
    ).toBe(A.rewardPattern('Hydrate'));
  });

  it('template: reward match → response, counter + reply, trigger, mark complete', () => {
    const g = graph('redemption');
    expect(nodeOf(g, 'complete')?.defaultConfig).toEqual({
      status: 'FULFILLED',
    });
    expect(nodeOf(g, 'reply')?.defaultConfig).toEqual({
      fields: ['user', 'message', 'reward', 'count'],
    });
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'trigger.rewardTitle>reward_match.text',
        'reward_gate.then>response.fire',
        'reward_gate.then>counter_gate.in',
        'reward_gate.then>emit.fire',
        'trigger.data>emit.payload',
        'reward_gate.then>complete_gate.in',
        'cfg_markComplete.value>complete_gate.condition',
        'complete_gate.then>complete.fire',
        'trigger.redemptionId>complete.redemptionId',
        'trigger.rewardId>complete.rewardId',
        'cfg_account.value>complete.account',
      ])
    );
  });

  it('preview: reward, counter, complete; response, reply, trigger', () => {
    const p = preview('redemption', {
      reward: 'Hydrate',
      counter: { enabled: true, name: 'water' },
      markComplete: true,
      reply: 'Drink, ${user}!',
      trigger: 'alert',
    });
    expect(p.headline).toEqual([
      { t: 'text', text: 'Hydrate' },
      { t: 'msg', key: 'preview.counter', params: { name: 'water' } },
      { t: 'msg', key: 'preview.markComplete' },
    ]);
    expect(p.lines).toEqual([
      [{ t: 'msg', key: 'responses.play_clip' }],
      [{ t: 'text', text: '“Drink, ${user}!”' }],
      [{ t: 'msg', key: 'preview.trigger', params: { name: 'alert' } }],
    ]);
    expect(preview('redemption').headline).toEqual([
      { t: 'msg', key: 'preview.noReward' },
    ]);
  });
});
