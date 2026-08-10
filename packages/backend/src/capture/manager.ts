/**
 * CaptureManager — owns the server-side capture providers and reconciles them against
 * behaviour state.
 *
 * A `mediapipe_tracker` / `lipsync_processor` behaviour carries `config.source`:
 *
 *   'browser' (default) — unchanged behaviour. The user's tab captures and uplinks over
 *                         WebSocket. Nothing here runs.
 *   'server'            — a provider captures on the server and calls the same behaviour
 *                         manager entry points directly.
 *
 * The two must never both feed one behaviour: they'd fight over a single `behaviorId`
 * slot on the broadcast bus and the avatar would judder between two poses. So a
 * server-sourced behaviour makes `acceptsBrowserInput()` false, and the WS dispatch in
 * index.ts drops browser frames for it.
 */

import { getDb } from '../db/index.js';
import { captureMetrics } from './metrics.js';
import {
  DEFAULT_CAPTURE_PROVIDER,
  isCaptureProviderId,
  type CaptureDevice,
  type CaptureKind,
  type CaptureProvider,
  type CaptureProviderId,
  type CaptureProviderStatus,
  type CaptureRequest,
  type CaptureSink,
} from './types.js';

export interface CaptureBehaviorRow {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

const KIND_BY_BEHAVIOR: Record<string, CaptureKind> = {
  mediapipe_tracker: 'tracking',
  lipsync_processor: 'lipsync',
};

interface ActiveCapture {
  behaviorId: string;
  provider: CaptureProviderId;
  kind: CaptureKind;
  /** Serialised request, to detect a config change that needs a restart. */
  signature: string;
}

export class CaptureManager {
  private readonly providers = new Map<CaptureProviderId, CaptureProvider>();
  private readonly active = new Map<string, ActiveCapture>();
  /** Behaviour ids currently sourced from the server — browser input is refused for these. */
  private readonly serverSourced = new Set<string>();
  /**
   * Forces every server-sourced behaviour onto one provider regardless of its config.
   * This is the A/B switch: flip it, re-sync, and the same behaviours re-capture through
   * the other provider without touching any persisted state.
   */
  private providerOverride: CaptureProviderId | null = null;
  private readonly errors = new Map<string, string>();

  constructor(private readonly sink: CaptureSink) {}

  register(provider: CaptureProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: CaptureProviderId): CaptureProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** True unless the behaviour is server-sourced (in which case browser frames are dropped). */
  acceptsBrowserInput(behaviorId: string): boolean {
    return !this.serverSourced.has(behaviorId);
  }

  setProviderOverride(id: CaptureProviderId | null): void {
    this.providerOverride = id;
  }

  getProviderOverride(): CaptureProviderId | null {
    return this.providerOverride;
  }

  /**
   * Reconcile against the full set of capture-capable behaviours. Safe to call on every
   * behaviour mutation — unchanged captures are left running untouched.
   */
  syncBehaviors(rows: CaptureBehaviorRow[]): void {
    const desired = new Map<string, CaptureRequest & { provider: CaptureProviderId }>();

    for (const row of rows) {
      const kind = KIND_BY_BEHAVIOR[row.kind];
      if (!kind || !row.enabled) continue;
      if (row.config.source !== 'server') continue;

      const provider =
        this.providerOverride ??
        (isCaptureProviderId(row.config.provider)
          ? row.config.provider
          : DEFAULT_CAPTURE_PROVIDER);

      const projectId = this.projectIdForNode(row.nodeId);
      if (!projectId) {
        this.errors.set(
          row.id,
          `no project found for scene node ${row.nodeId}; cannot start server capture`
        );
        continue;
      }

      desired.set(row.id, {
        behaviorId: row.id,
        nodeId: row.nodeId,
        projectId,
        kind,
        deviceId:
          typeof row.config.deviceId === 'string' ? row.config.deviceId : undefined,
        config: row.config,
        provider,
      });
    }

    // A behaviour is server-sourced the moment it's configured that way, independent of
    // whether its provider actually managed to start. Otherwise a provider that fails to
    // launch would silently fall back to browser frames, which is the confusing outcome:
    // the user sees tracking "work" and never learns the server path is broken.
    this.serverSourced.clear();
    for (const id of desired.keys()) this.serverSourced.add(id);

    for (const [behaviorId, current] of [...this.active]) {
      const want = desired.get(behaviorId);
      if (!want || want.provider !== current.provider) {
        void this.stopOne(behaviorId);
      }
    }

    for (const [behaviorId, req] of desired) {
      const current = this.active.get(behaviorId);
      const signature = JSON.stringify([req.provider, req.deviceId, req.config]);
      if (current && current.signature === signature) continue;
      if (current) void this.stopOne(behaviorId);
      void this.startOne(req, signature);
    }
  }

  private async startOne(
    req: CaptureRequest & { provider: CaptureProviderId },
    signature: string
  ): Promise<void> {
    const provider = this.providers.get(req.provider);
    if (!provider) {
      this.errors.set(req.behaviorId, `unknown capture provider "${req.provider}"`);
      return;
    }
    if (!provider.kinds.includes(req.kind)) {
      this.errors.set(
        req.behaviorId,
        `provider "${req.provider}" cannot serve ${req.kind} capture`
      );
      return;
    }
    const probe = await provider.probe();
    if (!probe.available) {
      this.errors.set(
        req.behaviorId,
        `provider "${req.provider}" unavailable: ${probe.detail ?? 'unknown reason'}`
      );
      return;
    }
    try {
      await provider.start(req);
      this.active.set(req.behaviorId, {
        behaviorId: req.behaviorId,
        provider: req.provider,
        kind: req.kind,
        signature,
      });
      this.errors.delete(req.behaviorId);
      captureMetrics.begin(req.behaviorId, req.kind, req.provider);
      console.log(
        `[capture] started ${req.kind} for behavior ${req.behaviorId} via ${req.provider}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.set(req.behaviorId, msg);
      console.error(`[capture] failed to start ${req.behaviorId}: ${msg}`);
      this.sink.error(req.behaviorId, e instanceof Error ? e : new Error(msg));
    }
  }

  private async stopOne(behaviorId: string): Promise<void> {
    const current = this.active.get(behaviorId);
    if (!current) return;
    this.active.delete(behaviorId);
    captureMetrics.end(behaviorId);
    try {
      await this.providers.get(current.provider)?.stop(behaviorId);
      console.log(`[capture] stopped ${behaviorId} (${current.provider})`);
    } catch (e) {
      console.error(`[capture] error stopping ${behaviorId}:`, e);
    }
  }

  async listDevices(id: CaptureProviderId): Promise<CaptureDevice[]> {
    const provider = this.providers.get(id);
    if (!provider) return [];
    const probe = await provider.probe();
    if (!probe.available) return [];
    return provider.listDevices();
  }

  async statuses(): Promise<CaptureProviderStatus[]> {
    const out: CaptureProviderStatus[] = [];
    for (const provider of this.providers.values()) {
      const probe = await provider.probe();
      const status = provider.status();
      out.push({ ...status, available: probe.available, detail: probe.detail ?? status.detail });
    }
    return out;
  }

  /** Per-behaviour start failures, so the UI can say why server capture isn't running. */
  getErrors(): Record<string, string> {
    return Object.fromEntries(this.errors);
  }

  private projectIdForNode(nodeId: string): string | null {
    try {
      const row = getDb()
        .prepare('SELECT project_id FROM scene_nodes WHERE id = ?')
        .get(nodeId) as { project_id?: string } | undefined;
      return row?.project_id ?? null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    for (const behaviorId of [...this.active.keys()]) await this.stopOne(behaviorId);
    for (const provider of this.providers.values()) {
      try {
        await provider.close();
      } catch (e) {
        console.error(`[capture] error closing provider ${provider.id}:`, e);
      }
    }
  }
}
