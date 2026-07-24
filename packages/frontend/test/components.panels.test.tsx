/**
 * components.panels.test.tsx — Phase 7 frontend component tests for main editor panels.
 *
 * Covers: SceneGraph, AssetManager.
 *
 * PropertiesPanel NOTE: PropertiesPanel cannot be mounted in this test
 * environment because it directly imports `@vspark/shared/arkit` (a runtime
 * named import of ARKIT_TO_FCL / ARKIT_TO_VRM / ARKIT_SHAPES).  The
 * vitest.config.ts does not inherit the vite.config.ts `resolve.alias` list
 * that maps `@vspark/shared/*` to the monorepo source, so Vite's
 * import-analysis plugin fails with "Failed to resolve import" before
 * vi.mock() can intercept.  Fix: add the `@vspark/shared/*` aliases to
 * vitest.config.ts (requires modifying that file, which is out of scope for
 * this task per the constraints).
 *
 * Note on duplicate-element queries: @testing-library/react + React 18 can
 * render effects twice in jsdom (React's double-invoke in dev mode). We use
 * `queryAllByText` / `getAllByText` with `.length > 0` checks rather than
 * `getByText` (which throws on duplicates) where needed, or scope queries to
 * the rendered container.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from './helpers/render';
import { useEditorStore } from '../src/store/editorStore';
import type { SceneItem, StageObject, Behavior } from '../src/store/editorStore';

// ── Mocks (hoisted before panel imports) ─────────────────────────────────────

// SceneGraph child panels
vi.mock('../src/components/editor/ComposeTree', () => ({
  ComposeTree: () => <div data-testid="mock-compose-tree" />,
}));
vi.mock('../src/components/editor/ClipsSection', () => ({
  ClipsSection: () => <div data-testid="mock-clips-section" />,
}));
vi.mock('../src/components/editor/LogicSection', () => ({
  LogicSection: () => <div data-testid="mock-logic-section" />,
}));

// Connections store — SceneGraph calls getCollabScenes on mount
vi.mock('../src/store/connectionsStore', () => ({
  useConnectionsStore: (selector: (s: unknown) => unknown) => {
    const state = {
      connectedIds: [] as string[],
      nameById: {} as Record<string, string>,
      collabScenes: {} as Record<string, unknown>,
      setCollabScenes: vi.fn(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

// API client — panels call api.* on interactions
vi.mock('../src/api/client', () => ({
  api: {
    getCollabScenes: vi.fn().mockResolvedValue([]),
    getObjectGrantees: vi.fn().mockResolvedValue([]),
    createScene: vi.fn().mockResolvedValue({ id: 'new-scene', name: 'New Scene' }),
    getScenes: vi.fn().mockResolvedValue({ scenes: [], nodes: [] }),
    deleteScene: vi.fn().mockResolvedValue(undefined),
    createNode: vi.fn().mockResolvedValue({
      id: 'new-node', name: 'New', kind: 'avatar',
      rootSceneNodeId: 'scene-1', projectId: 'proj-1', parentId: null, components: {},
    }),
    deleteNode: vi.fn().mockResolvedValue(undefined),
    updateNode: vi.fn().mockResolvedValue(undefined),
    uploadAsset: vi.fn().mockResolvedValue({
      id: 'a1', name: 'model.vrm', kind: 'model', url: '/assets/model.vrm',
    }),
    serializePreset: vi.fn().mockResolvedValue({}),
    instantiatePreset: vi.fn().mockResolvedValue(undefined),
    createNodeLogic: vi.fn().mockResolvedValue({ id: 'logic-1' }),
    updateLogic: vi.fn().mockResolvedValue(undefined),
    getNodes: vi.fn().mockResolvedValue([]),
  },
  // Top-level named exports used directly by SceneGraph
  fireSignalEvent: vi.fn().mockResolvedValue(undefined),
  updateScene: vi.fn().mockResolvedValue(undefined),
  ApiError: class ApiError extends Error {},
  getObjectGrantees: vi.fn().mockResolvedValue([]),
  shareObject: vi.fn().mockResolvedValue(undefined),
  shareCollabScene: vi.fn().mockResolvedValue(undefined),
  getCollabScenes: vi.fn().mockResolvedValue([]),
}));

// Sync / remote helper
vi.mock('../src/sync/remoteEdit', () => ({
  isWritableRemoteNode: () => false,
  createRemoteChild: vi.fn(),
}));

// Clipboard helpers
vi.mock('../src/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  pasteFromClipboard: vi.fn().mockResolvedValue(null),
}));

// createKinds — defines NODE_KIND_DEFS; avoids PARTICLE_DEFAULTS / feedTemplate deps
vi.mock('../src/components/editor/createKinds', () => ({
  NODE_KIND_DEFS: [
    { kind: 'avatar', label: 'Avatar', icon: '🧍', description: '', defaultName: 'Avatar' },
    { kind: 'light', label: 'Light', icon: '💡', description: '', defaultName: 'Light' },
  ],
  createSceneNode: vi.fn().mockResolvedValue({
    id: 'new-node', name: 'Avatar', kind: 'avatar',
    rootSceneNodeId: 'scene-1', projectId: 'proj-1', parentId: null, components: {},
  }),
  nextNodeName: vi.fn().mockReturnValue('Avatar'),
  behaviorCompatibleWith: vi.fn().mockReturnValue(true),
  createLayer: vi.fn().mockResolvedValue({ id: 'layer-1', kind: 'image' }),
}));

// dnd helpers
vi.mock('../src/components/editor/dnd', () => ({
  handleSceneNodeDrop: vi.fn().mockResolvedValue(false),
  DND_ASSET: 'application/vspark-asset',
  DND_CREATE_NODE: 'application/vspark-create-node',
  DND_CREATE_LAYER: 'application/vspark-create-layer',
}));

// DialogProvider hooks — SceneGraph calls useConfirm / usePrompt / useChoose
vi.mock('../src/components/DialogProvider', () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
  usePrompt: () => vi.fn().mockResolvedValue(''),
  useChoose: () => vi.fn().mockResolvedValue(null),
  DialogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// HelpButton — tiny presentational
vi.mock('../src/help/HelpButton', () => ({
  HelpButton: () => <span data-testid="mock-help-button" />,
}));

// ContextMenu
vi.mock('../src/components/editor/ContextMenu', () => ({
  ContextMenu: () => null,
}));

// ── AssetManager child mocks ──────────────────────────────────────────────────

// TrackClipTimeline — heavy timeline component
vi.mock('../src/components/editor/TrackClipTimeline', () => ({
  TrackClipTimeline: () => <div data-testid="mock-track-clip-timeline" />,
}));

// PresetLibrary
vi.mock('../src/components/editor/PresetLibrary', () => ({
  PresetLibrary: () => <div data-testid="mock-preset-library" />,
}));

// CreatePalette
vi.mock('../src/components/editor/CreatePalette', () => ({
  CreatePalette: () => <div data-testid="mock-create-palette" />,
}));

// AssetThumb — imports three.js / modelThumb / animPreview
vi.mock('../src/components/editor/AssetThumb', () => ({
  AssetThumb: ({ asset }: { asset: { name: string } }) => (
    <div data-testid="asset-thumb">{asset.name}</div>
  ),
}));

// ── Panel imports (after all mocks) ──────────────────────────────────────────
import { SceneGraph } from '../src/components/editor/SceneGraph';
import { AssetManager } from '../src/components/editor/AssetManager';

// ── Shared state factories ────────────────────────────────────────────────────

const INITIAL_STATE = {
  projectId: null as string | null,
  projectName: '',
  scenes: [] as SceneItem[],
  activeSceneId: null as string | null,
  nodes: [] as StageObject[],
  selectedNodeId: null as string | null,
  sceneSelected: false,
  selectedBehaviorId: null as string | null,
  assets: [] as import('../src/api/client').AssetFile[],
  behaviors: [] as Behavior[],
  vmcStatus: {} as Record<string, boolean>,
  vmcTracking: {} as Record<string, boolean>,
  scheduledAnimations: {},
  animationClips: {},
  vrmBonesByNode: {} as Record<string, string[]>,
  vrmExpressionsByNode: {},
  vrmMorphTargetsByNode: {},
  hoveredBoneName: null as string | null,
  behaviorKinds: [],
  overliveAccounts: [],
  activeLogicWritable: false,
  activeLogicId: null as string | null,
  selectedSignalNodeId: null as string | null,
  boneListExpanded: {} as Record<string, boolean>,
  fbxDebugVisible: {},
  cameraEffects: [],
  previewEffectsCamera: null as string | null,
  selectedEffect: null,
  composeScenes: [],
  activeComposeSceneId: null as string | null,
  composeLayers: [],
  leftTab: 'scene' as const,
  bottomTab: 'models' as const,
  bottomTabFlash: 0,
  focusNameNonce: 0,
  bottomDockHeight: 200,
  editorAudioPreviewEnabled: false,
  clipboardPayload: null,
  selectedComposeLayerId: null as string | null,
  trackClips: [],
  selectedTrackClipId: null as string | null,
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

function makeScene(overrides: Partial<SceneItem> = {}): SceneItem {
  return { id: 'scene-1', name: 'Scene One', runtimeSettings: {}, ...overrides };
}

function makeNode(overrides: Partial<StageObject> = {}): StageObject {
  return {
    id: 'node-1',
    rootSceneNodeId: 'scene-1',
    projectId: 'proj-1',
    parentId: null,
    name: 'My Avatar',
    kind: 'avatar',
    components: {},
    ...overrides,
  };
}

beforeEach(() => {
  useEditorStore.setState(INITIAL_STATE);
});

// ── SceneGraph ────────────────────────────────────────────────────────────────

describe('SceneGraph', () => {
  it('renders Stage / Compose / Logic tabs', () => {
    const { container } = renderWithProviders(<SceneGraph />);
    // Query within rendered container to avoid cross-test contamination
    const buttons = container.querySelectorAll('button');
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toContain('Stage');
    expect(labels).toContain('Compose');
    expect(labels).toContain('Logic');
  });

  it('shows the empty-scenes placeholder when no scenes exist', () => {
    const { container } = renderWithProviders(<SceneGraph />);
    // sceneGraph.json scenes.empty = "No scenes yet. Click + Scene"
    expect(container.textContent).toMatch(/No scenes yet/i);
  });

  it('renders the Scenes header and + Scene button', () => {
    const { container } = renderWithProviders(<SceneGraph />);
    expect(container.textContent).toContain('Scenes');
    expect(container.textContent).toContain('+ Scene');
  });

  it('renders seeded scene name in the scene list', () => {
    useEditorStore.setState({
      scenes: [makeScene({ id: 'scene-1', name: 'Main Scene' })],
      activeSceneId: 'scene-1',
    });
    const { container } = renderWithProviders(<SceneGraph />);
    expect(container.textContent).toContain('Main Scene');
  });

  it('renders multiple seeded scenes', () => {
    useEditorStore.setState({
      scenes: [
        makeScene({ id: 's1', name: 'Alpha Scene' }),
        makeScene({ id: 's2', name: 'Beta Scene' }),
      ],
      activeSceneId: 's1',
    });
    const { container } = renderWithProviders(<SceneGraph />);
    expect(container.textContent).toContain('Alpha Scene');
    expect(container.textContent).toContain('Beta Scene');
  });

  it('renders seeded node name under the active scene', () => {
    const scene = makeScene({ id: 'scene-1', name: 'Main Scene' });
    const node = makeNode({ id: 'node-1', name: 'My Avatar', rootSceneNodeId: 'scene-1', parentId: null });
    useEditorStore.setState({ scenes: [scene], activeSceneId: 'scene-1', nodes: [node] });
    const { container } = renderWithProviders(<SceneGraph />);
    expect(container.textContent).toContain('My Avatar');
  });

  it('renders multiple seeded nodes', () => {
    const scene = makeScene({ id: 'scene-1', name: 'Stage' });
    useEditorStore.setState({
      scenes: [scene],
      activeSceneId: 'scene-1',
      nodes: [
        makeNode({ id: 'n1', name: 'Alpha', rootSceneNodeId: 'scene-1', parentId: null }),
        makeNode({ id: 'n2', name: 'Beta', rootSceneNodeId: 'scene-1', parentId: null }),
      ],
    });
    const { container } = renderWithProviders(<SceneGraph />);
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
  });

  it('clicking a node row sets selectedNodeId in the store', async () => {
    const user = userEvent.setup();
    const scene = makeScene({ id: 'scene-1', name: 'Stage' });
    const node = makeNode({ id: 'node-1', name: 'My Avatar', rootSceneNodeId: 'scene-1', parentId: null });
    useEditorStore.setState({
      scenes: [scene],
      activeSceneId: 'scene-1',
      nodes: [node],
      selectedNodeId: null,
    });
    const { container } = renderWithProviders(<SceneGraph />);

    // Find the clickable node row div (has cursor:pointer and contains the node name)
    const rowDivs = Array.from(container.querySelectorAll<HTMLDivElement>('div[style*="cursor: pointer"]'));
    const nodeRow = rowDivs.find((d) => d.textContent?.includes('My Avatar') && !d.textContent?.includes('Stage'));
    expect(nodeRow).toBeTruthy();
    await user.click(nodeRow!);

    await waitFor(() => {
      expect(useEditorStore.getState().selectedNodeId).toBe('node-1');
    });
  });

  it('clicking a scene row sets it active and marks sceneSelected', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      scenes: [
        makeScene({ id: 'scene-1', name: 'First Scene' }),
        makeScene({ id: 'scene-2', name: 'Second Scene' }),
      ],
      activeSceneId: 'scene-1',
    });
    const { container } = renderWithProviders(<SceneGraph />);

    // Find the "Second Scene" text and click its parent row div
    const spans = Array.from(container.querySelectorAll('span'));
    const secondSceneSpan = spans.find((s) => s.textContent?.trim() === 'Second Scene');
    expect(secondSceneSpan).toBeTruthy();
    // Click the parent div row
    await user.click(secondSceneSpan!.closest('div[style*="cursor: pointer"]')!);

    await waitFor(() => {
      const state = useEditorStore.getState();
      expect(state.activeSceneId).toBe('scene-2');
      expect(state.sceneSelected).toBe(true);
    });
  });

  it('clicking the visibility toggle calls toggleNodeHidden', async () => {
    const user = userEvent.setup();
    const scene = makeScene({ id: 'scene-1', name: 'Stage' });
    const node = makeNode({
      id: 'node-1', name: 'Avatar',
      rootSceneNodeId: 'scene-1', parentId: null, hidden: false,
    });
    useEditorStore.setState({ scenes: [scene], activeSceneId: 'scene-1', nodes: [node] });
    const { container } = renderWithProviders(<SceneGraph />);

    // Visibility button has title "Hide" when node is visible (sceneGraph.json visibility.hide)
    const visBtn = container.querySelector('button[title="Hide"]') as HTMLButtonElement | null;
    expect(visBtn).toBeTruthy();
    await user.click(visBtn!);

    await waitFor(() => {
      const updatedNode = useEditorStore.getState().nodes.find((n) => n.id === 'node-1');
      expect(updatedNode?.hidden).toBe(true);
    });
  });

  it('switches to Compose tab and renders the compose tree stub', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<SceneGraph />);
    const composeBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Compose');
    await user.click(composeBtn!);
    expect(container.querySelector('[data-testid="mock-compose-tree"]')).toBeTruthy();
  });

  it('shows "Empty scene" text for a scene with no nodes', () => {
    useEditorStore.setState({
      scenes: [makeScene({ id: 'scene-1', name: 'Empty' })],
      activeSceneId: 'scene-1',
      nodes: [],
    });
    const { container } = renderWithProviders(<SceneGraph />);
    // sceneGraph.json scenes.emptyScene = "Empty scene"
    expect(container.textContent).toContain('Empty scene');
  });
});

// ── AssetManager ─────────────────────────────────────────────────────────────

describe('AssetManager', () => {
  it('renders the bottom-dock tab bar with all standard tabs', () => {
    const { container } = renderWithProviders(<AssetManager />);
    const buttons = Array.from(container.querySelectorAll('button'));
    const labels = buttons.map((b) => b.textContent?.trim());
    // assets.json tabs.* labels
    expect(labels.some((l) => l === 'Models')).toBe(true);
    expect(labels.some((l) => l === 'Animations')).toBe(true);
    expect(labels.some((l) => l === 'Images')).toBe(true);
    expect(labels.some((l) => l === 'Behaviors')).toBe(true);
    expect(labels.some((l) => l === 'Effects')).toBe(true);
    expect(labels.some((l) => l === 'Create')).toBe(true);
  });

  it('switching to the Create tab renders the Create palette stub', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<AssetManager />);
    const createBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Create');
    await user.click(createBtn!);
    expect(container.querySelector('[data-testid="mock-create-palette"]')).toBeTruthy();
  });

  it('shows seeded model asset names in the Models tab', () => {
    useEditorStore.setState({
      bottomTab: 'models',
      assets: [
        { id: 'a1', name: 'Hero.vrm', kind: 'model', url: '/assets/hero.vrm' },
        { id: 'a2', name: 'Sidekick.vrm', kind: 'model', url: '/assets/sidekick.vrm' },
      ],
    });
    const { container } = renderWithProviders(<AssetManager />);
    // AssetThumb stub renders asset.name
    expect(container.textContent).toContain('Hero.vrm');
    expect(container.textContent).toContain('Sidekick.vrm');
  });

  it('shows no-assets placeholder when Models tab is empty', () => {
    useEditorStore.setState({ bottomTab: 'models', assets: [] });
    const { container } = renderWithProviders(<AssetManager />);
    // assets.json empty.noAssets: "No {{tab}} yet. Upload one above."
    expect(container.textContent).toMatch(/No.*yet/i);
  });

  it('switching to Animations tab shows animation assets', () => {
    useEditorStore.setState({
      bottomTab: 'animations',
      assets: [
        { id: 'a1', name: 'Walk.fbx', kind: 'animation', url: '/assets/walk.fbx' },
      ],
    });
    const { container } = renderWithProviders(<AssetManager />);
    expect(container.textContent).toContain('Walk.fbx');
  });

  it('clicking a tab updates bottomTab in the store', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ bottomTab: 'models' });
    const { container } = renderWithProviders(<AssetManager />);

    const animBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Animations');
    await user.click(animBtn!);

    await waitFor(() => {
      expect(useEditorStore.getState().bottomTab).toBe('animations');
    });
  });

  it('renders Timeline stub when Timeline tab is active', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<AssetManager />);
    const timelineBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Timeline');
    await user.click(timelineBtn!);
    expect(container.querySelector('[data-testid="mock-track-clip-timeline"]')).toBeTruthy();
  });

  it('renders Presets stub when Presets tab is active', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<AssetManager />);
    const presetsBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Presets');
    await user.click(presetsBtn!);
    expect(container.querySelector('[data-testid="mock-preset-library"]')).toBeTruthy();
  });

  it('switching tabs persists the selected tab across the store', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ bottomTab: 'models' });
    const { container } = renderWithProviders(<AssetManager />);

    const imagesBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Images');
    await user.click(imagesBtn!);

    await waitFor(() => {
      expect(useEditorStore.getState().bottomTab).toBe('images');
    });
  });

  it('shows upload section in Models tab', () => {
    useEditorStore.setState({ bottomTab: 'models', assets: [] });
    const { container } = renderWithProviders(<AssetManager />);
    // assets.json upload.model = "Upload Model"
    expect(container.textContent).toContain('Upload Model');
  });
});
