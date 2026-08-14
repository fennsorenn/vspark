/**
 * editorStore.test.ts — Phase 7 frontend non-visual coverage
 *
 * Tests the Zustand editorStore outside React: call actions via getState(),
 * assert transitions via getState(). State is fully reset between tests with
 * setState(<initial-shape>, true).
 *
 * No Three.js / R3F / React Testing Library needed — the store imports only
 * pure TypeScript (api/client, @vspark/shared), which jsdom handles fine.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import type {
  StageObject,
  SceneItem,
  Behavior,
} from '../src/store/editorStore';
import type { CameraEffectRecord, TrackClipRecord } from '../src/api/client';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal initial state matching the store's create() defaults. */
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

function makeNode(overrides: Partial<StageObject> = {}): StageObject {
  return {
    id: 'node-1',
    rootSceneNodeId: 'scene-1',
    projectId: 'proj-1',
    parentId: null,
    name: 'My Node',
    kind: 'vrm',
    components: {},
    ...overrides,
  };
}

function makeScene(overrides: Partial<SceneItem> = {}): SceneItem {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    runtimeSettings: {},
    ...overrides,
  };
}

function makeBehavior(overrides: Partial<Behavior> = {}): Behavior {
  return {
    id: 'beh-1',
    nodeId: 'node-1',
    kind: 'vmc_receiver',
    enabled: true,
    config: {},
    ...overrides,
  };
}

function makeCameraEffect(overrides: Partial<CameraEffectRecord> = {}): CameraEffectRecord {
  return {
    id: 'fx-1',
    nodeId: 'node-1',
    kind: 'fx_bloom',
    enabled: true,
    config: {},
    ...overrides,
  };
}

function makeTrackClip(overrides: Partial<TrackClipRecord> = {}): TrackClipRecord {
  return {
    id: 'clip-1',
    ownerNodeId: 'node-1',
    ownerLayerId: null,
    name: 'Clip 1',
    duration: 2,
    loop: false,
    mode: 'override',
    autoplay: false,
    lanes: [],
    events: [],
    ...overrides,
  };
}

// ── reset between every test ──────────────────────────────────────────────────
// We use replace=false (the default) so action functions defined in the store
// are preserved. Only data slices need resetting.

beforeEach(() => {
  useEditorStore.setState(INITIAL_STATE, false);
});

// ── Project ───────────────────────────────────────────────────────────────────

describe('setProject', () => {
  test('writes projectId and projectName', () => {
    useEditorStore.getState().setProject('proj-42', 'My Project');
    const { projectId, projectName } = useEditorStore.getState();
    expect(projectId).toBe('proj-42');
    expect(projectName).toBe('My Project');
  });
});

// ── Scenes ────────────────────────────────────────────────────────────────────

describe('setScenes / setActiveScene / updateSceneItem / removeScene', () => {
  test('setScenes replaces the list', () => {
    const s1 = makeScene({ id: 'scene-1' });
    const s2 = makeScene({ id: 'scene-2', name: 'Scene 2' });
    useEditorStore.getState().setScenes([s1, s2]);
    expect(useEditorStore.getState().scenes).toHaveLength(2);
  });

  test('setActiveScene sets activeSceneId', () => {
    useEditorStore.getState().setScenes([makeScene()]);
    useEditorStore.getState().setActiveScene('scene-1');
    expect(useEditorStore.getState().activeSceneId).toBe('scene-1');
  });

  test('setActiveScene to null clears selection', () => {
    useEditorStore.getState().setActiveScene('scene-1');
    useEditorStore.getState().setActiveScene(null);
    expect(useEditorStore.getState().activeSceneId).toBeNull();
  });

  test('updateSceneItem patches a scene by id', () => {
    useEditorStore.getState().setScenes([makeScene()]);
    useEditorStore.getState().updateSceneItem('scene-1', { name: 'Renamed' });
    expect(useEditorStore.getState().scenes[0].name).toBe('Renamed');
  });

  test('updateSceneItem is a no-op for unknown id', () => {
    useEditorStore.getState().setScenes([makeScene()]);
    useEditorStore.getState().updateSceneItem('nope', { name: 'X' });
    expect(useEditorStore.getState().scenes[0].name).toBe('Scene 1');
  });

  test('removeScene removes the scene and its nodes', () => {
    const s1 = makeScene({ id: 'scene-1' });
    const s2 = makeScene({ id: 'scene-2', name: 'Scene 2' });
    const n1 = makeNode({ id: 'node-1', rootSceneNodeId: 'scene-1' });
    const n2 = makeNode({ id: 'node-2', rootSceneNodeId: 'scene-2' });
    useEditorStore.getState().setScenes([s1, s2]);
    useEditorStore.getState().setNodes([n1, n2]);
    useEditorStore.getState().setActiveScene('scene-1');
    useEditorStore.getState().removeScene('scene-1');
    const st = useEditorStore.getState();
    expect(st.scenes).toHaveLength(1);
    expect(st.scenes[0].id).toBe('scene-2');
    // Nodes belonging to removed scene are gone
    expect(st.nodes.every((n) => n.rootSceneNodeId !== 'scene-1')).toBe(true);
    // Active scene falls through to next available
    expect(st.activeSceneId).toBe('scene-2');
  });

  test('removeScene falls back to null activeSceneId when no scenes remain', () => {
    useEditorStore.getState().setScenes([makeScene()]);
    useEditorStore.getState().setActiveScene('scene-1');
    useEditorStore.getState().removeScene('scene-1');
    expect(useEditorStore.getState().activeSceneId).toBeNull();
  });
});

describe('setSceneSelected', () => {
  test('sets and clears sceneSelected flag', () => {
    useEditorStore.getState().setSceneSelected(true);
    expect(useEditorStore.getState().sceneSelected).toBe(true);
    useEditorStore.getState().setSceneSelected(false);
    expect(useEditorStore.getState().sceneSelected).toBe(false);
  });
});

// ── Nodes ─────────────────────────────────────────────────────────────────────

describe('addNode / updateNode / deleteNode / selectNode', () => {
  test('addNode appends a new node', () => {
    useEditorStore.getState().addNode(makeNode());
    expect(useEditorStore.getState().nodes).toHaveLength(1);
  });

  test('addNode is idempotent by id', () => {
    useEditorStore.getState().addNode(makeNode());
    useEditorStore.getState().addNode(makeNode()); // same id
    expect(useEditorStore.getState().nodes).toHaveLength(1);
  });

  test('updateNode patches the matching node', () => {
    useEditorStore.getState().addNode(makeNode());
    useEditorStore.getState().updateNode('node-1', { name: 'Updated' });
    expect(useEditorStore.getState().nodes[0].name).toBe('Updated');
  });

  test('updateNode leaves other nodes untouched', () => {
    useEditorStore.getState().addNode(makeNode({ id: 'node-1', name: 'A' }));
    useEditorStore.getState().addNode(makeNode({ id: 'node-2', name: 'B' }));
    useEditorStore.getState().updateNode('node-1', { name: 'A2' });
    expect(useEditorStore.getState().nodes.find((n) => n.id === 'node-2')?.name).toBe('B');
  });

  test('deleteNode removes the node and clears selection', () => {
    useEditorStore.getState().addNode(makeNode());
    useEditorStore.getState().selectNode('node-1');
    expect(useEditorStore.getState().selectedNodeId).toBe('node-1');
    useEditorStore.getState().deleteNode('node-1');
    const st = useEditorStore.getState();
    expect(st.nodes).toHaveLength(0);
    expect(st.selectedNodeId).toBeNull();
  });

  test('deleteNode also removes behaviors attached to that node', () => {
    useEditorStore.getState().addNode(makeNode());
    useEditorStore.getState().addBehavior(makeBehavior({ nodeId: 'node-1' }));
    useEditorStore.getState().deleteNode('node-1');
    expect(useEditorStore.getState().behaviors).toHaveLength(0);
  });

  test('selectNode sets selectedNodeId and clears sceneSelected', () => {
    useEditorStore.getState().setSceneSelected(true);
    useEditorStore.getState().selectNode('node-1');
    const st = useEditorStore.getState();
    expect(st.selectedNodeId).toBe('node-1');
    expect(st.sceneSelected).toBe(false);
  });

  test('selectNode(null) clears selection without touching sceneSelected', () => {
    useEditorStore.getState().setSceneSelected(true);
    useEditorStore.getState().selectNode(null);
    const st = useEditorStore.getState();
    expect(st.selectedNodeId).toBeNull();
    // sceneSelected is NOT touched when clearing node selection
    expect(st.sceneSelected).toBe(true);
  });

  test('selectNode also clears selectedBehaviorId and selectedEffect', () => {
    useEditorStore.getState().selectBehavior('beh-1');
    useEditorStore.getState().selectNode('node-1');
    const st = useEditorStore.getState();
    expect(st.selectedBehaviorId).toBeNull();
    expect(st.selectedEffect).toBeNull();
  });
});

describe('toggleNodeHidden', () => {
  test('flips the hidden flag', () => {
    useEditorStore.getState().addNode(makeNode({ hidden: false }));
    useEditorStore.getState().toggleNodeHidden('node-1');
    expect(useEditorStore.getState().nodes[0].hidden).toBe(true);
    useEditorStore.getState().toggleNodeHidden('node-1');
    expect(useEditorStore.getState().nodes[0].hidden).toBe(false);
  });
});

// ── activeSceneNodes selector ─────────────────────────────────────────────────

describe('activeSceneNodes()', () => {
  test('returns only nodes for the active scene', () => {
    useEditorStore.getState().setScenes([
      makeScene({ id: 'scene-1' }),
      makeScene({ id: 'scene-2' }),
    ]);
    useEditorStore.getState().setActiveScene('scene-1');
    useEditorStore.getState().setNodes([
      makeNode({ id: 'n1', rootSceneNodeId: 'scene-1' }),
      makeNode({ id: 'n2', rootSceneNodeId: 'scene-2' }),
      makeNode({ id: 'n3', rootSceneNodeId: 'scene-1' }),
    ]);
    const active = useEditorStore.getState().activeSceneNodes();
    expect(active.map((n) => n.id)).toEqual(['n1', 'n3']);
  });

  test('returns empty array when no active scene', () => {
    useEditorStore.getState().setNodes([makeNode()]);
    expect(useEditorStore.getState().activeSceneNodes()).toHaveLength(0);
  });
});

// ── Behaviors ─────────────────────────────────────────────────────────────────

describe('behaviors CRUD + behaviorsFor()', () => {
  test('addBehavior appends', () => {
    useEditorStore.getState().addBehavior(makeBehavior());
    expect(useEditorStore.getState().behaviors).toHaveLength(1);
  });

  test('updateBehavior patches the matching behavior', () => {
    useEditorStore.getState().addBehavior(makeBehavior());
    useEditorStore.getState().updateBehavior('beh-1', { enabled: false });
    expect(useEditorStore.getState().behaviors[0].enabled).toBe(false);
  });

  test('removeBehavior removes and clears selectedBehaviorId', () => {
    useEditorStore.getState().addBehavior(makeBehavior());
    useEditorStore.getState().selectBehavior('beh-1');
    useEditorStore.getState().removeBehavior('beh-1');
    const st = useEditorStore.getState();
    expect(st.behaviors).toHaveLength(0);
    expect(st.selectedBehaviorId).toBeNull();
  });

  test('behaviorsFor() filters by nodeId', () => {
    useEditorStore.getState().setBehaviors([
      makeBehavior({ id: 'b1', nodeId: 'node-1' }),
      makeBehavior({ id: 'b2', nodeId: 'node-2' }),
      makeBehavior({ id: 'b3', nodeId: 'node-1' }),
    ]);
    const result = useEditorStore.getState().behaviorsFor('node-1');
    expect(result.map((b) => b.id)).toEqual(['b1', 'b3']);
  });
});

// ── VMC status / tracking ─────────────────────────────────────────────────────

describe('setVmcStatus / setVmcTracking', () => {
  test('setVmcStatus stores connected state per behaviorId', () => {
    useEditorStore.getState().setVmcStatus('beh-1', true);
    useEditorStore.getState().setVmcStatus('beh-2', false);
    const { vmcStatus } = useEditorStore.getState();
    expect(vmcStatus['beh-1']).toBe(true);
    expect(vmcStatus['beh-2']).toBe(false);
  });

  test('setVmcTracking stores tracking state per behaviorId', () => {
    useEditorStore.getState().setVmcTracking('beh-1', true);
    expect(useEditorStore.getState().vmcTracking['beh-1']).toBe(true);
    useEditorStore.getState().setVmcTracking('beh-1', false);
    expect(useEditorStore.getState().vmcTracking['beh-1']).toBe(false);
  });

  // A stale `tracking: true` outliving its behavior keeps consumers believing a
  // tracking source is live — avatars pin to their base animation and can never
  // fall back to idle. The flags must not outlive the behavior that set them.
  test('removeBehavior drops its vmcTracking / vmcStatus entries', () => {
    const st = useEditorStore.getState();
    st.addBehavior(makeBehavior());
    st.setVmcTracking('beh-1', true);
    st.setVmcStatus('beh-1', true);

    useEditorStore.getState().removeBehavior('beh-1');

    const after = useEditorStore.getState();
    expect(after.vmcTracking).not.toHaveProperty('beh-1');
    expect(after.vmcStatus).not.toHaveProperty('beh-1');
  });

  test('setBehaviors prunes flags for behaviors that no longer exist', () => {
    const st = useEditorStore.getState();
    st.setBehaviors([makeBehavior({ id: 'b1' }), makeBehavior({ id: 'b2' })]);
    st.setVmcTracking('b1', true);
    st.setVmcTracking('b2', true);
    st.setVmcStatus('b2', true);

    // Wholesale replace (scene load / preset apply / WS resync) drops b2.
    useEditorStore.getState().setBehaviors([makeBehavior({ id: 'b1' })]);

    const after = useEditorStore.getState();
    expect(after.vmcTracking['b1']).toBe(true); // survivor keeps its flag
    expect(after.vmcTracking).not.toHaveProperty('b2');
    expect(after.vmcStatus).not.toHaveProperty('b2');
  });
});

// ── VRM skeleton registration ─────────────────────────────────────────────────

describe('VRM bones / expressions / morph targets', () => {
  test('setVrmBonesForNode registers bones; clear removes them', () => {
    useEditorStore.getState().setVrmBonesForNode('node-1', ['hips', 'spine']);
    expect(useEditorStore.getState().vrmBonesByNode['node-1']).toEqual(['hips', 'spine']);
    useEditorStore.getState().clearVrmBonesForNode('node-1');
    expect(useEditorStore.getState().vrmBonesByNode['node-1']).toBeUndefined();
  });

  test('setVrmExpressionsForNode registers expressions; clear removes them', () => {
    useEditorStore.getState().setVrmExpressionsForNode('node-1', ['happy', 'sad']);
    expect(useEditorStore.getState().vrmExpressionsByNode['node-1']).toEqual(['happy', 'sad']);
    useEditorStore.getState().clearVrmExpressionsForNode('node-1');
    expect(useEditorStore.getState().vrmExpressionsByNode['node-1']).toBeUndefined();
  });

  test('setVrmMorphTargetsForNode registers morph targets; clear removes them', () => {
    useEditorStore.getState().setVrmMorphTargetsForNode('node-1', ['blink_L', 'blink_R']);
    expect(useEditorStore.getState().vrmMorphTargetsByNode['node-1']).toEqual(['blink_L', 'blink_R']);
    useEditorStore.getState().clearVrmMorphTargetsForNode('node-1');
    expect(useEditorStore.getState().vrmMorphTargetsByNode['node-1']).toBeUndefined();
  });

  test('setHoveredBone stores the hovered bone name', () => {
    useEditorStore.getState().setHoveredBone('leftShoulder');
    expect(useEditorStore.getState().hoveredBoneName).toBe('leftShoulder');
    useEditorStore.getState().setHoveredBone(null);
    expect(useEditorStore.getState().hoveredBoneName).toBeNull();
  });
});

// ── Scheduled animations ──────────────────────────────────────────────────────

describe('upsertScheduledAnimation / removeScheduledAnimation', () => {
  test('upsert inserts and overwrites', () => {
    const entry = {
      id: 'anim-1',
      avatarNodeId: 'node-1',
      clipId: 'clip-1',
      startEpoch: 1000,
      speed: 1,
      loop: false,
    };
    useEditorStore.getState().upsertScheduledAnimation(entry);
    expect(useEditorStore.getState().scheduledAnimations['anim-1']).toEqual(entry);

    useEditorStore.getState().upsertScheduledAnimation({ ...entry, speed: 2 });
    expect(useEditorStore.getState().scheduledAnimations['anim-1'].speed).toBe(2);
  });

  test('removeScheduledAnimation deletes the entry', () => {
    const entry = {
      id: 'anim-1',
      avatarNodeId: 'node-1',
      clipId: 'clip-1',
      startEpoch: 1000,
      speed: 1,
      loop: false,
    };
    useEditorStore.getState().upsertScheduledAnimation(entry);
    useEditorStore.getState().removeScheduledAnimation('anim-1');
    expect(useEditorStore.getState().scheduledAnimations['anim-1']).toBeUndefined();
  });

  test('removeScheduledAnimation is a no-op for unknown id', () => {
    useEditorStore.getState().removeScheduledAnimation('nope');
    expect(Object.keys(useEditorStore.getState().scheduledAnimations)).toHaveLength(0);
  });
});

// ── Animation clips ───────────────────────────────────────────────────────────

describe('upsertAnimationClip / removeAnimationClip', () => {
  test('upsert inserts and overwrites', () => {
    const clip = { id: 'clip-1', sourceNodeId: 'node-1', sourceFilePath: '/a.vrma', duration: 3 };
    useEditorStore.getState().upsertAnimationClip(clip);
    expect(useEditorStore.getState().animationClips['clip-1']).toEqual(clip);
    useEditorStore.getState().upsertAnimationClip({ ...clip, duration: 5 });
    expect(useEditorStore.getState().animationClips['clip-1'].duration).toBe(5);
  });

  test('removeAnimationClip deletes the entry', () => {
    const clip = { id: 'clip-1', sourceNodeId: 'n1', sourceFilePath: '/a.vrma', duration: 2 };
    useEditorStore.getState().upsertAnimationClip(clip);
    useEditorStore.getState().removeAnimationClip('clip-1');
    expect(useEditorStore.getState().animationClips['clip-1']).toBeUndefined();
  });
});

// ── Camera effects ────────────────────────────────────────────────────────────

describe('camera effects CRUD + cameraEffectsFor()', () => {
  test('addCameraEffect appends', () => {
    useEditorStore.getState().addCameraEffect(makeCameraEffect());
    expect(useEditorStore.getState().cameraEffects).toHaveLength(1);
  });

  test('updateCameraEffect patches by id', () => {
    useEditorStore.getState().addCameraEffect(makeCameraEffect());
    useEditorStore.getState().updateCameraEffect('fx-1', { enabled: false });
    expect(useEditorStore.getState().cameraEffects[0].enabled).toBe(false);
  });

  test('removeCameraEffect removes by id', () => {
    useEditorStore.getState().addCameraEffect(makeCameraEffect({ id: 'fx-1' }));
    useEditorStore.getState().addCameraEffect(makeCameraEffect({ id: 'fx-2' }));
    useEditorStore.getState().removeCameraEffect('fx-1');
    expect(useEditorStore.getState().cameraEffects.map((e) => e.id)).toEqual(['fx-2']);
  });

  test('cameraEffectsFor() filters by nodeId', () => {
    useEditorStore.getState().setCameraEffects([
      makeCameraEffect({ id: 'fx-1', nodeId: 'node-1' }),
      makeCameraEffect({ id: 'fx-2', nodeId: 'node-2' }),
    ]);
    expect(useEditorStore.getState().cameraEffectsFor('node-1').map((e) => e.id)).toEqual(['fx-1']);
  });

  test('setPreviewEffectsCamera toggles: same id → null', () => {
    useEditorStore.getState().setPreviewEffectsCamera('node-1');
    expect(useEditorStore.getState().previewEffectsCamera).toBe('node-1');
    useEditorStore.getState().setPreviewEffectsCamera('node-1'); // toggle off
    expect(useEditorStore.getState().previewEffectsCamera).toBeNull();
  });

  test('selectEffect sets effect and clears selectedBehaviorId', () => {
    useEditorStore.getState().selectBehavior('beh-1');
    useEditorStore.getState().selectEffect('node-1', 'fx_bloom');
    const st = useEditorStore.getState();
    expect(st.selectedEffect).toEqual({ nodeId: 'node-1', kind: 'fx_bloom' });
    expect(st.selectedBehaviorId).toBeNull();
  });

  test('clearSelectedEffect nulls the effect', () => {
    useEditorStore.getState().selectEffect('node-1', 'fx_bloom');
    useEditorStore.getState().clearSelectedEffect();
    expect(useEditorStore.getState().selectedEffect).toBeNull();
  });
});

// ── Active logic (signal graph) ───────────────────────────────────────────────

describe('setActiveLogic / setActiveLogicWritable / setSelectedSignalNode', () => {
  test('setActiveLogic sets id and switches leftTab to graphs', () => {
    useEditorStore.getState().setActiveLogic('graph-1');
    const st = useEditorStore.getState();
    expect(st.activeLogicId).toBe('graph-1');
    expect(st.leftTab).toBe('graphs');
    expect(st.selectedSignalNodeId).toBeNull();
    expect(st.activeLogicWritable).toBe(false);
  });

  test('setActiveLogic(null) clears id but preserves leftTab', () => {
    useEditorStore.getState().setLeftTab('compose');
    useEditorStore.getState().setActiveLogic(null);
    const st = useEditorStore.getState();
    expect(st.activeLogicId).toBeNull();
    expect(st.leftTab).toBe('compose');
  });

  test('setActiveLogicWritable toggles writable flag', () => {
    useEditorStore.getState().setActiveLogicWritable(true);
    expect(useEditorStore.getState().activeLogicWritable).toBe(true);
    useEditorStore.getState().setActiveLogicWritable(false);
    expect(useEditorStore.getState().activeLogicWritable).toBe(false);
  });

  test('setSelectedSignalNode sets the signal node id', () => {
    useEditorStore.getState().setSelectedSignalNode('sn-42');
    expect(useEditorStore.getState().selectedSignalNodeId).toBe('sn-42');
    useEditorStore.getState().setSelectedSignalNode(null);
    expect(useEditorStore.getState().selectedSignalNodeId).toBeNull();
  });
});

// ── Dock UI tabs ──────────────────────────────────────────────────────────────

describe('setLeftTab / setBottomTab / flashBottomTab', () => {
  test('setLeftTab switches the left panel tab', () => {
    useEditorStore.getState().setLeftTab('compose');
    expect(useEditorStore.getState().leftTab).toBe('compose');
  });

  test('setBottomTab switches the bottom dock tab', () => {
    useEditorStore.getState().setBottomTab('animations');
    expect(useEditorStore.getState().bottomTab).toBe('animations');
  });

  test('flashBottomTab switches tab and bumps bottomTabFlash', () => {
    const before = useEditorStore.getState().bottomTabFlash;
    useEditorStore.getState().flashBottomTab('models');
    const st = useEditorStore.getState();
    expect(st.bottomTab).toBe('models');
    expect(st.bottomTabFlash).toBeGreaterThan(before);
  });
});

describe('requestFocusName', () => {
  test('increments focusNameNonce each call', () => {
    const n0 = useEditorStore.getState().focusNameNonce;
    useEditorStore.getState().requestFocusName();
    expect(useEditorStore.getState().focusNameNonce).toBe(n0 + 1);
    useEditorStore.getState().requestFocusName();
    expect(useEditorStore.getState().focusNameNonce).toBe(n0 + 2);
  });
});

describe('setBottomDockHeight', () => {
  test('clamps height to [120, 800]', () => {
    useEditorStore.getState().setBottomDockHeight(50);
    expect(useEditorStore.getState().bottomDockHeight).toBe(120);
    useEditorStore.getState().setBottomDockHeight(9000);
    expect(useEditorStore.getState().bottomDockHeight).toBe(800);
    useEditorStore.getState().setBottomDockHeight(300);
    expect(useEditorStore.getState().bottomDockHeight).toBe(300);
  });
});

// ── Node / compose-layer transform overrides ──────────────────────────────────

describe('setNodeTransformOverride', () => {
  test('sets and clears a transform override', () => {
    useEditorStore.getState().setNodeTransformOverride('node-1', { position: { x: 1 } });
    expect(useEditorStore.getState().nodeTransformOverrides['node-1']).toEqual({
      position: { x: 1 },
    });
    useEditorStore.getState().setNodeTransformOverride('node-1', null);
    expect(useEditorStore.getState().nodeTransformOverrides['node-1']).toBeUndefined();
  });
});

describe('setComposeLayerOverride', () => {
  test('sets and clears a compose-layer override', () => {
    useEditorStore.getState().setComposeLayerOverride('layer-1', { opacity: 0.5, x: 10 });
    expect(useEditorStore.getState().composeLayerOverrides['layer-1']).toEqual({ opacity: 0.5, x: 10 });
    useEditorStore.getState().setComposeLayerOverride('layer-1', null);
    expect(useEditorStore.getState().composeLayerOverrides['layer-1']).toBeUndefined();
  });
});

// ── Runtime overrides ─────────────────────────────────────────────────────────

describe('setRuntimeOverride / clearRuntimeOverride / replaceRuntimeOverrides', () => {
  test('setRuntimeOverride writes to runtimeNodeOverrides', () => {
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'opacity', 0.8);
    expect(useEditorStore.getState().runtimeNodeOverrides['node-1']['opacity']).toBe(0.8);
  });

  test('setRuntimeOverride writes to runtimeLayerOverrides', () => {
    useEditorStore.getState().setRuntimeOverride('compose_layer', 'layer-1', 'x', 100);
    expect(useEditorStore.getState().runtimeLayerOverrides['layer-1']['x']).toBe(100);
  });

  test('setRuntimeOverride is a no-op when value is unchanged', () => {
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'opacity', 0.5);
    // Capture state reference
    const before = useEditorStore.getState().runtimeNodeOverrides;
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'opacity', 0.5);
    // No state change means the reference is the same
    expect(useEditorStore.getState().runtimeNodeOverrides).toBe(before);
  });

  test('clearRuntimeOverride removes a specific param', () => {
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'opacity', 0.8);
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'scale.x', 2);
    useEditorStore.getState().clearRuntimeOverride('scene_node', 'node-1', 'opacity');
    const overrides = useEditorStore.getState().runtimeNodeOverrides['node-1'];
    expect(overrides).not.toHaveProperty('opacity');
    expect(overrides).toHaveProperty('scale.x', 2);
  });

  test('clearRuntimeOverride with no paramPath removes the whole target', () => {
    useEditorStore.getState().setRuntimeOverride('scene_node', 'node-1', 'opacity', 0.8);
    useEditorStore.getState().clearRuntimeOverride('scene_node', 'node-1');
    expect(useEditorStore.getState().runtimeNodeOverrides['node-1']).toBeUndefined();
  });

  test('clearRuntimeOverride is a no-op for unknown target', () => {
    useEditorStore.getState().clearRuntimeOverride('scene_node', 'nope');
    expect(useEditorStore.getState().runtimeNodeOverrides).toEqual({});
  });

  test('replaceRuntimeOverrides bulk-replaces both maps', () => {
    useEditorStore.getState().setRuntimeOverride('scene_node', 'old-node', 'x', 1);
    useEditorStore.getState().replaceRuntimeOverrides([
      { targetKind: 'scene_node', targetId: 'node-A', paramPath: 'opacity', value: 0.5 },
      { targetKind: 'compose_layer', targetId: 'layer-B', paramPath: 'x', value: 100 },
    ]);
    const st = useEditorStore.getState();
    expect(st.runtimeNodeOverrides).toEqual({ 'node-A': { opacity: 0.5 } });
    expect(st.runtimeLayerOverrides).toEqual({ 'layer-B': { x: 100 } });
    // Old entries are gone
    expect(st.runtimeNodeOverrides['old-node']).toBeUndefined();
  });
});

// ── Override suppressions ─────────────────────────────────────────────────────

describe('suppressOverride / clearOverrideSuppressions', () => {
  test('suppressOverride adds a key to the set', () => {
    useEditorStore.getState().suppressOverride('scene_node', 'node-1', 'opacity');
    expect(useEditorStore.getState().suppressedOverrides.has('scene_node:node-1:opacity')).toBe(true);
  });

  test('suppressOverride is idempotent', () => {
    useEditorStore.getState().suppressOverride('scene_node', 'node-1', 'opacity');
    const before = useEditorStore.getState().suppressedOverrides;
    useEditorStore.getState().suppressOverride('scene_node', 'node-1', 'opacity');
    // Same Set reference returned (no-op branch)
    expect(useEditorStore.getState().suppressedOverrides).toBe(before);
  });

  test('clearOverrideSuppressions empties the set', () => {
    useEditorStore.getState().suppressOverride('scene_node', 'node-1', 'opacity');
    useEditorStore.getState().suppressOverride('compose_layer', 'layer-1', 'x');
    useEditorStore.getState().clearOverrideSuppressions();
    expect(useEditorStore.getState().suppressedOverrides.size).toBe(0);
  });

  test('clearOverrideSuppressions is a no-op when set is already empty', () => {
    const before = useEditorStore.getState().suppressedOverrides;
    useEditorStore.getState().clearOverrideSuppressions();
    expect(useEditorStore.getState().suppressedOverrides).toBe(before);
  });
});

// ── Data channels ─────────────────────────────────────────────────────────────

describe('mergeDataChannels / clearDataChannels / replaceDataChannels', () => {
  test('mergeDataChannels merges fields into a scope', () => {
    useEditorStore.getState().mergeDataChannels('global', { name: 'Alice', score: 42 });
    expect(useEditorStore.getState().dataChannels['global']).toEqual({ name: 'Alice', score: 42 });
    useEditorStore.getState().mergeDataChannels('global', { score: 99 });
    expect(useEditorStore.getState().dataChannels['global']['score']).toBe(99);
    expect(useEditorStore.getState().dataChannels['global']['name']).toBe('Alice');
  });

  test('clearDataChannels removes a single field from a scope', () => {
    useEditorStore.getState().mergeDataChannels('global', { a: 1, b: 2 });
    useEditorStore.getState().clearDataChannels('global', 'a');
    expect(useEditorStore.getState().dataChannels['global']).toEqual({ b: 2 });
  });

  test('clearDataChannels with no field removes the whole scope', () => {
    useEditorStore.getState().mergeDataChannels('global', { a: 1 });
    useEditorStore.getState().clearDataChannels('global');
    expect(useEditorStore.getState().dataChannels['global']).toBeUndefined();
  });

  test('clearDataChannels last field in scope removes scope key entirely', () => {
    useEditorStore.getState().mergeDataChannels('s1', { only: true });
    useEditorStore.getState().clearDataChannels('s1', 'only');
    expect(useEditorStore.getState().dataChannels['s1']).toBeUndefined();
  });

  test('replaceDataChannels bulk-replaces the whole map', () => {
    useEditorStore.getState().mergeDataChannels('old', { x: 1 });
    useEditorStore.getState().replaceDataChannels([
      { scope: 'global', fields: { a: 1 } },
      { scope: 'player', fields: { hp: 100 } },
    ]);
    const dc = useEditorStore.getState().dataChannels;
    expect(dc['global']).toEqual({ a: 1 });
    expect(dc['player']).toEqual({ hp: 100 });
    expect(dc['old']).toBeUndefined();
  });
});

// ── Track clips ───────────────────────────────────────────────────────────────

describe('track clip CRUD', () => {
  test('addTrackClip appends; idempotent by id', () => {
    useEditorStore.getState().addTrackClip(makeTrackClip());
    useEditorStore.getState().addTrackClip(makeTrackClip());
    expect(useEditorStore.getState().trackClips).toHaveLength(1);
  });

  test('updateTrackClipLocal replaces a clip in the list', () => {
    useEditorStore.getState().addTrackClip(makeTrackClip());
    useEditorStore.getState().updateTrackClipLocal(makeTrackClip({ name: 'Updated' }));
    expect(useEditorStore.getState().trackClips[0].name).toBe('Updated');
  });

  test('selectTrackClip sets selectedTrackClipId', () => {
    useEditorStore.getState().addTrackClip(makeTrackClip());
    useEditorStore.getState().selectTrackClip('clip-1');
    expect(useEditorStore.getState().selectedTrackClipId).toBe('clip-1');
    useEditorStore.getState().selectTrackClip(null);
    expect(useEditorStore.getState().selectedTrackClipId).toBeNull();
  });

  test('removeTrackClip removes the clip and clears selectedTrackClipId', () => {
    useEditorStore.getState().addTrackClip(makeTrackClip());
    useEditorStore.getState().selectTrackClip('clip-1');
    useEditorStore.getState().removeTrackClip('clip-1');
    const st = useEditorStore.getState();
    expect(st.trackClips).toHaveLength(0);
    expect(st.selectedTrackClipId).toBeNull();
  });
});

describe('clipPlayback slice', () => {
  const doc = (over = {}) => ({
    id: 'pb:clip-1',
    clipId: 'clip-1',
    state: 'playing' as const,
    startEpoch: 1000,
    pausedAtT: null,
    speed: 1,
    loop: false,
    ...over,
  });

  test('is keyed by CLIP id, not document id', () => {
    // Every reader has a clip in hand and wants its transport; the doc id only
    // matters for removes, which arrive carrying it and nothing else.
    useEditorStore.getState().upsertClipPlayback(doc());
    expect(useEditorStore.getState().clipPlayback['clip-1']).toEqual(doc());
    expect(useEditorStore.getState().clipPlayback['pb:clip-1']).toBeUndefined();
  });

  test('upserting replaces the entry for that clip', () => {
    useEditorStore.getState().upsertClipPlayback(doc());
    useEditorStore.getState().upsertClipPlayback(doc({ state: 'paused', pausedAtT: 2 }));
    const pb = useEditorStore.getState().clipPlayback['clip-1'];
    expect(pb.state).toBe('paused');
    expect(pb.pausedAtT).toBe(2);
  });

  test('removing resolves the DOCUMENT id back to its clip key', () => {
    useEditorStore.getState().upsertClipPlayback(doc());
    useEditorStore.getState().removeClipPlayback('pb:clip-1');
    expect(useEditorStore.getState().clipPlayback['clip-1']).toBeUndefined();
  });

  test('removing an unknown document id is a no-op', () => {
    useEditorStore.getState().upsertClipPlayback(doc());
    useEditorStore.getState().removeClipPlayback('pb:nope');
    expect(useEditorStore.getState().clipPlayback['clip-1']).toBeDefined();
  });
});

// ── Presets ───────────────────────────────────────────────────────────────────

describe('presets', () => {
  const preset = {
    id: 'preset-1',
    projectId: 'proj-1',
    name: 'My Preset',
    description: '',
    rootKind: 'scene_node' as const,
    thumbnailPath: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  test('setPresets replaces the list', () => {
    useEditorStore.getState().setPresets([preset]);
    expect(useEditorStore.getState().presets).toHaveLength(1);
  });

  test('addPreset prepends to the list', () => {
    useEditorStore.getState().setPresets([{ ...preset, id: 'p-2' }]);
    useEditorStore.getState().addPreset({ ...preset, id: 'p-1' });
    expect(useEditorStore.getState().presets[0].id).toBe('p-1');
  });

  test('removePreset removes by id', () => {
    useEditorStore.getState().setPresets([preset]);
    useEditorStore.getState().removePreset('preset-1');
    expect(useEditorStore.getState().presets).toHaveLength(0);
  });
});

// ── Update state ──────────────────────────────────────────────────────────────

describe('setUpdateAvailable / setPendingReload', () => {
  test('setUpdateAvailable stores available flag and info', () => {
    const info = { latestVersion: '2.0.0', releaseNotes: 'New stuff', channel: 'stable' as const };
    useEditorStore.getState().setUpdateAvailable(true, info);
    const st = useEditorStore.getState();
    expect(st.updateAvailable).toBe(true);
    expect(st.updateInfo).toEqual(info);
  });

  test('setPendingReload sets the flag', () => {
    useEditorStore.getState().setPendingReload(true);
    expect(useEditorStore.getState().pendingReload).toBe(true);
  });
});

// ── Misc ──────────────────────────────────────────────────────────────────────

describe('setBoneListExpanded / setFbxDebugVisible', () => {
  test('setBoneListExpanded stores per-node expanded state', () => {
    useEditorStore.getState().setBoneListExpanded('node-1', true);
    expect(useEditorStore.getState().boneListExpanded['node-1']).toBe(true);
    useEditorStore.getState().setBoneListExpanded('node-1', false);
    expect(useEditorStore.getState().boneListExpanded['node-1']).toBe(false);
  });

  test('setFbxDebugVisible stores per-node debug visibility', () => {
    useEditorStore.getState().setFbxDebugVisible('node-1', true);
    expect(useEditorStore.getState().fbxDebugVisible['node-1']).toBe(true);
  });
});

describe('setEditorAudioPreviewEnabled', () => {
  test('sets the audio preview flag', () => {
    expect(useEditorStore.getState().editorAudioPreviewEnabled).toBe(false);
    useEditorStore.getState().setEditorAudioPreviewEnabled(true);
    expect(useEditorStore.getState().editorAudioPreviewEnabled).toBe(true);
  });
});
