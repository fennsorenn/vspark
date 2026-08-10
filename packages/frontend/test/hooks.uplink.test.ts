/**
 * hooks.uplink.test.ts — Phase 7 deferred uplink + remaining hook tests
 *
 * Covers:
 *   - useLipsyncUplink    (setInterval loop, send via WebSocket)
 *   - useTrackingUplink   (CameraCapture callback wirer)
 *   - useSharedSubscriptions (remote_object peer subscription logic)
 *   - useClientMesh       (WebRTC mesh init, configure, cleanup)
 *
 * Convention notes from prior attempt:
 *   - useLipsyncUplink drives on setInterval (not rAF — see the hook's header),
 *     so its loop is asserted through vitest fake timers.
 *   - useEditorStore / useConnectionsStore are reset in outer beforeEach.
 */

// ── Module mocks (must appear before any import that would pull the real modules) ──

import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';

// Stub @vspark/shared subpaths (vitest aliases are configured but some
// transitively imported subpaths cause issues without explicit stubs).
vi.mock('@vspark/shared/sync', () => ({
  SYNC_MESSAGE_KIND: '__sync__',
  compareHLC: () => 0,
  makeClientParticipantId: (peerId: string, tabId: string) => `${peerId}#${tabId}`,
  isClientParticipant: (id: string) => id.includes('#'),
}));

vi.mock('@vspark/shared/types', () => ({}));

// Stub sync layer modules (all use @vspark/shared/sync transitively).
vi.mock('../src/sync/registry', () => ({
  applyRemote: vi.fn(),
}));

vi.mock('../src/sync/remoteEdit', () => ({
  setShareWriteRelay: vi.fn(),
}));

vi.mock('../src/sync/sharedProjection', () => ({
  removeProjection: vi.fn(),
  removePeerProjections: vi.fn(),
  rollbackWrite: vi.fn(),
  REMOTE_OBJECT_KIND: 'remote_object',
}));

vi.mock('../src/sync/meshProjection', () => ({
  registerAssetUrls: vi.fn(),
}));

// shareDirect — useSharedSubscriptions calls hasDirectEdge + subscribeDirect.
vi.mock('../src/sync/shareDirect', () => ({
  hasDirectEdge: vi.fn().mockReturnValue(false),
  subscribeDirect: vi.fn().mockReturnValue(false),
  handleShareEnvelope: vi.fn(),
  onDirectEdgeGone: vi.fn(),
}));

// clientMesh pulls in @vspark/shared/sync transitively.
vi.mock('../src/mesh/clientMesh', () => ({
  clientMesh: {
    configure: vi.fn(),
    sendHello: vi.fn(),
    sendEnvelope: vi.fn().mockReturnValue(false),
    isConnected: vi.fn().mockReturnValue(false),
    setRoster: vi.fn(),
    handleSignal: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  },
}));

// blobReceiver — pulled in by useClientMesh via shareDirect.
vi.mock('../src/mesh/blobReceiver', () => ({
  handleBlobEnvelope: vi.fn(),
  ensureBlob: vi.fn().mockResolvedValue('blob:fake'),
}));

// previewSmoother.
vi.mock('../src/previewSmoother', () => ({
  smoothNodeTransform: vi.fn(),
  smoothComposeLayer: vi.fn(),
}));

// ikTargetStore.
vi.mock('../src/ikTargetStore', () => ({
  setIkTargets: vi.fn(),
}));

// dispatchMediaCommand stub.
vi.mock('../src/components/editor/mediaRegistry', () => ({
  dispatchMediaCommand: vi.fn(),
}));

// api/client — stub only what the hooks call.
vi.mock('../src/api/client', () => ({
  mapBehavior: (p: unknown) => p,
  mapComposeLayer: (p: unknown) => p,
  mapTrackClip: (p: unknown) => p,
  mapTrackClipLane: (p: unknown) => p,
  mapTrackClipKeyframe: (p: unknown) => p,
  mapTrackClipEvent: (p: unknown) => p,
  getScenes: vi.fn().mockResolvedValue({ scenes: [], nodes: [], behaviors: [], cameraEffects: [] }),
  getCollabScenes: vi.fn().mockResolvedValue([]),
  peerSubscribe: vi.fn().mockResolvedValue(undefined),
  getConnectionIdentity: vi.fn().mockResolvedValue({ peerId: 'server-peer-1' }),
}));

// useWsSync — useClientMesh imports editorWsRef from here.
vi.mock('../src/hooks/useWsSync', () => ({
  editorWsRef: { current: null },
  useWsSync: vi.fn(),
}));

// ── Now import real modules ──

import { renderHook, act } from './helpers/render';
import { useEditorStore } from '../src/store/editorStore';
import { useConnectionsStore } from '../src/store/connectionsStore';

// ── Shared store reset state ──────────────────────────────────────────────────

const EDITOR_INITIAL: Parameters<typeof useEditorStore.setState>[0] = {
  projectId: null,
  projectName: '',
  scenes: [],
  activeSceneId: null,
  nodes: [],
  selectedNodeId: null,
  sceneSelected: false,
  selectedBehaviorId: null,
  assets: [],
  behaviors: [],
  vmcStatus: {},
  vmcTracking: {},
  scheduledAnimations: {},
  animationClips: {},
  vrmBonesByNode: {},
  vrmExpressionsByNode: {},
  vrmMorphTargetsByNode: {},
  hoveredBoneName: null,
  behaviorKinds: [],
  overliveAccounts: [],
  activeLogicWritable: false,
  activeLogicId: null,
  selectedSignalNodeId: null,
  boneListExpanded: {},
  fbxDebugVisible: {},
  cameraEffects: [],
  previewEffectsCamera: null,
  selectedEffect: null,
  composeScenes: [],
  activeComposeSceneId: null,
  composeLayers: [],
  leftTab: 'scene' as const,
  bottomTab: 'models' as const,
  bottomTabFlash: 0,
  focusNameNonce: 0,
  bottomDockHeight: 200,
  editorAudioPreviewEnabled: false,
  clipboardPayload: null,
  selectedComposeLayerId: null,
  trackClips: [],
  selectedTrackClipId: null,
  trackClipPlayback: {},
  nodeTransformOverrides: {},
  composeLayerOverrides: {},
  runtimeNodeOverrides: {},
  runtimeLayerOverrides: {},
  dataChannels: {},
  suppressedOverrides: new Set<string>(),
  presets: [],
  updateAvailable: false,
  updateInfo: null,
  pendingReload: false,
};

const CONNECTIONS_INITIAL = {
  enabled: false,
  status: 'idle' as const,
  identityPeerId: null,
  peers: [],
  connectedIds: [],
  nameById: {},
  incoming: [],
  offers: {},
  subscribed: {},
  meshConnected: [],
  collabScenes: {},
  revision: 0,
};

beforeEach(() => {
  useEditorStore.setState(EDITOR_INITIAL, false);
  useConnectionsStore.setState(CONNECTIONS_INITIAL, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// useLipsyncUplink
// ─────────────────────────────────────────────────────────────────────────────

import { useLipsyncUplink } from '../src/hooks/useLipsyncUplink';

describe('useLipsyncUplink', () => {
  // The hook drives on setInterval, not rAF: rAF is compositor-driven and stalls in a
  // backgrounded/offscreen window, which is where the server-side browser-agent capture
  // provider runs this page. So the loop is asserted through fake timers.
  const FRAME_MS = 1000 / 30;

  /** Pending interval count — the observable stand-in for "the loop is running". */
  function loopCount() {
    return vi.getTimerCount();
  }

  function flushFrame() {
    vi.advanceTimersByTime(FRAME_MS);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not start the loop when active=false', () => {
    const wsRef = { current: null as WebSocket | null };
    const micRef = { current: null };
    renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-1',
        micRef as React.RefObject<null>,
        false
      )
    );
    expect(loopCount()).toBe(0);
  });

  it('does not start the loop when behaviorId is null', () => {
    const wsRef = { current: null as WebSocket | null };
    const micRef = { current: null };
    renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        null,
        micRef as React.RefObject<null>,
        true
      )
    );
    expect(loopCount()).toBe(0);
  });

  it('starts the loop when active=true and behaviorId is set', () => {
    const wsRef = { current: null as WebSocket | null };
    const micRef = { current: null };
    const { unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-1',
        micRef as React.RefObject<null>,
        true
      )
    );
    expect(loopCount()).toBeGreaterThan(0);
    unmount();
  });

  it('clears the loop on unmount', () => {
    const wsRef = { current: null as WebSocket | null };
    const micRef = { current: null };
    const { unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-1',
        micRef as React.RefObject<null>,
        true
      )
    );
    expect(loopCount()).toBe(1);
    unmount();
    expect(loopCount()).toBe(0);
  });

  it('sends lipsync_input when mic is active and ws is open', () => {
    const sent: string[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    const wsRef = { current: fakeWs };

    const fakeVisemes = { A: 0.5, I: 0.2 };
    const fakeMic = {
      active: true,
      getVisemes: () => fakeVisemes,
    };
    const micRef = { current: fakeMic };

    const { unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-lipsync',
        micRef as React.RefObject<typeof fakeMic | null>,
        true
      )
    );

    act(() => { flushFrame(); });

    expect(sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(sent[0]);
    expect(msg.kind).toBe('lipsync_input');
    expect(msg.behaviorId).toBe('beh-lipsync');
    expect(msg.visemes).toEqual(fakeVisemes);

    unmount();
  });

  it('does not send when mic is inactive', () => {
    const sent: string[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    const wsRef = { current: fakeWs };

    const fakeMic = {
      active: false,
      getVisemes: () => ({}),
    };
    const micRef = { current: fakeMic };

    const { unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-lipsync',
        micRef as React.RefObject<typeof fakeMic | null>,
        true
      )
    );

    act(() => { flushFrame(); });

    expect(sent.length).toBe(0);
    unmount();
  });

  it('does not send when ws is not open', () => {
    const sent: string[] = [];
    const fakeWs = {
      readyState: WebSocket.CONNECTING,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    const wsRef = { current: fakeWs };

    const fakeMic = {
      active: true,
      getVisemes: () => ({ A: 0.9 }),
    };
    const micRef = { current: fakeMic };

    const { unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-lipsync',
        micRef as React.RefObject<typeof fakeMic | null>,
        true
      )
    );

    act(() => { flushFrame(); });

    expect(sent.length).toBe(0);
    unmount();
  });

  it('clears the loop when active flips to false', () => {
    const wsRef = { current: null as WebSocket | null };
    const micRef = { current: null };
    let active = true;

    const { rerender, unmount } = renderHook(() =>
      useLipsyncUplink(
        wsRef as React.RefObject<WebSocket | null>,
        'beh-1',
        micRef as React.RefObject<null>,
        active
      )
    );

    expect(loopCount()).toBe(1);

    active = false;
    rerender();

    expect(loopCount()).toBe(0);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useTrackingUplink
// ─────────────────────────────────────────────────────────────────────────────

import { useTrackingUplink } from '../src/hooks/useTrackingUplink';

interface FakeCameraCapture {
  onResult: ((result: { pose: number[] }) => void) | null;
}

describe('useTrackingUplink', () => {
  it('does not wire callback when active=false', () => {
    const camera: FakeCameraCapture = { onResult: null };
    const ws = null;
    const { unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-1', camera as unknown as null, false)
    );
    expect(camera.onResult).toBeNull();
    unmount();
  });

  it('does not wire callback when camera is null', () => {
    const ws = {} as WebSocket;
    const { unmount } = renderHook(() => useTrackingUplink(ws, 'beh-1', null, true));
    // No throw — passes by not crashing.
    unmount();
  });

  it('wires camera.onResult when active, ws, behaviorId, and camera are set', () => {
    const camera: FakeCameraCapture = { onResult: null };
    const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;

    const { unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-tracking', camera as unknown as null, true)
    );

    expect(camera.onResult).not.toBeNull();
    unmount();
  });

  it('clears camera.onResult on unmount', () => {
    const camera: FakeCameraCapture = { onResult: null };
    const ws = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;

    const { unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-tracking', camera as unknown as null, true)
    );

    expect(camera.onResult).not.toBeNull();
    unmount();
    expect(camera.onResult).toBeNull();
  });

  it('sends tracking_input when onResult is called with ws open', () => {
    const sent: string[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    const camera: FakeCameraCapture = { onResult: null };

    const { unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-cam', camera as unknown as null, true)
    );

    act(() => {
      camera.onResult?.({ pose: [1, 2, 3] });
    });

    expect(sent.length).toBe(1);
    const msg = JSON.parse(sent[0]);
    expect(msg.kind).toBe('tracking_input');
    expect(msg.behaviorId).toBe('beh-cam');
    expect(msg.pose).toEqual([1, 2, 3]);

    unmount();
  });

  it('does not send when ws is not open at callback time', () => {
    const sent: string[] = [];
    const ws = {
      readyState: WebSocket.CONNECTING,
      send: (data: string) => { sent.push(data); },
    } as unknown as WebSocket;
    const camera: FakeCameraCapture = { onResult: null };

    const { unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-cam', camera as unknown as null, true)
    );

    act(() => {
      camera.onResult?.({ pose: [0] });
    });

    expect(sent.length).toBe(0);
    unmount();
  });

  it('re-wires camera.onResult when ws changes', () => {
    const camera: FakeCameraCapture = { onResult: null };
    const ws1 = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    const ws2 = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    let ws: WebSocket = ws1;

    const { rerender, unmount } = renderHook(() =>
      useTrackingUplink(ws, 'beh-cam', camera as unknown as null, true)
    );

    expect(camera.onResult).not.toBeNull();

    ws = ws2;
    rerender();

    // Verify still wired after rerender.
    expect(camera.onResult).not.toBeNull();

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useSharedSubscriptions
// ─────────────────────────────────────────────────────────────────────────────

import { useSharedSubscriptions } from '../src/hooks/useSharedSubscriptions';
import { peerSubscribe } from '../src/api/client';

describe('useSharedSubscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // An earlier describe's afterEach calls vi.restoreAllMocks(), which strips
    // the factory's mockResolvedValue from peerSubscribe (clearAllMocks does
    // not restore implementations). Re-establish it so the hook can .catch().
    vi.mocked(peerSubscribe).mockResolvedValue(undefined);
  });

  it('mounts and unmounts without throwing when no nodes', () => {
    const { unmount } = renderHook(() => useSharedSubscriptions());
    unmount();
  });

  it('does not call peerSubscribe when no remote_object nodes', () => {
    act(() => {
      useEditorStore.getState().addNode({
        id: 'plain-node',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'VRM',
        kind: 'vrm',
        components: {},
      });
    });

    const { unmount } = renderHook(() => useSharedSubscriptions());
    expect(peerSubscribe).not.toHaveBeenCalled();
    unmount();
  });

  it('does not subscribe when owner is not connected', () => {
    act(() => {
      useEditorStore.getState().addNode({
        id: 'remote-1',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Remote',
        kind: 'remote_object',
        components: {
          remoteRef: { ownerPeerId: 'peer-x', remoteObjectId: 'obj-y' },
        },
      });
    });
    // connectedIds is empty — peer-x is not connected.

    const { unmount } = renderHook(() => useSharedSubscriptions());
    expect(peerSubscribe).not.toHaveBeenCalled();
    unmount();
  });

  it('subscribes when remote_object owner is connected and not yet subscribed', async () => {
    act(() => {
      useEditorStore.getState().addNode({
        id: 'remote-2',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Remote',
        kind: 'remote_object',
        components: {
          remoteRef: { ownerPeerId: 'peer-connected', remoteObjectId: 'obj-abc' },
        },
      });
      useConnectionsStore.setState({ connectedIds: ['peer-connected'] });
    });

    const { unmount } = renderHook(() => useSharedSubscriptions());

    // peerSubscribe is async (void promise), give it a tick.
    await act(async () => {
      await Promise.resolve();
    });

    expect(peerSubscribe).toHaveBeenCalledWith(
      'peer-connected',
      'obj-abc',
      expect.any(Boolean)
    );
    unmount();
  });

  it('does not subscribe again when already subscribed', async () => {
    act(() => {
      useEditorStore.getState().addNode({
        id: 'remote-3',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Remote',
        kind: 'remote_object',
        components: {
          remoteRef: { ownerPeerId: 'peer-sub', remoteObjectId: 'obj-already' },
        },
      });
      useConnectionsStore.setState({
        connectedIds: ['peer-sub'],
        subscribed: { 'peer-sub': ['obj-already'] },
      });
    });

    const { unmount } = renderHook(() => useSharedSubscriptions());

    await act(async () => {
      await Promise.resolve();
    });

    expect(peerSubscribe).not.toHaveBeenCalled();
    unmount();
  });

  it('skips nodes without remoteRef ownerPeerId', () => {
    act(() => {
      useEditorStore.getState().addNode({
        id: 'remote-4',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Orphan',
        kind: 'remote_object',
        components: {
          remoteRef: { remoteObjectId: 'obj-z' }, // no ownerPeerId
        },
      });
      useConnectionsStore.setState({ connectedIds: ['anyone'] });
    });

    const { unmount } = renderHook(() => useSharedSubscriptions());
    expect(peerSubscribe).not.toHaveBeenCalled();
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useClientMesh
// ─────────────────────────────────────────────────────────────────────────────

import { useClientMesh } from '../src/hooks/useClientMesh';
import { clientMesh } from '../src/mesh/clientMesh';
import { getConnectionIdentity } from '../src/api/client';

describe('useClientMesh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock for getConnectionIdentity.
    vi.mocked(getConnectionIdentity).mockResolvedValue({ peerId: 'server-peer-1' });
  });

  it('mounts and unmounts without throwing', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    unmount();
  });

  it('calls getConnectionIdentity on mount', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    expect(getConnectionIdentity).toHaveBeenCalled();
    unmount();
  });

  it('calls clientMesh.configure after identity resolves', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    expect(clientMesh.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        selfId: expect.stringContaining('server-peer-1'),
        getWs: expect.any(Function),
        onChange: expect.any(Function),
        onEnvelope: expect.any(Function),
      })
    );
    unmount();
  });

  it('calls clientMesh.sendHello after configure', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    expect(clientMesh.sendHello).toHaveBeenCalled();
    unmount();
  });

  it('calls clientMesh.reset on unmount', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(clientMesh.reset).toHaveBeenCalled();
  });

  it('does not call configure when identity has no peerId', async () => {
    vi.mocked(getConnectionIdentity).mockResolvedValueOnce(
      null as unknown as { peerId: string }
    );

    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });
    expect(clientMesh.configure).not.toHaveBeenCalled();
    unmount();
  });

  it('handles getConnectionIdentity rejection gracefully', async () => {
    vi.mocked(getConnectionIdentity).mockRejectedValueOnce(new Error('offline'));

    let error: Error | null = null;
    try {
      const { unmount } = renderHook(() => useClientMesh());
      await act(async () => { await Promise.resolve(); });
      unmount();
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeNull();
    expect(clientMesh.configure).not.toHaveBeenCalled();
  });

  it('onChange calls setMeshConnected with current peer ids', async () => {
    const { unmount } = renderHook(() => useClientMesh());
    await act(async () => { await Promise.resolve(); });

    // Extract onChange from the configure call.
    const configureCall = vi.mocked(clientMesh.configure).mock.calls[0][0];
    expect(configureCall.onChange).toBeDefined();

    act(() => {
      configureCall.onChange(['peer-a', 'peer-b']);
    });

    expect(useConnectionsStore.getState().meshConnected).toEqual(['peer-a', 'peer-b']);
    unmount();
  });

  it('cancelled flag prevents configure when unmount happens before identity resolves', async () => {
    // Make getConnectionIdentity not resolve immediately.
    let resolveIdentity!: (v: { peerId: string }) => void;
    vi.mocked(getConnectionIdentity).mockReturnValueOnce(
      new Promise((r) => { resolveIdentity = r; })
    );

    const { unmount } = renderHook(() => useClientMesh());
    // Unmount before the promise resolves.
    unmount();
    // Now resolve the identity.
    act(() => { resolveIdentity({ peerId: 'late-peer' }); });
    await act(async () => { await Promise.resolve(); });

    expect(clientMesh.configure).not.toHaveBeenCalled();
  });
});
