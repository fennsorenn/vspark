/**
 * A graph node whose kind the catalog does not know (its plugin is not
 * installed) renders as a "missing" placeholder that keeps its connections.
 */
import { describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { renderWithProviders } from './helpers/render';
import { SignalNodeCard, type SignalNodeData } from '../src/components/editor/signal/SignalNodeCard';
import { missingKindPorts } from '../src/components/editor/signal/SignalGraphCanvas';

const descriptor: GraphDescriptor = {
  id: 'g',
  label: 'g',
  readonly: false,
  nodes: [
    { id: 'a', kind: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'x', kind: 'demo_gone', position: { x: 0, y: 0 } },
    { id: 'b', kind: 'log', position: { x: 0, y: 0 } },
  ],
  edges: [
    { fromNodeId: 'a', fromPort: 'trigger', toNodeId: 'x', toPort: 'fire' },
    { fromNodeId: 'a', fromPort: 'trigger', toNodeId: 'x', toPort: 'fire' },
    { fromNodeId: 'x', fromPort: 'done', toNodeId: 'b', toPort: 'trigger' },
  ],
};

describe('missing node kind', () => {
  it('derives ports from the stored edges (deduplicated)', () => {
    const ports = missingKindPorts(descriptor, 'x');
    expect(ports.inputPorts.map((p) => p.name)).toEqual(['fire']);
    expect(ports.outputPorts.map((p) => p.name)).toEqual(['done']);
    expect(missingKindPorts(descriptor, 'a').inputPorts).toEqual([]);
  });

  it('renders a "missing" header with an explanation', () => {
    const data: SignalNodeData = {
      nodeId: 'x',
      graphId: 'g',
      kind: 'demo_gone',
      display: undefined,
      missing: true,
      inputPorts: [],
      outputPorts: [],
      connectedInputPorts: [],
      readonly: false,
      lastExecutedAt: null,
      portValues: {},
      config: null,
    };
    const { container } = renderWithProviders(
      <ReactFlowProvider>
        <SignalNodeCard {...({ id: 'x', data, selected: false } as never)} />
      </ReactFlowProvider>
    );
    const header = container.querySelector('.vs-signal-node-missing')!;
    expect(header.textContent).toContain('demo_gone');
    expect(header.getAttribute('title')).toContain('plugin');
  });
});
