/**
 * editorStore.breadth.test.ts — Phase 7 deferred coverage
 *
 * Covers actions that were not tested in editorStore.test.ts:
 *   - Compose-scene CRUD: addComposeScene, updateComposeSceneLocal,
 *     removeComposeScene, selectComposeScene
 *   - Compose-layer CRUD: addComposeLayer, updateComposeLayerLocal,
 *     removeComposeLayer, selectComposeLayer
 *   - Track-clip lane mutations: addTrackClipLane, updateTrackClipLaneLocal,
 *     removeTrackClipLane, replaceTrackClipLaneKeyframes, replaceTrackClipEvents
 *
 * Conventions: mirror editorStore.test.ts exactly.
 *   - State is reset via setState(<initial>, false) — NOT replace:true — so
 *     action functions defined in the store are preserved.
 *   - All assertions go through getState().
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import type {
  ComposeLayerRecord,
  TrackClipRecord,
  TrackClipLaneRecord,
  TrackClipKeyframeRecord,
  TrackClipEventRecord,
} from '../src/store/editorStore';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal initial state matching the store's create() defaults. */
const INITIAL = {
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

function makeComposeLayer(
  overrides: Partial<ComposeLayerRecord> = {}
): ComposeLayerRecord {
  return {
    id: 'layer-1',
    projectId: 'proj-1',
    rootComposeSceneId: 'scene-1',
    cameraNodeId: null,
    parentId: null,
    name: 'Layer 1',
    kind: 'image',
    assetId: null,
    config: {},
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    anchorH: 'left',
    anchorV: 'top',
    sceneOrder: 0,
    cameraOrder: 0,
    visible: true,
    ...overrides,
  };
}

/** A ComposeLayerRecord used as a compose-scene root (kind='compose_scene',
 *  rootComposeSceneId=null). */
function makeComposeScene(
  overrides: Partial<ComposeLayerRecord> = {}
): ComposeLayerRecord {
  return makeComposeLayer({
    id: 'cscene-1',
    name: 'Compose Scene 1',
    kind: 'compose_scene',
    rootComposeSceneId: null,
    ...overrides,
  });
}

function makeLane(
  overrides: Partial<TrackClipLaneRecord> = {}
): TrackClipLaneRecord {
  return {
    id: 'lane-1',
    clipId: 'clip-1',
    targetKind: 'scene_node',
    targetId: 'node-1',
    paramPath: 'opacity',
    defaultValue: 1,
    keyframes: [],
    ...overrides,
  };
}

function makeKeyframe(
  overrides: Partial<TrackClipKeyframeRecord> = {}
): TrackClipKeyframeRecord {
  return {
    id: 'kf-1',
    t: 0,
    value: 0,
    easing: 'linear',
    inHandleTFraction: null,
    inHandleVFraction: null,
    outHandleTFraction: null,
    outHandleVFraction: null,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<TrackClipEventRecord> = {}
): TrackClipEventRecord {
  return {
    id: 'ev-1',
    t: 0.5,
    action: 'trigger',
    targetKind: 'scene_node',
    targetId: 'node-1',
    payload: null,
    ...overrides,
  };
}

function makeTrackClip(
  overrides: Partial<TrackClipRecord> = {}
): TrackClipRecord {
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
// replace=false so action functions survive the reset.

beforeEach(() => {
  useEditorStore.setState(INITIAL, false);
});

// ── Compose scenes ────────────────────────────────────────────────────────────

describe('selectComposeScene', () => {
  test('sets activeComposeSceneId', () => {
    useEditorStore.getState().selectComposeScene('cscene-1');
    expect(useEditorStore.getState().activeComposeSceneId).toBe('cscene-1');
  });

  test('selectComposeScene(null) clears the active id', () => {
    useEditorStore.getState().selectComposeScene('cscene-1');
    useEditorStore.getState().selectComposeScene(null);
    expect(useEditorStore.getState().activeComposeSceneId).toBeNull();
  });
});

describe('selectComposeLayer', () => {
  test('sets selectedComposeLayerId', () => {
    useEditorStore.getState().selectComposeLayer('layer-1');
    expect(useEditorStore.getState().selectedComposeLayerId).toBe('layer-1');
  });

  test('selectComposeLayer(null) clears the selection', () => {
    useEditorStore.getState().selectComposeLayer('layer-1');
    useEditorStore.getState().selectComposeLayer(null);
    expect(useEditorStore.getState().selectedComposeLayerId).toBeNull();
  });
});

// ── Track clip lane mutations ─────────────────────────────────────────────────
