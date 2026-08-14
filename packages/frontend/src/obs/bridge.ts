/**
 * OBS browser-source bridge (frontend half).
 *
 * vspark is commonly added to OBS as a Browser Source. The page inside that
 * source gets a `window.obsstudio` JS API, but the signal graph runs in the
 * backend. This module is the seam on the browser side:
 *
 *  - It forwards `window.obsstudio` events to the backend as `obs_event`
 *    messages (→ ObsManager → obs_* nodes).
 *  - It applies inbound `obs_command` messages by invoking the matching
 *    `window.obsstudio` control method (gated by the source's OBS permissions).
 *  - On every (re)connect it sends a `client_hello` so the backend can drive
 *    `client_lifecycle` nodes — this works even outside OBS (a plain browser
 *    tab is a render client too).
 *
 * See dev-notes/modules/obs.md.
 */
import { useEditorStore } from '../store/editorStore';
import type { ObsCommand, ObsEvent } from '@vspark/shared/types';

/** The subset of the OBS browser-source API we call. All methods are optional —
 *  availability depends on the source's OBS "page permission" level. */
interface ObsStudioApi {
  pluginVersion?: string;
  setCurrentScene?: (name: string) => void;
  setCurrentTransition?: (name: string) => void;
  startStreaming?: () => void;
  stopStreaming?: () => void;
  startRecording?: () => void;
  stopRecording?: () => void;
  pauseRecording?: () => void;
  unpauseRecording?: () => void;
  startReplayBuffer?: () => void;
  stopReplayBuffer?: () => void;
  saveReplayBuffer?: () => void;
  startVirtualcam?: () => void;
  stopVirtualcam?: () => void;
}

declare global {
  interface Window {
    obsstudio?: ObsStudioApi;
  }
}

/** Maps each OBS output run-state browser event to a normalised ObsEvent. */
const OUTPUT_EVENTS: Record<
  string,
  Extract<ObsEvent, { type: 'output_state' }>
> = {
  obsStreamingStarting: out('streaming', 'starting', true),
  obsStreamingStarted: out('streaming', 'started', true),
  obsStreamingStopping: out('streaming', 'stopping', false),
  obsStreamingStopped: out('streaming', 'stopped', false),
  obsRecordingStarting: out('recording', 'starting', true),
  obsRecordingStarted: out('recording', 'started', true),
  obsRecordingPaused: out('recording', 'paused', true),
  obsRecordingUnpaused: out('recording', 'unpaused', true),
  obsRecordingStopping: out('recording', 'stopping', false),
  obsRecordingStopped: out('recording', 'stopped', false),
  obsReplaybufferStarting: out('replay', 'starting', true),
  obsReplaybufferStarted: out('replay', 'started', true),
  obsReplaybufferSaved: out('replay', 'saved', true),
  obsReplaybufferStopping: out('replay', 'stopping', false),
  obsReplaybufferStopped: out('replay', 'stopped', false),
  obsVirtualcamStarted: out('virtualcam', 'started', true),
  obsVirtualcamStopped: out('virtualcam', 'stopped', false),
};

function out(
  output: Extract<ObsEvent, { type: 'output_state' }>['output'],
  state: Extract<ObsEvent, { type: 'output_state' }>['state'],
  active: boolean
): Extract<ObsEvent, { type: 'output_state' }> {
  return { type: 'output_state', output, state, active };
}

/** The socket to forward events on — refreshed on each (re)connect. */
let currentWs: WebSocket | null = null;
/** Listeners are attached to `window` once; they read `currentWs` at fire time. */
let listenersInstalled = false;

function send(kind: string, body: Record<string, unknown>): void {
  if (currentWs && currentWs.readyState === WebSocket.OPEN)
    currentWs.send(JSON.stringify({ kind, ...body }));
}

function forwardObsEvent(event: ObsEvent): void {
  send('obs_event', { event });
}

/** The render-target marker: an explicit `?obsTarget=` URL param wins, else the
 *  active scene id, else empty (unscoped). The marker is persistent — it must
 *  survive reconnects — so it comes from the URL/route, never the socket. */
function resolveTarget(): string {
  const param = new URLSearchParams(window.location.search).get('obsTarget');
  if (param) return param;
  return useEditorStore.getState().activeSceneId ?? '';
}

/** projectId from the store, falling back to the first URL path segment (the
 *  editor route is `/:projectId`, which is what an OBS source URL points at). */
function resolveProjectId(): string {
  const fromStore = useEditorStore.getState().projectId;
  if (fromStore) return fromStore;
  return window.location.pathname.split('/').filter(Boolean)[0] ?? '';
}

/** Called from useWsSync on every WS (re)open. Refreshes the socket, installs
 *  the OBS event listeners once, and announces this client. */
export function startObsBridge(ws: WebSocket): void {
  currentWs = ws;

  // Announce this render client (works with or without OBS present).
  const projectId = resolveProjectId();
  if (projectId) send('client_hello', { projectId, target: resolveTarget() });

  if (listenersInstalled) return;
  listenersInstalled = true;

  // OBS-only beyond this point.
  if (typeof window.obsstudio === 'undefined') return;

  window.addEventListener('obsSceneChanged', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { name?: string; width?: number; height?: number }
      | undefined;
    forwardObsEvent({
      type: 'scene_changed',
      name: detail?.name ?? '',
      width: detail?.width,
      height: detail?.height,
    });
  });

  for (const [eventName, payload] of Object.entries(OUTPUT_EVENTS)) {
    window.addEventListener(eventName, () => forwardObsEvent(payload));
  }
}

/** Apply an inbound obs_command by invoking the matching window.obsstudio call.
 *  No-ops outside OBS or when the method is unavailable at the source's
 *  permission level. */
export function handleObsCommand(command: ObsCommand): void {
  const api = window.obsstudio;
  if (!api) return;
  switch (command.verb) {
    case 'setCurrentScene':
      if (command.arg) api.setCurrentScene?.(command.arg);
      return;
    case 'setCurrentTransition':
      if (command.arg) api.setCurrentTransition?.(command.arg);
      return;
    default: {
      // All remaining verbs are arg-less and map 1:1 to a method name.
      const fn = api[command.verb];
      if (typeof fn === 'function') fn.call(api);
    }
  }
}
