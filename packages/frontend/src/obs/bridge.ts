/**
 * Render-client announcement (frontend half).
 *
 * vspark is commonly added to OBS as a Browser Source, but it is just as often
 * an ordinary browser tab. Either way the page is a *render client*, and the
 * signal graph that reacts to it runs in the backend — so on every WS
 * (re)connect the page sends a `client_hello` carrying its projectId and a
 * stable `target` marker, which drives `client_lifecycle` nodes.
 *
 * This module used to also bridge the `window.obsstudio` browser-source API —
 * forwarding its events as `obs_event` and applying `obs_command` control
 * calls. That path is gone: OBS gates those control calls behind the source's
 * "page permission" level and silently ignores anything above it, so actions
 * failed with no error and no log. All OBS control and state now goes over
 * obs-websocket, backend-side. See dev-notes/modules/obs.md.
 */
import { useEditorStore } from '../store/editorStore';

/** The socket to announce on — refreshed on each (re)connect. */
let currentWs: WebSocket | null = null;

function send(kind: string, body: Record<string, unknown>): void {
  if (currentWs && currentWs.readyState === WebSocket.OPEN)
    currentWs.send(JSON.stringify({ kind, ...body }));
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

/** Called from useWsSync on every WS (re)open: refreshes the socket and
 *  announces this render client. Works with or without OBS present. */
export function startObsBridge(ws: WebSocket): void {
  currentWs = ws;
  const projectId = resolveProjectId();
  if (projectId) send('client_hello', { projectId, target: resolveTarget() });
}
