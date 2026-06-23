/**
 * Phase 7 — frontend non-visual coverage: small Zustand / plain-module stores.
 *
 * These stores are pure state with no DOM/Three.js/R3F deps, so they run fine
 * under jsdom.  Each describe block resets relevant state in beforeEach so tests
 * are fully independent.
 */
import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// ikTargetStore — plain Maps (no Zustand)
// ---------------------------------------------------------------------------
import {
  getIkTargets,
  getIkTargetsTime,
  setIkTargets,
} from '../src/ikTargetStore';

// The module uses module-level Maps; we can't reset them without reaching in,
// so we use unique nodeIds per test instead.
describe('ikTargetStore', () => {
  it('returns undefined for an unknown nodeId', () => {
    expect(getIkTargets('nonexistent')).toBeUndefined();
  });

  it('returns null timestamp for an unknown nodeId', () => {
    expect(getIkTargetsTime('nonexistent')).toBeNull();
  });

  it('stores and retrieves an IkTargetFrame', () => {
    const frame = {
      nodeId: 'node-ik-1',
      referenceBone: 'hips',
      targets: [],
    };
    setIkTargets('node-ik-1', frame);
    const result = getIkTargets('node-ik-1');
    expect(result).toBeDefined();
    expect(result!.referenceBone).toBe('hips');
    expect(result!.nodeId).toBe('node-ik-1');
  });

  it('stamps the nodeId onto the frame even if caller omits it', () => {
    const frameWithoutId = {
      nodeId: '',
      referenceBone: 'hips',
      targets: [],
    };
    setIkTargets('node-ik-stamp', frameWithoutId);
    const result = getIkTargets('node-ik-stamp');
    expect(result!.nodeId).toBe('node-ik-stamp');
  });

  it('records a timestamp on set', () => {
    const before = Date.now();
    setIkTargets('node-ik-time', {
      nodeId: 'node-ik-time',
      referenceBone: 'hips',
      targets: [],
    });
    const after = Date.now();
    const t = getIkTargetsTime('node-ik-time');
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(before);
    expect(t!).toBeLessThanOrEqual(after);
  });

  it('overwrites a previously stored frame', () => {
    setIkTargets('node-ik-overwrite', {
      nodeId: 'node-ik-overwrite',
      referenceBone: 'hips',
      targets: [],
    });
    setIkTargets('node-ik-overwrite', {
      nodeId: 'node-ik-overwrite',
      referenceBone: 'chest',
      targets: [],
    });
    expect(getIkTargets('node-ik-overwrite')!.referenceBone).toBe('chest');
  });
});

// ---------------------------------------------------------------------------
// vmcPoseStore — plain Maps (no Zustand)
// ---------------------------------------------------------------------------
import {
  getVmcBlendshapes,
  getVmcPose,
  getVmcPoseBlendMode,
  getVmcPoseTime,
  setVmcBlendshapes,
  setVmcPose,
} from '../src/vmcPoseStore';

describe('vmcPoseStore', () => {
  it('returns undefined for an unknown pose nodeId', () => {
    expect(getVmcPose('unknown-vmc')).toBeUndefined();
  });

  it('returns null for an unknown timestamp', () => {
    expect(getVmcPoseTime('unknown-vmc')).toBeNull();
  });

  it('defaults blend mode to "override" for an unknown nodeId', () => {
    expect(getVmcPoseBlendMode('unknown-vmc')).toBe('override');
  });

  it('stores and retrieves bone rotations', () => {
    const bones = { hips: [0, 0, 0, 1] as [number, number, number, number] };
    setVmcPose('vmc-1', bones);
    expect(getVmcPose('vmc-1')).toEqual(bones);
  });

  it('defaults blend mode to override when not supplied', () => {
    setVmcPose('vmc-default-mode', { spine: [0, 0, 0, 1] });
    expect(getVmcPoseBlendMode('vmc-default-mode')).toBe('override');
  });

  it('stores explicit blend mode', () => {
    setVmcPose('vmc-additive', { spine: [0, 0, 0, 1] }, 'additive');
    expect(getVmcPoseBlendMode('vmc-additive')).toBe('additive');
  });

  it('records a timestamp on setVmcPose', () => {
    const before = Date.now();
    setVmcPose('vmc-time', { head: [0, 0, 0, 1] });
    const after = Date.now();
    const t = getVmcPoseTime('vmc-time');
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(before);
    expect(t!).toBeLessThanOrEqual(after);
  });

  it('stores and retrieves blendshapes', () => {
    setVmcBlendshapes('vmc-bs', { happy: 0.8, angry: 0.1 });
    expect(getVmcBlendshapes('vmc-bs')).toEqual({ happy: 0.8, angry: 0.1 });
  });

  it('returns undefined for unknown blendshapes', () => {
    expect(getVmcBlendshapes('vmc-bs-unknown')).toBeUndefined();
  });

  it('overwrites existing pose', () => {
    setVmcPose('vmc-overwrite', { hips: [0, 0, 0, 1] });
    setVmcPose('vmc-overwrite', { hips: [0.1, 0.2, 0.3, 0.9] });
    expect(getVmcPose('vmc-overwrite')!['hips']).toEqual([0.1, 0.2, 0.3, 0.9]);
  });
});

// ---------------------------------------------------------------------------
// connectionsStore — Zustand store
// ---------------------------------------------------------------------------
import {
  canWriteObject,
  useConnectionsStore,
} from '../src/store/connectionsStore';
import type { ConnectionPeer } from '../src/api/client';

const INITIAL_CONNECTIONS = {
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
  useConnectionsStore.setState(INITIAL_CONNECTIONS);
});

describe('connectionsStore — initial state', () => {
  it('starts with idle status and empty collections', () => {
    const s = useConnectionsStore.getState();
    expect(s.status).toBe('idle');
    expect(s.enabled).toBe(false);
    expect(s.identityPeerId).toBeNull();
    expect(s.peers).toHaveLength(0);
    expect(s.connectedIds).toHaveLength(0);
    expect(s.revision).toBe(0);
  });
});

describe('connectionsStore — setMeta', () => {
  it('sets enabled, status, and identityPeerId', () => {
    useConnectionsStore.getState().setMeta({
      enabled: true,
      status: 'ready',
      identityPeerId: 'peer-abc',
    });
    const s = useConnectionsStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.status).toBe('ready');
    expect(s.identityPeerId).toBe('peer-abc');
  });
});

describe('connectionsStore — setStatus', () => {
  it('updates only the status field', () => {
    useConnectionsStore.getState().setStatus('connecting');
    expect(useConnectionsStore.getState().status).toBe('connecting');
  });
});

describe('connectionsStore — setPeers', () => {
  const makePeer = (id: string, connected: boolean): ConnectionPeer => ({
    peerId: id,
    publicKey: 'key',
    displayName: `Display ${id}`,
    pairedAt: '2024-01-01',
    lastSeen: null,
    blocked: false,
    sessionGranted: false,
    connected,
  });

  it('populates peers, connectedIds, and nameById', () => {
    const peers = [makePeer('p1', true), makePeer('p2', false)];
    useConnectionsStore.getState().setPeers(peers);
    const s = useConnectionsStore.getState();
    expect(s.peers).toHaveLength(2);
    expect(s.connectedIds).toEqual(['p1']);
    expect(s.nameById['p1']).toBe('Display p1');
    expect(s.nameById['p2']).toBe('Display p2');
  });

  it('falls back to truncated peerId when displayName is empty', () => {
    const peer: ConnectionPeer = {
      peerId: 'longpeerid123',
      publicKey: 'k',
      displayName: '',
      pairedAt: '',
      lastSeen: null,
      blocked: false,
      sessionGranted: false,
      connected: false,
    };
    useConnectionsStore.getState().setPeers([peer]);
    expect(useConnectionsStore.getState().nameById['longpeerid123']).toBe(
      'longpeer'
    );
  });
});

describe('connectionsStore — setConnected', () => {
  it('adds a peerId to connectedIds', () => {
    useConnectionsStore.getState().setConnected('peer-x', true, 'Alice');
    const s = useConnectionsStore.getState();
    expect(s.connectedIds).toContain('peer-x');
    expect(s.nameById['peer-x']).toBe('Alice');
  });

  it('does not duplicate an already-connected peer', () => {
    useConnectionsStore.getState().setConnected('peer-x', true);
    useConnectionsStore.getState().setConnected('peer-x', true);
    expect(useConnectionsStore.getState().connectedIds).toHaveLength(1);
  });

  it('removes a peerId on disconnect', () => {
    useConnectionsStore.getState().setConnected('peer-y', true);
    useConnectionsStore.getState().setConnected('peer-y', false);
    expect(useConnectionsStore.getState().connectedIds).not.toContain('peer-y');
  });
});

describe('connectionsStore — incoming requests', () => {
  it('addIncoming adds a request', () => {
    useConnectionsStore
      .getState()
      .addIncoming({ peerId: 'p1', displayName: 'Alice' });
    expect(useConnectionsStore.getState().incoming).toHaveLength(1);
  });

  it('addIncoming deduplicates by peerId', () => {
    useConnectionsStore
      .getState()
      .addIncoming({ peerId: 'p1', displayName: 'Alice' });
    useConnectionsStore
      .getState()
      .addIncoming({ peerId: 'p1', displayName: 'Alice Again' });
    expect(useConnectionsStore.getState().incoming).toHaveLength(1);
  });

  it('removeIncoming removes the correct request', () => {
    useConnectionsStore
      .getState()
      .addIncoming({ peerId: 'p1', displayName: 'Alice' });
    useConnectionsStore
      .getState()
      .addIncoming({ peerId: 'p2', displayName: 'Bob' });
    useConnectionsStore.getState().removeIncoming('p1');
    const incoming = useConnectionsStore.getState().incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0].peerId).toBe('p2');
  });
});

describe('connectionsStore — offers and subscribed', () => {
  it('setOffers stores offers for a peer', () => {
    useConnectionsStore.getState().setOffers('peer-a', [
      { objectId: 'obj-1', shareKind: 'object', name: 'Thing' },
    ]);
    expect(useConnectionsStore.getState().offers['peer-a']).toHaveLength(1);
  });

  it('setSubscribed adds an objectId subscription', () => {
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', true);
    expect(
      useConnectionsStore.getState().subscribed['peer-a']
    ).toContain('obj-1');
  });

  it('setSubscribed does not duplicate', () => {
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', true);
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', true);
    expect(
      useConnectionsStore.getState().subscribed['peer-a']
    ).toHaveLength(1);
  });

  it('setSubscribed removes with on=false', () => {
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', true);
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', false);
    expect(
      useConnectionsStore.getState().subscribed['peer-a'] ?? []
    ).not.toContain('obj-1');
  });

  it('clearPeerSharing removes offers and subscriptions for a peer', () => {
    useConnectionsStore.getState().setOffers('peer-a', [
      { objectId: 'obj-1', shareKind: 'object', name: 'Thing' },
    ]);
    useConnectionsStore.getState().setSubscribed('peer-a', 'obj-1', true);
    useConnectionsStore.getState().clearPeerSharing('peer-a');
    const s = useConnectionsStore.getState();
    expect(s.offers['peer-a']).toBeUndefined();
    expect(s.subscribed['peer-a']).toBeUndefined();
  });
});

describe('connectionsStore — meshConnected and collabScenes', () => {
  it('setMeshConnected replaces the list', () => {
    useConnectionsStore.getState().setMeshConnected(['mc-1', 'mc-2']);
    expect(useConnectionsStore.getState().meshConnected).toEqual([
      'mc-1',
      'mc-2',
    ]);
  });

  it('setCollabScenes builds a map keyed by sceneId', () => {
    useConnectionsStore.getState().setCollabScenes([
      { sceneId: 'scene-1', peerId: 'peer-a', role: 'author' },
      { sceneId: 'scene-2', peerId: 'peer-b', role: 'mounted' },
    ]);
    const cs = useConnectionsStore.getState().collabScenes;
    expect(cs['scene-1']).toEqual({ peerId: 'peer-a', role: 'author' });
    expect(cs['scene-2']).toEqual({ peerId: 'peer-b', role: 'mounted' });
  });
});

describe('connectionsStore — bumpRevision', () => {
  it('increments revision each call', () => {
    useConnectionsStore.getState().bumpRevision();
    useConnectionsStore.getState().bumpRevision();
    expect(useConnectionsStore.getState().revision).toBe(2);
  });
});

describe('canWriteObject', () => {
  beforeEach(() => {
    useConnectionsStore.setState(INITIAL_CONNECTIONS);
  });

  it('returns false when no offers exist', () => {
    expect(canWriteObject('peer-x', 'obj-1')).toBe(false);
  });

  it('returns false when offer has no canWrite', () => {
    useConnectionsStore.getState().setOffers('peer-x', [
      { objectId: 'obj-1', shareKind: 'object', name: 'Thing' },
    ]);
    expect(canWriteObject('peer-x', 'obj-1')).toBe(false);
  });

  it('returns true when offer has canWrite=true', () => {
    useConnectionsStore.getState().setOffers('peer-x', [
      { objectId: 'obj-1', shareKind: 'object', name: 'Thing', canWrite: true },
    ]);
    expect(canWriteObject('peer-x', 'obj-1')).toBe(true);
  });

  it('returns false when objectId is not in the offer list', () => {
    useConnectionsStore.getState().setOffers('peer-x', [
      { objectId: 'obj-2', shareKind: 'object', name: 'Other', canWrite: true },
    ]);
    expect(canWriteObject('peer-x', 'obj-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helpStore — Zustand store
// ---------------------------------------------------------------------------
import { useHelpStore } from '../src/help/helpStore';

const INITIAL_HELP = { open: false, topic: null, anchor: null };

beforeEach(() => {
  useHelpStore.setState(INITIAL_HELP);
});

describe('helpStore — initial state', () => {
  it('starts closed with no topic or anchor', () => {
    const s = useHelpStore.getState();
    expect(s.open).toBe(false);
    expect(s.topic).toBeNull();
    expect(s.anchor).toBeNull();
  });
});

describe('helpStore — openHelp', () => {
  it('opens the window and sets topic', () => {
    useHelpStore.getState().openHelp('scene-graph');
    const s = useHelpStore.getState();
    expect(s.open).toBe(true);
    expect(s.topic).toBe('scene-graph');
    expect(s.anchor).toBeNull();
  });

  it('sets an anchor when provided', () => {
    useHelpStore.getState().openHelp('scene-graph', 'adding-nodes');
    expect(useHelpStore.getState().anchor).toBe('adding-nodes');
  });

  it('null anchor is the default when openHelp omits second arg', () => {
    useHelpStore.getState().openHelp('faq');
    expect(useHelpStore.getState().anchor).toBeNull();
  });
});

describe('helpStore — goTo', () => {
  it('changes topic without altering open flag', () => {
    useHelpStore.getState().openHelp('scene-graph');
    useHelpStore.getState().goTo('vmc-receiver', 'calibration');
    const s = useHelpStore.getState();
    expect(s.open).toBe(true);
    expect(s.topic).toBe('vmc-receiver');
    expect(s.anchor).toBe('calibration');
  });

  it('can be called when already closed (does not force open)', () => {
    useHelpStore.getState().goTo('faq');
    expect(useHelpStore.getState().open).toBe(false);
    expect(useHelpStore.getState().topic).toBe('faq');
  });
});

describe('helpStore — closeHelp', () => {
  it('sets open to false', () => {
    useHelpStore.getState().openHelp('faq');
    useHelpStore.getState().closeHelp();
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('preserves topic after close (keeps context for re-open)', () => {
    useHelpStore.getState().openHelp('scene-graph', 'anchoring');
    useHelpStore.getState().closeHelp();
    const s = useHelpStore.getState();
    // open is false but topic/anchor are not cleared by closeHelp
    expect(s.topic).toBe('scene-graph');
  });
});

// ---------------------------------------------------------------------------
// clipboard.ts — pure helpers (no navigator.clipboard involved)
// ---------------------------------------------------------------------------
import {
  copyToClipboard,
  parseClipboardJson,
  pasteFromClipboard,
} from '../src/clipboard';

describe('clipboard — parseClipboardJson', () => {
  it('returns null for an empty string', () => {
    expect(parseClipboardJson('')).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(parseClipboardJson('hello world')).toBeNull();
  });

  it('returns null when the vspark wrapper tag is missing', () => {
    const json = JSON.stringify({ vspark: 'other.tag', payload: {} });
    expect(parseClipboardJson(json)).toBeNull();
  });

  it('returns null when payload has no kind', () => {
    const json = JSON.stringify({
      vspark: 'vspark.clipboard.v1',
      payload: { data: 1 },
    });
    expect(parseClipboardJson(json)).toBeNull();
  });

  it('parses a valid graph-nodes payload', () => {
    const payload = { kind: 'graph-nodes', nodes: [], edges: [] };
    const json = JSON.stringify({ vspark: 'vspark.clipboard.v1', payload });
    const result = parseClipboardJson(json);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('graph-nodes');
  });

  it('parses a valid scene-node payload', () => {
    const payload = {
      kind: 'scene-node',
      preset: { name: 'My Node', kind: 'avatar', components: [] },
    };
    const json = JSON.stringify({ vspark: 'vspark.clipboard.v1', payload });
    const result = parseClipboardJson(json);
    expect(result!.kind).toBe('scene-node');
  });
});

describe('clipboard — pasteFromClipboard (in-memory path)', () => {
  it('returns the in-memory clipboard payload when set', async () => {
    const payload = { kind: 'graph-nodes' as const, nodes: [], edges: [] };
    const result = await pasteFromClipboard(payload);
    expect(result).toBe(payload);
  });

  it('returns null from memory when memory is null (OS path would be tried, returns null in jsdom)', async () => {
    // navigator.clipboard is not available in jsdom without mocking;
    // pasteFromClipboard falls through to readClipboard which catches and returns null.
    const result = await pasteFromClipboard(null);
    expect(result).toBeNull();
  });
});

describe('clipboard — copyToClipboard (pure side-effects path)', () => {
  it('calls the memory setter and returns the payload', async () => {
    const payload = { kind: 'graph-nodes' as const, nodes: [], edges: [] };
    let memValue: unknown = null;
    const setter = (p: unknown) => {
      memValue = p;
    };
    const result = await copyToClipboard(payload, setter as never);
    expect(result).toBe(payload);
    expect(memValue).toBe(payload);
    // OS clipboard write is best-effort; failure is swallowed in writeClipboard.
  });
});
