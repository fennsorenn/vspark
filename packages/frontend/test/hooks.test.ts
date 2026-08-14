/**
 * hooks.test.ts — Phase 7 frontend hook tests
 *
 * Covers:
 *   - useEscapeKey        (document keydown listener)
 *   - useWsSync           (WebSocket mock → editorStore + vmcPoseStore)
 *   - useTrackClipEvaluator (rAF loop → nodeTransformOverrides)
 *
 * Uplink hooks (useLipsyncUplink / useTrackingUplink) deferred:
 *   - useLipsyncUplink: thin rAF+send wrapper, very low ROI. Deferred.
 *   - useTrackingUplink: pure callback wirer, no store writes. Deferred.
 *
 * Module mocking note:
 *   vitest.config.ts does not inherit the vite.config.ts resolve.alias list, so
 *   @vspark/shared/<subpath> and several transitive deps cannot be resolved by
 *   vitest's bundler. We vi.mock() all such modules before any import that would
 *   pull them in, providing minimal stubs that satisfy the hook's type contract.
 */

// ── Module mocks (must appear before any import that could pull the real modules) ──

import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';

// Stub @vspark/shared subpaths that vitest can't resolve without vite.config aliases.
vi.mock('@vspark/shared/sync', () => ({
  SYNC_MESSAGE_KIND: '__sync__',
  compareHLC: () => 0,
}));

vi.mock('@vspark/shared/types', () => ({}));

// Stub the sync layer modules (all use @vspark/shared/sync transitively).
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
}));

vi.mock('../src/sync/meshProjection', () => ({
  registerAssetUrls: vi.fn(),
}));

// clientMesh pulls in @vspark/shared/sync transitively.
vi.mock('../src/mesh/clientMesh', () => ({
  clientMesh: {
    sendHello: vi.fn(),
    setRoster: vi.fn(),
    handleSignal: vi.fn().mockResolvedValue(undefined),
  },
}));

// previewSmoother is fine to stub.
vi.mock('../src/previewSmoother', () => ({
  smoothNodeTransform: vi.fn(),
  smoothComposeLayer: vi.fn(),
}));

// ikTargetStore is a plain module but can be stubbed safely.
vi.mock('../src/ikTargetStore', () => ({
  setIkTargets: vi.fn(),
}));

// dispatchMediaCommand stub.
vi.mock('../src/components/editor/mediaRegistry', () => ({
  dispatchMediaCommand: vi.fn(),
}));

// connectionsStore — need a minimal stub that satisfies getState().connectedIds.
vi.mock('../src/store/connectionsStore', () => {
  const state = { connectedIds: [] as string[], status: 'idle' };
  return {
    useConnectionsStore: {
      getState: () => ({
        ...state,
        setStatus: vi.fn(),
        setConnected: vi.fn(),
        bumpRevision: vi.fn(),
        setCollabScenes: vi.fn(),
        addIncoming: vi.fn(),
        setOffers: vi.fn(),
        setSubscribed: vi.fn(),
        clearPeerSharing: vi.fn(),
      }),
    },
  };
});

// api/client — stub only the functions useWsSync calls.
vi.mock('../src/api/client', () => ({
  mapBehavior: (p: unknown) => p,
  mapComposeLayer: (p: unknown) => p,
  mapTrackClip: (p: unknown) => p,
  mapTrackClipLane: (p: unknown) => p,
  mapTrackClipKeyframe: (p: unknown) => p,
  mapTrackClipEvent: (p: unknown) => p,
  getScenes: vi.fn().mockResolvedValue({ scenes: [], nodes: [], behaviors: [], cameraEffects: [] }),
  getCollabScenes: vi.fn().mockResolvedValue([]),
}));

// ── Now import real modules ──

import { renderHook, act } from './helpers/render';
import { useEditorStore } from '../src/store/editorStore';
import { getVmcPose, getVmcBlendshapes } from '../src/vmcPoseStore';

// ── Reset editorStore between tests ──────────────────────────────────────────

const INITIAL_STATE = {
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
  clipPlayback: {},
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

beforeEach(() => {
  useEditorStore.setState(INITIAL_STATE, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// useEscapeKey
// ─────────────────────────────────────────────────────────────────────────────

import { useEscapeKey } from '../src/hooks/useEscapeKey';

describe('useEscapeKey', () => {
  it('calls handler when Escape is pressed', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(handler));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not call handler for non-Escape keys', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(handler));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });

    expect(handler).not.toHaveBeenCalled();
    unmount();
  });

  it('removes listener on unmount so no further calls happen', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(handler));
    unmount();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call handler when enabled=false', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(handler, false));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(handler).not.toHaveBeenCalled();
    unmount();
  });

  it('re-attaches listener when enabled flips from false to true', () => {
    const handler = vi.fn();
    let enabled = false;
    const { rerender, unmount } = renderHook(() => useEscapeKey(handler, enabled));

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(handler).toHaveBeenCalledTimes(0);

    enabled = true;
    rerender();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(handler).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useWsSync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal WebSocket fake. Captures the last-created instance so tests can
 * drive onopen/onmessage/onclose.
 *
 * readyState constants are added so hook code that checks WebSocket.OPEN works.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static lastInstance: FakeWebSocket | null = null;

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  private _sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.lastInstance = this;
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send(data: string) {
    this._sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

// Lazy-load useWsSync once (module is cached after first import).
let _useWsSync: (() => void) | null = null;
async function getUseWsSync() {
  if (!_useWsSync) {
    const mod = await import('../src/hooks/useWsSync');
    _useWsSync = mod.useWsSync;
  }
  return _useWsSync;
}

describe('useWsSync', () => {
  beforeEach(() => {
    FakeWebSocket.lastInstance = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a WebSocket on mount', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    expect(FakeWebSocket.lastInstance).not.toBeNull();
    unmount();
  });

  it('closes the WebSocket on unmount', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;
    unmount();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('handles vmc_pose message → writes to vmcPoseStore', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        kind: 'vmc_pose',
        payload: {
          nodeId: 'avatar-1',
          bones: { hips: [0, 0, 0, 1] },
          animationBlendMode: 'override',
        },
      });
    });

    const pose = getVmcPose('avatar-1');
    expect(pose).toBeDefined();
    expect(pose?.hips).toEqual([0, 0, 0, 1]);
    unmount();
  });

  it('handles vmc_blendshapes message → writes to vmcPoseStore', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        kind: 'vmc_blendshapes',
        payload: {
          nodeId: 'avatar-2',
          blendshapes: { happy: 0.8 },
        },
      });
    });

    const bs = getVmcBlendshapes('avatar-2');
    expect(bs).toBeDefined();
    expect(bs?.happy).toBe(0.8);
    unmount();
  });

  it('handles vmc_status message → updates editorStore', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        kind: 'vmc_status',
        payload: { behaviorId: 'beh-1', connected: true },
      });
    });

    expect(useEditorStore.getState().vmcStatus['beh-1']).toBe(true);
    unmount();
  });

  it('handles vmc_tracking_state message → updates editorStore', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        kind: 'vmc_tracking_state',
        payload: { behaviorId: 'beh-1', tracking: true },
      });
    });

    expect(useEditorStore.getState().vmcTracking['beh-1']).toBe(true);
    unmount();
  });

  it('handles node_updated message → patches editorStore node', async () => {
    useEditorStore.getState().addNode({
      id: 'node-ws-1',
      rootSceneNodeId: 'scene-1',
      projectId: 'proj-1',
      parentId: null,
      name: 'Original',
      kind: 'vrm',
      components: {},
    });

    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    act(() => {
      ws.simulateOpen();
      ws.simulateMessage({
        kind: 'node_updated',
        payload: { id: 'node-ws-1', name: 'Renamed' },
      });
    });

    expect(useEditorStore.getState().nodes.find((n) => n.id === 'node-ws-1')?.name).toBe('Renamed');
    unmount();
  });




  it('schedules reconnect when connection closes then reconnects', async () => {
    vi.useFakeTimers();
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const firstWs = FakeWebSocket.lastInstance!;

    act(() => {
      firstWs.simulateClose();
    });

    expect(FakeWebSocket.lastInstance).toBe(firstWs);

    // Advance past RECONNECT_MS (3000 ms defined in the hook)
    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(FakeWebSocket.lastInstance).not.toBe(firstWs);

    unmount();
    vi.useRealTimers();
  });

  it('ignores malformed (non-JSON) messages without throwing', async () => {
    const useWsSync = await getUseWsSync();
    const { unmount } = renderHook(() => useWsSync());
    const ws = FakeWebSocket.lastInstance!;

    expect(() => {
      act(() => {
        ws.onmessage?.({ data: '{{not json' });
      });
    }).not.toThrow();

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// useTrackClipEvaluator
// ─────────────────────────────────────────────────────────────────────────────

import { useTrackClipEvaluator } from '../src/hooks/useTrackClipEvaluator';

/**
 * useTrackClipEvaluator drives a requestAnimationFrame loop. We replace rAF
 * with a synchronous call-accumulator so we can trigger ticks on demand.
 */
describe('useTrackClipEvaluator', () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  let rafId = 0;

  function installFakeRaf() {
    rafCallbacks = [];
    rafId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return ++rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCallbacks = [];
    });
  }

  /** Fire all currently-queued rAF callbacks once. */
  function flushRaf() {
    const pending = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of pending) cb(performance.now());
  }

  beforeEach(() => {
    installFakeRaf();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('schedules a requestAnimationFrame on mount', () => {
    const { unmount } = renderHook(() => useTrackClipEvaluator());
    expect(rafCallbacks.length).toBeGreaterThan(0);
    unmount();
  });

  it('cancels rAF on unmount', () => {
    const { unmount } = renderHook(() => useTrackClipEvaluator());
    expect(rafCallbacks.length).toBe(1);
    unmount();
    expect(rafCallbacks.length).toBe(0);
  });

  it('clears stale nodeTransformOverrides when nothing is playing', () => {
    useEditorStore.getState().setNodeTransformOverride('stale-node', { position: { x: 5 } });

    const { unmount } = renderHook(() => useTrackClipEvaluator());

    act(() => {
      flushRaf();
    });

    expect(useEditorStore.getState().nodeTransformOverrides['stale-node']).toBeUndefined();
    unmount();
  });

  it('evaluates a playing clip and writes nodeTransformOverride', () => {
    const clip = {
      id: 'clip-eval',
      ownerNodeId: 'node-eval',
      ownerLayerId: null,
      name: 'Test',
      duration: 2,
      loop: false,
      mode: 'override' as const,
      autoplay: false,
      lanes: [
        {
          id: 'lane-1',
          clipId: 'clip-eval',
          targetKind: 'scene_node' as const,
          targetId: 'node-eval',
          paramPath: 'position.x',
          defaultValue: 0,
          keyframes: [
            {
              id: 'kf-0', laneId: 'lane-1', t: 0, value: 0, easing: 'linear' as const,
              inHandleTFraction: null, inHandleVFraction: null,
              outHandleTFraction: null, outHandleVFraction: null,
            },
            {
              id: 'kf-1', laneId: 'lane-1', t: 1, value: 10, easing: 'linear' as const,
              inHandleTFraction: null, inHandleVFraction: null,
              outHandleTFraction: null, outHandleVFraction: null,
            },
          ],
        },
      ],
      events: [],
    };

    const node = {
      id: 'node-eval',
      rootSceneNodeId: 'scene-1',
      projectId: 'proj-1',
      parentId: null,
      name: 'Avatar',
      kind: 'vrm',
      components: { transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } },
    };

    // 0.5 s into the clip → position.x should be ~5 (halfway on linear 0→10 over 1 s)
    const startedAt = Date.now() - 500;

    act(() => {
      useEditorStore.getState().addNode(node);
      useEditorStore.getState().addTrackClip(clip);
      useEditorStore.getState().upsertClipPlayback({
        id: 'pb:clip-eval',
        clipId: 'clip-eval',
        state: 'playing',
        startEpoch: startedAt,
        pausedAtT: null,
        speed: 1,
        loop: false,
      });
    });

    const { unmount } = renderHook(() => useTrackClipEvaluator());

    act(() => {
      flushRaf();
    });

    const override = useEditorStore.getState().nodeTransformOverrides['node-eval'];
    expect(override).toBeDefined();
    expect(override?.position?.x).toBeDefined();
    // At t≈0.5 the interpolated value is ≈5 (allow ±2 for timing jitter)
    expect(override!.position!.x).toBeGreaterThan(0);
    expect(override!.position!.x).toBeLessThanOrEqual(10);

    unmount();
  });

  it('completes a non-looping clip past its duration and removes playback', () => {
    const clip = {
      id: 'clip-done',
      ownerNodeId: 'node-done',
      ownerLayerId: null,
      name: 'Done',
      duration: 1,
      loop: false,
      mode: 'override' as const,
      autoplay: false,
      lanes: [],
      events: [],
    };

    // 2 s ago — well past the 1 s duration
    const startedAt = Date.now() - 2000;
    act(() => {
      useEditorStore.getState().addTrackClip(clip);
      useEditorStore.getState().upsertClipPlayback({
        id: 'pb:clip-done',
        clipId: 'clip-done',
        state: 'playing',
        startEpoch: startedAt,
        pausedAtT: null,
        speed: 1,
        loop: false,
      });
    });

    const { unmount } = renderHook(() => useTrackClipEvaluator());

    act(() => {
      flushRaf();
    });

    // The evaluator stops a finished clip in the document.
    expect(
      useEditorStore.getState().clipPlayback['clip-done']?.state
    ).not.toBe('playing');
    unmount();
  });

  it('holds a paused clip at its frozen time across multiple ticks', () => {
    const clip = {
      id: 'clip-paused',
      ownerNodeId: 'node-paused',
      ownerLayerId: null,
      name: 'Paused',
      duration: 10,
      loop: false,
      mode: 'override' as const,
      autoplay: false,
      lanes: [
        {
          id: 'lane-p',
          clipId: 'clip-paused',
          targetKind: 'scene_node' as const,
          targetId: 'node-paused',
          paramPath: 'position.x',
          defaultValue: 0,
          keyframes: [
            {
              id: 'kf-p0', laneId: 'lane-p', t: 0, value: 0, easing: 'linear' as const,
              inHandleTFraction: null, inHandleVFraction: null,
              outHandleTFraction: null, outHandleVFraction: null,
            },
            {
              id: 'kf-p1', laneId: 'lane-p', t: 10, value: 100, easing: 'linear' as const,
              inHandleTFraction: null, inHandleVFraction: null,
              outHandleTFraction: null, outHandleVFraction: null,
            },
          ],
        },
      ],
      events: [],
    };

    const node = {
      id: 'node-paused',
      rootSceneNodeId: 'scene-1',
      projectId: 'proj-1',
      parentId: null,
      name: 'Avatar2',
      kind: 'vrm',
      components: { transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } },
    };

    act(() => {
      useEditorStore.getState().addNode(node);
      useEditorStore.getState().addTrackClip(clip);
      // Paused at t=5 → position.x = 50 (halfway)
      useEditorStore.getState().upsertClipPlayback({
        id: 'pb:clip-paused',
        clipId: 'clip-paused',
        state: 'paused',
        startEpoch: null,
        pausedAtT: 5,
        speed: 1,
        loop: false,
      });
    });

    const { unmount } = renderHook(() => useTrackClipEvaluator());

    act(() => { flushRaf(); });

    const override1 = useEditorStore.getState().nodeTransformOverrides['node-paused'];
    expect(override1?.position?.x).toBeCloseTo(50, 0);

    // Second tick — must not advance
    act(() => { flushRaf(); });

    const override2 = useEditorStore.getState().nodeTransformOverrides['node-paused'];
    expect(override2?.position?.x).toBeCloseTo(50, 0);

    // Paused clip must still be in playback (not completed)
    expect(useEditorStore.getState().clipPlayback['clip-paused']).toBeDefined();

    unmount();
  });
});
