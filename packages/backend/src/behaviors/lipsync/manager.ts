import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { Blendshapes, mkEvent } from '@vspark/shared/signal';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';
import {
  behaviorContextConfig,
  behaviorDescriptorToRun,
  programChanged,
} from '../storedGraph.js';
import { broadcastBus } from '../../broadcast/bus.js';
import { isValidTemplates } from '@vspark/shared/visemes';
import { PipeWireLipsyncCapture, type SpawnFn } from './pipewireCapture.js';
import { clearStatus, publishTracking } from '../../mesh/status.js';

/** Where a lipsync behavior's audio comes from. */
export type LipsyncInputMode = 'browser' | 'pipewire';

/** The capture a behavior's config asks for, or null for browser input. */
function captureSpec(
  config: Record<string, unknown>
): { source: string; key: string } | null {
  if (config.inputMode !== 'pipewire') return null;
  const source = String(config.pipewireSource ?? '').trim();
  if (!source) return null;
  const templates = isValidTemplates(config.vowelTemplates)
    ? config.vowelTemplates
    : undefined;
  // Any change to the source or the templates restarts the capture.
  return { source, key: JSON.stringify([source, templates ?? null]) };
}

@BehaviorKind({
  kind: 'lipsync_processor',
  label: 'Lipsync',
  icon: '🎤',
  description:
    'Turns speech into VRM mouth shapes in real time — from a browser microphone, or server-side from a PipeWire source.',
  applicableTo: ['avatar'],
  defaultConfig: { sensitivity: 1.0, inputMode: 'browser', pipewireSource: '' },
})
export class LipsyncManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly nodeIds = new Map<string, string>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  /** Server-side PipeWire captures, by behavior id, with the spec they run. */
  private readonly captures = new Map<
    string,
    { capture: PipeWireLipsyncCapture; key: string }
  >();

  /** Injected in tests so no real `parec` is started. */
  constructor(private readonly spawnFn?: SpawnFn) {}

  private createGraph(behaviorId: string): SignalGraph {
    // The behavior's stored (editable) graph; the template if none is stored.
    const descriptor = behaviorDescriptorToRun(
      'lipsync_processor',
      behaviorId,
      this.configs.get(behaviorId)
    );
    this.descriptors.set(behaviorId, descriptor);
    if (!this.nodeStates.has(behaviorId))
      this.nodeStates.set(behaviorId, new Map());

    return SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this._getNodeConfig(behaviorId, nodeId),
      (nodeId) => this.nodeStates.get(behaviorId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(behaviorId)!.set(nodeId, state);
        this._persistNodeState(behaviorId, nodeId, state);
      },
      // Component graphs are always attached to a scene node.
      'scene_node'
    );
  }

  private _getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.configs.get(behaviorId) ?? {};
    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;
    // By node kind — including `_settings` for the `settings` nodes, which
    // this manager never injected, so `sensitivity` always read its default.
    return {
      ...defaults,
      ...overrides,
      ...behaviorContextConfig(nodeDef?.kind, {
        behaviorId,
        sceneNodeId: this.nodeIds.get(behaviorId) ?? '',
        settings: cfg,
      }),
    };
  }

  private _persistNodeState(
    behaviorId: string,
    nodeId: string,
    state: unknown
  ): void {
    try {
      const existing = getDb()
        .prepare('SELECT config FROM behaviors WHERE id = ?')
        .get(behaviorId) as { config: string } | undefined;
      if (!existing) return;
      const cfg = JSON.parse(existing.config || '{}') as Record<
        string,
        unknown
      >;
      const ns = (cfg._nodeState ?? {}) as Record<string, unknown>;
      ns[nodeId] = state;
      cfg._nodeState = ns;
      getDb()
        .prepare('UPDATE behaviors SET config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), behaviorId);
    } catch {
      /* non-fatal */
    }
  }

  start(behaviorId: string): void {
    if (this.graphs.has(behaviorId)) return;
    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);
    console.log(`[Lipsync] Started component ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    // Release the nodes' own resources (timers etc.) before dropping it.
    this.graphs.get(behaviorId)?.dispose();
    this.graphs.delete(behaviorId);
    this._stopCapture(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    console.log(`[Lipsync] Stopped component ${behaviorId}`);
  }

  syncBehaviors(
    comps: Array<{
      id: string;
      nodeId: string;
      kind: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>
  ): void {
    const active = new Set<string>();
    for (const c of comps) {
      if (c.kind !== 'lipsync_processor' || !c.enabled) continue;
      const { _nodeState: saved, ...liveConfig } = c.config;
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>();
      for (const [nid, st] of Object.entries(
        (saved ?? {}) as Record<string, unknown>
      )) {
        stateMap.set(nid, st);
      }
      this.nodeStates.set(c.id, stateMap);
      this.configs.set(c.id, liveConfig);
      this.nodeIds.set(c.id, c.nodeId);
      // Its stored graph was edited (or reset): rebuild the running one.
      if (
        this.graphs.has(c.id) &&
        programChanged(
          this.descriptors.get(c.id),
          behaviorDescriptorToRun('lipsync_processor', c.id, liveConfig)
        )
      )
        this.stop(c.id);
      this.start(c.id);
      active.add(c.id);
    }
    for (const id of this.graphs.keys()) {
      if (!active.has(id)) this.stop(id);
    }
    for (const c of comps) {
      if (active.has(c.id)) {
        this.configs.set(c.id, c.config);
        this.nodeIds.set(c.id, c.nodeId);
        this._syncCapture(c.id, c.config);
      }
    }
  }

  /**
   * Start, restart or stop the behavior's PipeWire capture to match its config.
   * A settings change does not rebuild the graph, so this runs on every sync.
   */
  private _syncCapture(behaviorId: string, config: Record<string, unknown>) {
    const spec = captureSpec(config);
    const running = this.captures.get(behaviorId);
    if (running && running.key === spec?.key) return;
    this._stopCapture(behaviorId);
    if (!spec) return;
    const templates = isValidTemplates(config.vowelTemplates)
      ? config.vowelTemplates
      : undefined;
    const capture = new PipeWireLipsyncCapture({
      source: spec.source,
      templates,
      spawn: this.spawnFn,
      onVisemes: (w) => this._fire(behaviorId, w),
      // The editor's status row and the scene graph's connection dot.
      onStatus: (status) =>
        publishTracking({
          behaviorId,
          connected: status.state === 'capturing',
          capture: status,
        }),
    });
    this.captures.set(behaviorId, { capture, key: spec.key });
    capture.start();
  }

  private _stopCapture(behaviorId: string): void {
    const running = this.captures.get(behaviorId);
    if (!running) return;
    this.captures.delete(behaviorId);
    running.capture.stop();
    clearStatus('tracking', behaviorId);
  }

  /** The input mode a running behavior is configured for. */
  inputMode(behaviorId: string): LipsyncInputMode {
    return this.configs.get(behaviorId)?.inputMode === 'pipewire'
      ? 'pipewire'
      : 'browser';
  }

  /** Whether a server-side capture is running for the behavior. */
  isCapturing(behaviorId: string): boolean {
    return this.captures.get(behaviorId)?.capture.running ?? false;
  }

  /**
   * Called by the WS handler for each lipsync_input message from the browser.
   * Ignored while the behavior takes its audio server-side, so a media-input
   * tab left open cannot fight the PipeWire capture over the mouth.
   */
  fireVisemes(behaviorId: string, visemes: Record<string, number>): void {
    if (this.inputMode(behaviorId) === 'pipewire') return;
    this._fire(behaviorId, visemes);
  }

  private _fire(behaviorId: string, visemes: Record<string, number>): void {
    const graph = this.graphs.get(behaviorId);
    if (!graph) return;
    const bs = Blendshapes.fromRecord(visemes);
    // Store in node state so lipsync_source.execute() can return it on pull.
    graph.setNodeState('lipsync_src', bs);
    graph.fire('lipsync_src', 'visemes', mkEvent(bs));
  }

  getStates(
    behaviorId: string
  ): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(behaviorId)?.getStates() ?? null;
  }

  getGraphDescriptor(behaviorId: string): GraphDescriptor | null {
    return this.descriptors.get(behaviorId) ?? null;
  }

  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  close(): void {
    for (const id of [...this.graphs.keys()]) this.stop(id);
  }
}
