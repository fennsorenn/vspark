/**
 * Capture provider SPI.
 *
 * The seam this whole feature hangs off already existed: `TrackingManager.fireLandmarks()`
 * and `LipsyncManager.fireVisemes()` are source-agnostic, and `index.ts` was the only thing
 * coupling them to the browser. A capture provider is therefore just *another caller* of
 * those two methods — nothing downstream (signal graphs, arkit_vrm_mapper, pose_merge,
 * calibration, broadcastBus, viewport) knows or cares which one is running.
 *
 * Two providers exist deliberately, to be A/B'd on the target machine under real load:
 *
 *   browser_agent   — spawns an installed Chromium-family browser at /media-input, reusing
 *                     the existing capture page verbatim. GPU inference; subject to
 *                     Windows EcoQoS demotion.
 *   node_inference  — in-process CPU inference (Human + tfjs-node, lazily loaded). Immune
 *                     to Chromium's self-demotion; costs ~1 core.
 *
 * See dev-notes/plans/server-side-capture.md for why both, and what is being measured.
 */

import type { Landmark } from '@vspark/shared';

export type CaptureKind = 'tracking' | 'lipsync';

/** Where a behaviour's input comes from. Persisted on the behaviour config. */
export type CaptureSource = 'browser' | 'server';

export type CaptureProviderId = 'browser_agent' | 'node_inference';

export const CAPTURE_PROVIDER_IDS: CaptureProviderId[] = [
  'browser_agent',
  'node_inference',
];

export const DEFAULT_CAPTURE_PROVIDER: CaptureProviderId = 'browser_agent';

export function isCaptureProviderId(v: unknown): v is CaptureProviderId {
  return (
    typeof v === 'string' &&
    (CAPTURE_PROVIDER_IDS as string[]).includes(v)
  );
}

export interface CaptureDevice {
  id: string;
  label: string;
  kind: 'videoinput' | 'audioinput';
}

/** Landmark payload — the same shape the browser sends over `tracking_input`. */
export interface CaptureLandmarkFrame {
  face?: Landmark[];
  leftHand?: Landmark[];
  rightHand?: Landmark[];
  pose?: Landmark[];
  faceBlendshapes?: Record<string, number>;
}

export interface CaptureRequest {
  behaviorId: string;
  /** Owning scene node — needed to build the agent URL and for logging. */
  nodeId: string;
  /** Owning project — the browser agent navigates to /media-input/:projectId. */
  projectId: string;
  kind: CaptureKind;
  /** Capture device to open. Undefined = system default. */
  deviceId?: string;
  /** Behaviour config, verbatim (enableFace/Pose/Hands, vowelTemplates, …). */
  config: Record<string, unknown>;
}

/**
 * Where a provider delivers its output. Injected by the CaptureManager and bound to the
 * behaviour managers, so a provider never imports them directly.
 */
export interface CaptureSink {
  landmarks(behaviorId: string, frame: CaptureLandmarkFrame): void;
  visemes(behaviorId: string, weights: Record<string, number>): void;
  error(behaviorId: string, err: Error): void;
}

export interface CaptureProviderStatus {
  id: CaptureProviderId;
  /** False when the provider can't run here (no browser found, tfjs-node not installed). */
  available: boolean;
  /** Why it isn't available, or the last runtime failure. */
  detail: string | null;
  /** Behaviour ids this provider currently has running. */
  running: string[];
}

export interface CaptureProvider {
  readonly id: CaptureProviderId;
  /** Which capture kinds this provider can serve. */
  readonly kinds: CaptureKind[];
  /**
   * Whether the provider can run on this machine. Resolved lazily and cached — for
   * `node_inference` this is what determines whether the optional tfjs-node dependency
   * is actually installed.
   */
  probe(): Promise<{ available: boolean; detail: string | null }>;
  start(req: CaptureRequest): Promise<void>;
  stop(behaviorId: string): Promise<void>;
  listDevices(): Promise<CaptureDevice[]>;
  status(): CaptureProviderStatus;
  close(): Promise<void>;
}
