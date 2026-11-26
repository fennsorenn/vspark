/**
 * A behavior's stored graph in the Properties panel (BehaviorGraphBar) and its
 * mesh writes (mesh/behaviorGraphs.ts): badges, Open graph, and Reset as one
 * undo step. The template comes from the server, so the API call is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { graphFingerprint } from '@vspark/shared/actions';
import {
  toDescriptorDoc,
  toGraphDescriptor,
  type GraphDescriptor,
} from '@vspark/shared/signal';
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from './helpers/render';
import { seedEditor, testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';
import { BehaviorGraphBar } from '../src/components/editor/BehaviorGraphBar';
import {
  behaviorGraphStatus,
  commitBehaviorGraphReset,
} from '../src/mesh/behaviorGraphs';
import { useEditorStore, type Behavior } from '../src/store/editorStore';
import type { BehaviorTemplate } from '../src/api/client';

const TEMPLATE_GRAPH: GraphDescriptor = {
  id: 'breathing:b1',
  label: 'Breathing',
  readonly: false,
  nodes: [
    {
      id: 'clock',
      kind: 'clock',
      position: { x: 0, y: 0 },
      defaultConfig: { hz: 30 },
    },
    { id: 'comp_id', kind: 'behavior_id', position: { x: 0, y: 80 } },
  ],
  edges: [],
};
const TEMPLATE: BehaviorTemplate = {
  graphId: 'breathing:b1',
  label: 'Breathing',
  descriptor: toDescriptorDoc(TEMPLATE_GRAPH),
  fingerprint: graphFingerprint(TEMPLATE_GRAPH),
  shapeFields: [],
};

const getBehaviorTemplate = vi.fn(async (_id: string) => TEMPLATE);
vi.mock('../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/client')>()),
  getBehaviorTemplate: (id: string) => getBehaviorTemplate(id),
}));

const behaviors = () => testPeer().collection<Behavior>('behavior');
const logic = () => testPeer().collection<Record<string, unknown>>('logic');
const graphOf = () =>
  toGraphDescriptor(logic().get('breathing:b1')?.descriptor as never);

/** Each seed is newer than the last, so re-seeding replaces the document. */
let seedClock = 0;

function seedBehavior(
  over: Partial<Behavior> = {},
  graph: GraphDescriptor | null = TEMPLATE_GRAPH
): Behavior {
  const b: Behavior = {
    id: 'b1',
    nodeId: 'n1',
    kind: 'breathing',
    enabled: true,
    config: {},
    templateFingerprint: TEMPLATE.fingerprint,
    ...over,
  };
  behaviors().put(b, { v: { t: ++seedClock, c: 0, n: 'seed' } });
  if (graph)
    logic().put(
      {
        id: 'breathing:b1',
        ownerKind: 'behavior',
        ownerId: 'b1',
        name: 'Breathing',
        enabled: true,
        descriptor: toDescriptorDoc(graph),
      },
      { v: { t: ++seedClock, c: 0, n: 'seed' } }
    );
  return b;
}

const withExtra = (g: GraphDescriptor): GraphDescriptor => ({
  ...g,
  nodes: [
    ...g.nodes,
    { id: 'extra', kind: 'behavior_id', position: { x: 9, y: 9 } },
  ],
});

const renderBar = (b: Behavior) =>
  renderWithProviders(
    <DialogProvider>
      <BehaviorGraphBar behavior={b} label="Breathing" />
    </DialogProvider>
  );

const resetButton = (c: HTMLElement) =>
  c.querySelector('.vs-behavior-reset-graph') as HTMLButtonElement;

beforeEach(() => {
  getBehaviorTemplate.mockClear();
  seedEditor({
    projectId: 'p1',
    nodes: [
      {
        id: 'n1',
        name: 'Avatar',
        kind: 'avatar',
        parentId: null,
        rootSceneNodeId: 's1',
      },
    ],
  });
});

describe('BehaviorGraphBar', () => {
  it('an unmodified graph shows no badge and nothing to reset', async () => {
    const { container } = renderBar(seedBehavior());
    await waitFor(() => expect(getBehaviorTemplate).toHaveBeenCalledWith('b1'));
    expect(container.querySelector('.vs-behavior-badge-modified')).toBeNull();
    expect(container.querySelector('.vs-behavior-badge-template')).toBeNull();
    expect(container.querySelector('.vs-behavior-badge-missing')).toBeNull();
    expect(resetButton(container).disabled).toBe(true);
  });

  it('a hand-edited graph reads as Modified; moving a node does not', async () => {
    const moved: GraphDescriptor = {
      ...TEMPLATE_GRAPH,
      nodes: TEMPLATE_GRAPH.nodes.map((n) => ({
        ...n,
        position: { x: 500, y: 1 },
      })),
    };
    const first = renderBar(seedBehavior({}, moved));
    await waitFor(() =>
      expect(resetButton(first.container).disabled).toBe(true)
    );
    expect(
      first.container.querySelector('.vs-behavior-badge-modified')
    ).toBeNull();
    first.unmount();

    const { container } = renderBar(
      seedBehavior({}, withExtra(TEMPLATE_GRAPH))
    );
    expect(
      container.querySelector('.vs-behavior-badge-modified')
    ).not.toBeNull();
    await waitFor(() => expect(resetButton(container).disabled).toBe(false));
  });

  it('shows Template update when the template moved on', async () => {
    const { container } = renderBar(
      seedBehavior({ templateFingerprint: 'older' }, withExtra(TEMPLATE_GRAPH))
    );
    await waitFor(() =>
      expect(
        container.querySelector('.vs-behavior-badge-template')
      ).not.toBeNull()
    );
  });

  it('No graph: Open is disabled, Reset creates it', async () => {
    const b = seedBehavior({}, null);
    const { container } = renderBar(b);
    expect(
      container.querySelector('.vs-behavior-badge-missing')
    ).not.toBeNull();
    expect(
      (container.querySelector('.vs-behavior-open-graph') as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await waitFor(() => expect(resetButton(container).disabled).toBe(false));
  });

  it('Open graph opens it on the canvas', async () => {
    const { container } = renderBar(seedBehavior());
    await userEvent
      .setup()
      .click(container.querySelector('.vs-behavior-open-graph')!);
    expect(useEditorStore.getState().activeLogicId).toBe('breathing:b1');
  });

  it('Reset asks first, then rebuilds the graph', async () => {
    const user = userEvent.setup();
    const b = seedBehavior({}, withExtra(TEMPLATE_GRAPH));
    const { container } = renderBar(b);
    await waitFor(() => expect(resetButton(container).disabled).toBe(false));

    await user.click(resetButton(container));
    await user.click(await screen.findByText('Cancel'));
    expect(graphOf().nodes.map((n) => n.id)).toContain('extra');

    await user.click(resetButton(container));
    await user.click(
      container.ownerDocument.querySelector('.vs-dialog-confirm')!
    );
    expect(graphOf().nodes.map((n) => n.id)).not.toContain('extra');
  });
});

describe('commitBehaviorGraphReset', () => {
  it('rewrites graph + fingerprint as one undo step', () => {
    seedBehavior({ templateFingerprint: 'older' }, withExtra(TEMPLATE_GRAPH));
    commitBehaviorGraphReset(behaviors().get('b1')!, TEMPLATE);
    expect(graphFingerprint(graphOf())).toBe(TEMPLATE.fingerprint);
    expect(behaviors().get('b1')?.templateFingerprint).toBe(
      TEMPLATE.fingerprint
    );

    testPeer().undo();
    expect(graphOf().nodes.map((n) => n.id)).toContain('extra');
    expect(behaviors().get('b1')?.templateFingerprint).toBe('older');
  });

  it('creates a missing graph owned by the behavior', () => {
    seedBehavior({}, null);
    commitBehaviorGraphReset(behaviors().get('b1')!, TEMPLATE);
    expect(logic().get('breathing:b1')).toMatchObject({
      ownerKind: 'behavior',
      ownerId: 'b1',
    });
  });

  it('status follows the Actions rules', () => {
    const b = { templateFingerprint: TEMPLATE.fingerprint };
    expect(behaviorGraphStatus(b, undefined, TEMPLATE)).toEqual({
      missingGraph: true,
      modified: false,
      templateUpdateAvailable: false,
    });
    expect(
      behaviorGraphStatus(b, { descriptor: withExtra(TEMPLATE_GRAPH) }, null)
    ).toEqual({
      missingGraph: false,
      modified: true,
      templateUpdateAvailable: false,
    });
  });
});
