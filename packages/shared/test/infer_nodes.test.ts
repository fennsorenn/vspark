import { describe, it, expect } from 'vitest';
import {
  inferPackEvent,
  inferSetData,
  inferSceneEntity,
  inferQueueEvents,
  inferUnpackEvent,
  inferForKind,
  inferPortsFor,
} from '../src/infer_nodes.js';
import { RT } from '../src/signal_types.js';
import type { InferCtx, PortMeta } from '../src/node.js';

const ctx = (over: Partial<InferCtx> = {}): InferCtx => ({
  resolvedInputs: {},
  config: {},
  ...over,
});
const names = (ports: { name: string }[]) => ports.map((p) => p.name);

describe('inferPackEvent', () => {
  it('builds fire + named field inputs + a trailing empty slot; record omits unconnected', () => {
    const r = inferPackEvent(
      ctx({
        config: { fields: ['x', 'y'] },
        resolvedInputs: { x: RT.primitive('Float') },
      })
    );
    expect(names(r.inputPorts)).toEqual(['fire', 'x', 'y', '']);
    const out = r.outputPorts[0].type;
    expect(out.kind).toBe('event');
    if (out.kind === 'event' && out.payload.kind === 'record') {
      expect(Object.keys(out.payload.fields)).toEqual(['x']); // y is unknown → omitted
    } else {
      throw new Error('expected Event<record>');
    }
  });

  it('defaults to no fields (just fire + slot)', () => {
    const r = inferPackEvent(ctx());
    expect(names(r.inputPorts)).toEqual(['fire', '']);
  });
});

describe('inferSetData', () => {
  it('exposes fire + scope + fields + slot, no outputs', () => {
    const r = inferSetData(ctx({ config: { fields: ['a'] } }));
    expect(names(r.inputPorts)).toEqual(['fire', 'scope', 'a', '']);
    expect(r.outputPorts).toEqual([]);
  });
});

describe('inferSceneEntity', () => {
  it('types nodeId by owner scope', () => {
    expect(
      inferSceneEntity(ctx({ ownerKind: 'compose_layer' })).outputPorts[0].type
    ).toEqual(RT.primitive('ComposeLayer'));
    expect(inferSceneEntity(ctx()).outputPorts[0].type).toEqual(
      RT.primitive('SceneNode')
    );
  });
});

describe('inferQueueEvents', () => {
  it('mirrors the enqueued event payload onto popped', () => {
    const r = inferQueueEvents(
      ctx({ resolvedInputs: { enqueue: RT.event(RT.primitive('Float')) } })
    );
    expect(r.outputPorts[0]).toEqual({
      name: 'popped',
      type: RT.event(RT.primitive('Float')),
    });
    expect(r.outputPorts[1].type).toEqual(RT.primitive('Float')); // size
  });

  it('falls back to Event<unknown> when enqueue is unconnected', () => {
    const r = inferQueueEvents(ctx());
    expect(r.outputPorts[0].type).toEqual(RT.event(RT.unknown()));
  });
});

describe('inferUnpackEvent', () => {
  it('emits one output per record field of the payload (+ trigger)', () => {
    const r = inferUnpackEvent(
      ctx({
        resolvedInputs: {
          event: RT.event(
            RT.record({ a: RT.primitive('Float'), b: RT.primitive('String') })
          ),
        },
      })
    );
    expect(names(r.outputPorts)).toEqual(['trigger', 'a', 'b']);
  });

  it('falls back to a single value output for non-record payloads', () => {
    const r = inferUnpackEvent(ctx());
    expect(names(r.outputPorts)).toEqual(['trigger', 'value']);
  });
});

describe('registry lookups', () => {
  it('inferForKind resolves registered kinds only', () => {
    expect(inferForKind('pack_event')).toBe(inferPackEvent);
    expect(inferForKind('not_a_kind')).toBeUndefined();
  });

  it('inferPortsFor uses the kind fn, else defaultInfer over static ports', () => {
    const fromFn = inferPortsFor('queue_events', ctx(), []);
    expect(names(fromFn.inputPorts)).toEqual(['enqueue', 'pop']);

    const staticPorts: PortMeta[] = [
      {
        name: 'in',
        direction: 'in',
        transport: 'value',
        typeTag: 'Float',
        member: 'in',
      },
    ];
    const fallback = inferPortsFor('plain_node', ctx(), staticPorts);
    expect(names(fallback.inputPorts)).toEqual(['in']);
  });
});
