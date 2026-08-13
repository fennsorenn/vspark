/**
 * Behavior managers: the singletons, and re-syncing them from the DB.
 *
 * Extracted from routes/shared.ts so the mesh persistence tap can call
 * `refreshAllBehaviorManagers` without importing a routes module — which would
 * cycle, since routes reach back into the mesh for their collections.
 *
 * Why the tap and not the routes: attaching or detaching a behavior is what
 * instantiates or tears down its signal graph, and a behavior authored on the
 * mesh (by a tab, an undo, or a collab peer) never passes through a route. The
 * side effect belongs where the state actually changes.
 *
 * Each refresher re-reads its kind's rows and hands the manager the full set,
 * so it is idempotent and order-independent — the tap can call it after any
 * committed change without knowing what changed.
 */
import { getDb } from '../db/index.js';
import type { VmcManager } from './vmc_receiver/manager.js';
import type { IFacialMocapManager } from './ifacialmocap_receiver/manager.js';
import type { BreathingManager } from './breathing/manager.js';
import type { ManualCalibrationManager } from './manual_calibration/manager.js';
import type { PoseStylizerManager } from './pose_stylizer/manager.js';
import type { BlendshapeLimiterManager } from './blendshape_limiter/manager.js';
import type { LipsyncManager } from './lipsync/manager.js';
import type { TrackingManager } from './mediapipe_tracker/manager.js';
import type { ApiControllerManager } from './api_controller/manager.js';

// --- Manager singletons + setters ---

export let _vmc: VmcManager | null = null;
export function setVmcManager(m: VmcManager) {
  _vmc = m;
}

export let _ifacialMocap: IFacialMocapManager | null = null;
export function setIFacialMocapManager(m: IFacialMocapManager) {
  _ifacialMocap = m;
}

export let _breathing: BreathingManager | null = null;
export function setBreathingManager(m: BreathingManager) {
  _breathing = m;
}

export let _manualCalibration: ManualCalibrationManager | null = null;
export function setManualCalibrationManager(m: ManualCalibrationManager) {
  _manualCalibration = m;
}

export let _poseStylizer: PoseStylizerManager | null = null;
export function setPoseStylizerManager(m: PoseStylizerManager) {
  _poseStylizer = m;
}

export let _blendshapeLimiter: BlendshapeLimiterManager | null = null;
export function setBlendshapeLimiterManager(m: BlendshapeLimiterManager) {
  _blendshapeLimiter = m;
}

export let _lipsync: LipsyncManager | null = null;
export function setLipsyncManager(m: LipsyncManager) {
  _lipsync = m;
}

export let _tracking: TrackingManager | null = null;
export function setTrackingManager(m: TrackingManager) {
  _tracking = m;
}

export let _apiController: ApiControllerManager | null = null;
export function setApiControllerManager(m: ApiControllerManager) {
  _apiController = m;
}

/** Relay a user-initiated clip playback control to collab peers. Injected by the
 *  entrypoint (avoids a routes→multiplayer import cycle); only the playback routes
 *  call it, so collab-applied playback can't echo back. */
// --- Component row mapping + refresh helpers ---

export function _mapBehaviorRow(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    kind: r.kind as string,
    enabled: (r.enabled as number) === 1,
    config: JSON.parse((r.config as string) || '{}'),
  };
}

export function refreshVmc() {
  if (!_vmc) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'vmc_receiver'")
    .all() as Record<string, unknown>[];
  _vmc.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshIFacialMocap() {
  if (!_ifacialMocap) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'ifacialmocap_receiver'")
    .all() as Record<string, unknown>[];
  _ifacialMocap.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshBreathing() {
  if (!_breathing) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'breathing'")
    .all() as Record<string, unknown>[];
  _breathing.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshManualCalibration() {
  if (!_manualCalibration) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'manual_calibration'")
    .all() as Record<string, unknown>[];
  _manualCalibration.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshPoseStylizer() {
  if (!_poseStylizer) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'pose_stylizer'")
    .all() as Record<string, unknown>[];
  _poseStylizer.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshBlendshapeLimiter() {
  if (!_blendshapeLimiter) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'blendshape_limiter'")
    .all() as Record<string, unknown>[];
  _blendshapeLimiter.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshLipsync() {
  if (!_lipsync) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'lipsync_processor'")
    .all() as Record<string, unknown>[];
  _lipsync.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshTracking() {
  if (!_tracking) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'mediapipe_tracker'")
    .all() as Record<string, unknown>[];
  _tracking.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshApiController() {
  if (!_apiController) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'api_controller'")
    .all() as Record<string, unknown>[];
  _apiController.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshAllBehaviorManagers() {
  refreshVmc();
  refreshIFacialMocap();
  refreshBreathing();
  refreshManualCalibration();
  refreshPoseStylizer();
  refreshBlendshapeLimiter();
  refreshLipsync();
  refreshTracking();
  refreshApiController();
}
