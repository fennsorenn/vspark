/**
 * Names already in use, suggested by the inputs that name a variable, a
 * scope, a cooldown group or a named trigger (mesh/names.ts), and the unique
 * variable name a Goal gets on placement.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  COOLDOWN_SCOPE,
  nodePortNameSpec,
  scopeOptions,
  triggerBases,
  triggerNames,
  uniqueName,
  variableNames,
  type ProjectDocs,
} from '../src/mesh/names';
import {
  renameTriggerBase,
  renameVariable,
} from '../src/components/editor/composites/compositeModel';
import { DraftText } from '../src/components/editor/actions/draftInputs';

const node = (id: string, kind: string, defaultConfig: Record<string, unknown> = {}) => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  defaultConfig,
});

const docs: ProjectDocs = {
  variables: [
    { id: 'v1', projectId: 'p1', scope: '', name: 'score', value: 1 },
    { id: 'v2', projectId: 'p2', scope: '', name: 'elsewhere', value: 1 },
    { id: 'v3', projectId: 'p1', scope: 'g1', name: 'countdown', value: {} },
  ],
  logic: [
    {
      id: 'g1',
      projectId: 'p1',
      name: 'Countdown',
      descriptor: {
        nodes: {
          lid: node('lid', 'logic_id'),
          dl: node('dl', 'deadline', { name: 'countdown' }),
          get: node('get', 'variable', { name: 'goal' }),
          wired: node('wired', 'set_variable', { name: 'mystery' }),
          src: node('src', 'text_format'),
          cd: node('cd', 'cooldown', { group: 'chat' }),
          on: node('on', 'on_trigger', { name: 'countdown start' }),
          send: node('send', 'send_trigger', { name: 'alert' }),
        },
        edges: {
          a: { fromNodeId: 'lid', fromPort: 'id', toNodeId: 'dl', toPort: 'scope', kind: 'value' },
          b: { fromNodeId: 'src', fromPort: 'text', toNodeId: 'wired', toPort: 'scope', kind: 'value' },
        },
      },
    },
    { id: 'g2', projectId: 'p2', name: 'Other', descriptor: { nodes: {}, edges: {} } },
  ],
  actions: [
    {
      id: 'a1',
      projectId: 'p1',
      settings: { counter: { name: 'deaths' }, cooldown: { group: 'hype' }, trigger: 'clip' },
    },
  ],
};

describe('names in use', () => {
  it('variables per scope: stored ones, node names and action counters', () => {
    expect(variableNames('p1', '', docs)).toEqual(['deaths', 'goal', 'score']);
    // The deadline's scope is wired from This Logic: the graph's id.
    expect(variableNames('p1', 'g1', docs)).toEqual(['countdown']);
    // A scope wired from something else is unknown: not listed anywhere.
    expect(variableNames('p1', '', docs)).not.toContain('mystery');
    expect(variableNames('p1', COOLDOWN_SCOPE, docs)).toEqual(['chat', 'hype']);
  });

  it('triggers sent or listened for, and their timer bases', () => {
    const names = triggerNames('p1', docs);
    expect(names).toEqual(['alert', 'clip', 'countdown start']);
    expect(triggerBases(names)).toEqual(['countdown']);
  });

  it('scopes: shared plus each graph of the project by name', () => {
    expect(scopeOptions('p1', docs.logic, 'Shared')).toEqual([
      { value: '', label: 'Shared' },
      { value: 'g1', label: 'Countdown' },
    ]);
  });

  it('which node inputs name what', () => {
    expect(nodePortNameSpec('variable', 'name', 'g1', '')).toEqual({ kind: 'variable', scope: 'g1' });
    expect(nodePortNameSpec('variable', 'name', null, '')).toBeNull();
    expect(nodePortNameSpec('tally', 'scope', '', 'S')).toEqual({ kind: 'scope', sharedLabel: 'S' });
    expect(nodePortNameSpec('cooldown', 'group', '', '')).toEqual({ kind: 'variable', scope: COOLDOWN_SCOPE });
    expect(nodePortNameSpec('send_trigger', 'name', '', '')).toEqual({ kind: 'trigger' });
    expect(nodePortNameSpec('text_format', 'template', '', '')).toBeNull();
  });

  it('a new name is the first free one', () => {
    expect(uniqueName('goal', ['score'])).toBe('goal');
    expect(uniqueName('goal', ['goal', 'goal 2'])).toBe('goal 3');
  });
});

describe('placing a goal', () => {
  it('renames its shared variable everywhere in the payload, nothing else', () => {
    const payload = {
      logic: [
        {
          descriptor: {
            nodes: [
              node('get', 'variable', { name: 'goal' }),
              node('inc', 'increment_variable', { name: 'goal' }),
              node('priv', 'variable', { name: 'goal', scope: 'x' }),
              node('sd', 'set_data', { name: 'goal' }),
            ],
          },
        },
      ],
    };
    const out = renameVariable(payload, 'goal', 'goal 2');
    const names = out.logic[0].descriptor.nodes.map((n) => n.defaultConfig.name);
    expect(names).toEqual(['goal 2', 'goal 2', 'goal', 'goal']);
    // The fetched payload itself is left alone.
    expect(payload.logic[0].descriptor.nodes[0].defaultConfig.name).toBe('goal');
    expect(renameVariable(payload, 'goal', 'goal')).toBe(payload);
  });
});

describe('placing a timer', () => {
  it('renames its control triggers to the new base, nothing else', () => {
    const payload = {
      logic: [
        {
          descriptor: {
            nodes: [
              node('tStart', 'on_trigger', { name: 'countdown start' }),
              node('tReset', 'on_trigger', { name: 'countdown reset' }),
              node('done', 'send_trigger', { name: '' }),
              node('other', 'on_trigger', { name: 'countdowns start' }),
              node('fmt', 'text_format', { name: 'countdown start' }),
            ],
          },
        },
      ],
    };
    const out = renameTriggerBase(payload, 'countdown', 'countdown 2');
    expect(out.logic[0].descriptor.nodes.map((n) => n.defaultConfig.name)).toEqual([
      'countdown 2 start',
      'countdown 2 reset',
      '',
      'countdowns start',
      'countdown start',
    ]);
    expect(renameTriggerBase(payload, 'x', 'x')).toBe(payload);
    // The base to use: the first free one among those in use.
    expect(uniqueName('countdown', triggerBases(['countdown start', 'alert']))).toBe(
      'countdown 2'
    );
  });
});

describe('a suggesting text input', () => {
  it('offers the suggestions as a datalist and still takes free text', () => {
    const { container } = render(
      <DraftText
        className="vs-x"
        value=""
        onCommit={() => {}}
        suggestions={['alert', { value: 'g1', label: 'Countdown' }]}
      />
    );
    const input = container.querySelector('input')!;
    const list = [...container.querySelectorAll('datalist')].find(
      (d) => d.id === input.getAttribute('list')
    )!;
    expect([...list.querySelectorAll('option')].map((o) => o.value)).toEqual(['alert', 'g1']);
    expect(list.querySelectorAll('option')[1].getAttribute('label')).toBe('Countdown');
  });
});
