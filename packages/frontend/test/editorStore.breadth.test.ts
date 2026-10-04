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

describe('addComposeScene', () => {
  test('appends a new compose scene', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene());
    expect(useEditorStore.getState().composeScenes).toHaveLength(1);
  });

  test('is idempotent by id — second object with same id is ignored', () => {
    // Two distinct objects, same id — guards against reference-equality dedup bugs.
    const cs1 = makeComposeScene({ id: 'cs-1', name: 'First' });
    const cs2 = makeComposeScene({ id: 'cs-1', name: 'Second' });
    useEditorStore.getState().addComposeScene(cs1);
    useEditorStore.getState().addComposeScene(cs2);
    expect(useEditorStore.getState().composeScenes).toHaveLength(1);
    // First insert wins
    expect(useEditorStore.getState().composeScenes[0].name).toBe('First');
  });

  test('multiple different compose scenes are all appended', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-2' }));
    expect(useEditorStore.getState().composeScenes).toHaveLength(2);
  });
});

describe('updateComposeSceneLocal', () => {
  test('replaces the matching compose scene', () => {
    const cs = makeComposeScene();
    useEditorStore.getState().addComposeScene(cs);
    useEditorStore
      .getState()
      .updateComposeSceneLocal({ ...cs, name: 'Renamed' });
    expect(useEditorStore.getState().composeScenes[0].name).toBe('Renamed');
  });

  test('leaves other compose scenes untouched', () => {
    const cs1 = makeComposeScene({ id: 'cs-1', name: 'A' });
    const cs2 = makeComposeScene({ id: 'cs-2', name: 'B' });
    useEditorStore.getState().addComposeScene(cs1);
    useEditorStore.getState().addComposeScene(cs2);
    useEditorStore.getState().updateComposeSceneLocal({ ...cs1, name: 'A2' });
    expect(
      useEditorStore.getState().composeScenes.find((c) => c.id === 'cs-2')?.name
    ).toBe('B');
  });

  test('is a no-op for an unknown id', () => {
    const cs = makeComposeScene();
    useEditorStore.getState().addComposeScene(cs);
    useEditorStore.getState().updateComposeSceneLocal({
      ...cs,
      id: 'nope',
      name: 'Ghost',
    });
    // The real compose scene is untouched
    expect(useEditorStore.getState().composeScenes[0].name).toBe(
      'Compose Scene 1'
    );
  });
});

describe('selectComposeScene', () => {
  test('sets activeComposeSceneId', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene());
    useEditorStore.getState().selectComposeScene('cscene-1');
    expect(useEditorStore.getState().activeComposeSceneId).toBe('cscene-1');
  });

  test('selectComposeScene(null) clears the active id', () => {
    useEditorStore.getState().selectComposeScene('cscene-1');
    useEditorStore.getState().selectComposeScene(null);
    expect(useEditorStore.getState().activeComposeSceneId).toBeNull();
  });
});

describe('removeComposeScene', () => {
  test('removes the compose scene from composeScenes', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-2' }));
    useEditorStore.getState().removeComposeScene('cs-1');
    expect(useEditorStore.getState().composeScenes.map((c) => c.id)).toEqual([
      'cs-2',
    ]);
  });

  test('also removes composeLayers whose rootComposeSceneId matches', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore
      .getState()
      .setComposeLayers([
        makeComposeLayer({ id: 'l-1', rootComposeSceneId: 'cs-1' }),
        makeComposeLayer({ id: 'l-2', rootComposeSceneId: 'cs-2' }),
      ]);
    useEditorStore.getState().removeComposeScene('cs-1');
    const layers = useEditorStore.getState().composeLayers;
    expect(layers.map((l) => l.id)).toEqual(['l-2']);
  });

  test('falls back activeComposeSceneId to the next scene when the active one is removed', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-2' }));
    useEditorStore.getState().selectComposeScene('cs-1');
    useEditorStore.getState().removeComposeScene('cs-1');
    expect(useEditorStore.getState().activeComposeSceneId).toBe('cs-2');
  });

  test('sets activeComposeSceneId to null when the last scene is removed', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore.getState().selectComposeScene('cs-1');
    useEditorStore.getState().removeComposeScene('cs-1');
    expect(useEditorStore.getState().activeComposeSceneId).toBeNull();
  });

  test('preserves activeComposeSceneId when a different scene is removed', () => {
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-2' }));
    useEditorStore.getState().selectComposeScene('cs-2');
    useEditorStore.getState().removeComposeScene('cs-1');
    expect(useEditorStore.getState().activeComposeSceneId).toBe('cs-2');
  });

  test('does NOT clear selectedComposeLayerId when the selected layer belonged to the removed scene (known store gap)', () => {
    // The store's removeComposeScene filters composeLayers but does not touch
    // selectedComposeLayerId. This test documents the current behavior so that
    // if the store is fixed in the future the test will fail and prompt an update.
    useEditorStore.getState().addComposeScene(makeComposeScene({ id: 'cs-1' }));
    useEditorStore
      .getState()
      .setComposeLayers([
        makeComposeLayer({ id: 'l-1', rootComposeSceneId: 'cs-1' }),
      ]);
    useEditorStore.getState().selectComposeLayer('l-1');
    useEditorStore.getState().removeComposeScene('cs-1');
    // Layer is gone from the list…
    expect(useEditorStore.getState().composeLayers).toHaveLength(0);
    // …but selectedComposeLayerId is NOT cleared by removeComposeScene (store gap).
    // Use removeComposeLayer to also clear the selection.
    expect(useEditorStore.getState().selectedComposeLayerId).toBe('l-1');
  });
});

// ── Compose layers ────────────────────────────────────────────────────────────

describe('addComposeLayer', () => {
  test('appends a new compose layer', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer());
    expect(useEditorStore.getState().composeLayers).toHaveLength(1);
  });

  test('is idempotent by id — second object with same id is ignored', () => {
    // Two distinct objects, same id — guards against reference-equality dedup bugs.
    const l1 = makeComposeLayer({ id: 'l-1', name: 'First' });
    const l2 = makeComposeLayer({ id: 'l-1', name: 'Second' });
    useEditorStore.getState().addComposeLayer(l1);
    useEditorStore.getState().addComposeLayer(l2);
    expect(useEditorStore.getState().composeLayers).toHaveLength(1);
    // First insert wins
    expect(useEditorStore.getState().composeLayers[0].name).toBe('First');
  });

  test('multiple different layers are all appended', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-1' }));
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-2' }));
    expect(useEditorStore.getState().composeLayers).toHaveLength(2);
  });
});

describe('updateComposeLayerLocal', () => {
  test('patches the matching layer', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer());
    useEditorStore
      .getState()
      .updateComposeLayerLocal('layer-1', { name: 'Updated' });
    expect(useEditorStore.getState().composeLayers[0].name).toBe('Updated');
  });

  test('can patch multiple fields at once', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer());
    useEditorStore
      .getState()
      .updateComposeLayerLocal('layer-1', { x: 50, y: 75, visible: false });
    const layer = useEditorStore.getState().composeLayers[0];
    expect(layer.x).toBe(50);
    expect(layer.y).toBe(75);
    expect(layer.visible).toBe(false);
  });

  test('leaves other layers untouched', () => {
    useEditorStore
      .getState()
      .addComposeLayer(makeComposeLayer({ id: 'l-1', name: 'A' }));
    useEditorStore
      .getState()
      .addComposeLayer(makeComposeLayer({ id: 'l-2', name: 'B' }));
    useEditorStore.getState().updateComposeLayerLocal('l-1', { name: 'A2' });
    expect(
      useEditorStore.getState().composeLayers.find((l) => l.id === 'l-2')?.name
    ).toBe('B');
  });

  test('is a no-op for an unknown id', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer());
    useEditorStore
      .getState()
      .updateComposeLayerLocal('nope', { name: 'Ghost' });
    expect(useEditorStore.getState().composeLayers[0].name).toBe('Layer 1');
  });
});

describe('removeComposeLayer', () => {
  test('removes the layer by id', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-1' }));
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-2' }));
    useEditorStore.getState().removeComposeLayer('l-1');
    expect(useEditorStore.getState().composeLayers.map((l) => l.id)).toEqual([
      'l-2',
    ]);
  });

  test('clears selectedComposeLayerId when the removed layer was selected', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-1' }));
    useEditorStore.getState().selectComposeLayer('l-1');
    useEditorStore.getState().removeComposeLayer('l-1');
    expect(useEditorStore.getState().selectedComposeLayerId).toBeNull();
  });

  test('preserves selectedComposeLayerId when a different layer is removed', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-1' }));
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-2' }));
    useEditorStore.getState().selectComposeLayer('l-2');
    useEditorStore.getState().removeComposeLayer('l-1');
    expect(useEditorStore.getState().selectedComposeLayerId).toBe('l-2');
  });

  test('is a no-op on an unknown id (list unchanged)', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer({ id: 'l-1' }));
    useEditorStore.getState().removeComposeLayer('nope');
    expect(useEditorStore.getState().composeLayers).toHaveLength(1);
  });
});

describe('selectComposeLayer', () => {
  test('sets selectedComposeLayerId', () => {
    useEditorStore.getState().addComposeLayer(makeComposeLayer());
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
