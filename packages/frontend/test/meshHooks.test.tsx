/**
 * The bridge that makes `@vspark/mesh-react` usable from a component.
 *
 * The package's hooks take a `Collection` as an argument, and this tab's
 * collections only exist once `initMeshPeer()` resolves — which is why the
 * package shipped written, tested, and imported by nothing. Two things have to
 * hold for the bridge to be worth having:
 *
 *  1. a component that mounts BEFORE the peer is up must re-render when it
 *     arrives (otherwise it reads `undefined` forever, which is worse than the
 *     store it replaced);
 *  2. it must not flash empty during the startup window, when the REST bundle
 *     has landed and the mesh snapshot has not — the regression that makes a
 *     naive "read the replica instead" conversion a bad trade.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
// Static import is fine: `vi.mock` is hoisted above it, so the hooks module
// resolves against the mocked peer.
import { useSceneNode } from '../src/mesh/hooks';

/** Fires the ready callbacks by hand, so a test controls when the peer lands. */
let ready: ((h: unknown) => void)[] = [];
let handles: unknown = null;
const observers: (() => void)[] = [];
let docs: Record<string, unknown> = {};

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => handles,
  onMeshReady: (cb: (h: unknown) => void) => {
    if (handles) cb(handles);
    else ready.push(cb);
    return () => {
      ready = ready.filter((f) => f !== cb);
    };
  },
}));

const collection = {
  rtype: 'scene_node',
  get: (id: string) => docs[id],
  observe: (_sel: unknown, cb: () => void) => {
    observers.push(cb);
    return () => {};
  },
};

/** Bring the peer up, as `doInit` does when its promise resolves. */
function peerArrives() {
  handles = {
    peer: {},
    serverPeerId: 'server',
    collections: { scene_node: collection },
  };
  act(() => {
    for (const cb of ready) cb(handles);
    ready = [];
  });
}

function Probe({ id }: { id: string }) {
  const node = useSceneNode(id);
  return <div data-testid="name">{node?.name ?? 'none'}</div>;
}

describe('useSceneNode', () => {
  beforeEach(async () => {
    // Deliberately NOT vi.resetModules(): the probe imports the hook
    // statically, so resetting would hand the test a second copy of the store
    // and its `setState` would land on a module the component never reads.
    ready = [];
    handles = null;
    observers.length = 0;
    docs = {};
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ nodes: [] });
  });

  it('reads the store while the peer is still starting', async () => {
    // The startup window: the REST bundle has populated the store and the mesh
    // snapshot has not arrived. Rendering "none" here would be the flash of
    // empty editor that makes this conversion a regression.
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({
      nodes: [{ id: 'n1', name: 'From REST' } as never],
    });

    render(<Probe id="n1" />);
    expect(screen.getByTestId('name').textContent).toBe('From REST');
  });

  it('prefers the replica once it holds the document', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({
      nodes: [{ id: 'n1', name: 'From REST' } as never],
    });
    docs = { n1: { id: 'n1', name: 'From mesh' } };

    render(<Probe id="n1" />);
    peerArrives();

    expect(screen.getByTestId('name').textContent).toBe('From mesh');
  });

  it('re-renders when the peer arrives after the component mounted', async () => {
    // Property (1): a component almost always mounts before the async init
    // resolves, so without the ready signal it would read undefined forever.
    docs = { n1: { id: 'n1', name: 'From mesh' } };
    render(<Probe id="n1" />);
    expect(screen.getByTestId('name').textContent).toBe('none');

    peerArrives();
    expect(screen.getByTestId('name').textContent).toBe('From mesh');
  });

  it('re-renders when that document changes', async () => {
    docs = { n1: { id: 'n1', name: 'Before' } };
    render(<Probe id="n1" />);
    peerArrives();
    expect(screen.getByTestId('name').textContent).toBe('Before');

    act(() => {
      docs = { n1: { id: 'n1', name: 'After' } };
      for (const cb of observers) cb();
    });
    expect(screen.getByTestId('name').textContent).toBe('After');
  });

  it('returns undefined for a null id without subscribing to anything', () => {
    render(<Probe id={null as unknown as string} />);
    expect(screen.getByTestId('name').textContent).toBe('none');
  });
});
