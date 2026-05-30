/**
 * Seed a manual Phase-1 test setup into a running vspark backend.
 *
 *   pnpm tsx scripts/seed-test-setup.ts <projectId> <sceneId> [--reset] [--api=http://localhost:3001]
 *
 * Creates, in the named scene:
 *   - A group scene_node `__test-setup root` at position (0, 1.4, 0) — a
 *     static template showing the layout (billboard + text label side by
 *     side). Leave it visible to verify the static render, or hide it in
 *     the editor so only spawns show up.
 *   - Two children of the group:
 *       · a billboard scene_node (placeholder textureUrl — replace via the
 *         editor if you have one).
 *       · a text_canvas scene_node with default "Hello!" content.
 *   - A track clip `__test-setup move` owned by the *text_canvas* child:
 *     relative-mode, non-looping, 4s, lane `position.x` sweeping -3 → +3.
 *     Owning at the text_canvas (not the group) means `spawn_clip` clones
 *     only that node — exactly what we want for a per-chat-message overlay.
 *   - A project-scoped graph `__test-setup chat-billboard` wired as:
 *       overlive_chat_message (configured to the first overlive account in
 *         the project, if any) →
 *       spawn_clip (clipId = the test clip above) →
 *       set_text (spawnRef-targeted; rewrites the spawned text_canvas
 *         instance's text.content from the chat event's text).
 *
 * Notes:
 *   - With `--reset` the script first deletes any rows whose name starts
 *     with `__test-setup`. It walks scene_nodes / track_clips / graphs in
 *     the named scene + project; nothing without the prefix is touched.
 *   - Requires the backend dev server to be running on the given URL.
 */
// Plain `process` is a Node global — no import needed; tsx executes this
// at runtime. The workspace lint doesn't cover scripts/, so we don't need
// to worry about missing @types/node here.

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { status?: number; message?: string; code?: string };
}
type ApiResult<T> = ApiOk<T> | ApiErr;

interface NodeRow {
  id: string;
  name: string;
  kind: string;
}
interface ClipRow {
  id: string;
  name: string;
}
interface GraphRow {
  id: string;
  name: string;
}
interface OverliveAccount {
  id: string;
  channel?: string | null;
}

const NAME_PREFIX = '__test-setup';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId || !args.sceneId) {
    console.error(
      'usage: pnpm tsx scripts/seed-test-setup.ts <projectId> <sceneId> [--reset] [--api=http://localhost:3001]'
    );
    process.exit(2);
  }
  const api = makeApi(args.apiBase);

  if (args.reset) {
    await teardown(api, args.sceneId, args.projectId);
  }

  // Refuse to clobber an existing test setup.
  const sceneNodes = await api<NodeRow[]>(
    `/api/scenes/${encodeURIComponent(args.sceneId)}/nodes`
  );
  if (sceneNodes.some((n) => n.name.startsWith(NAME_PREFIX))) {
    console.error(
      `[seed] scene already contains '${NAME_PREFIX}*' rows. Re-run with --reset to recreate.`
    );
    process.exit(1);
  }

  // 1. Group node at the scene root.
  const group = await api<NodeRow>(
    `/api/scenes/${encodeURIComponent(args.sceneId)}/nodes`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${NAME_PREFIX} root`,
        kind: 'group',
        parentId: null,
        components: { transform: { x: 0, y: 1.4, z: 0 } },
        properties: {},
      }),
    }
  );
  console.log(`[seed] group: ${group.id}`);

  // 2. Billboard child.
  const billboard = await api<NodeRow>(
    `/api/scenes/${encodeURIComponent(args.sceneId)}/nodes`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${NAME_PREFIX} billboard`,
        kind: 'billboard',
        parentId: group.id,
        components: {
          transform: { x: -0.4, y: 0, z: 0, sx: 0.5, sy: 0.5, sz: 0.5 },
          billboard: {
            facing: 'screen',
            backface: 'mirror',
            width: 1,
            height: 1,
            alpha: 1,
            // Caller can replace with an asset URL; leaving null shows a
            // coloured placeholder mesh.
            textureUrl: null,
          },
        },
        properties: {},
      }),
    }
  );
  console.log(`[seed] billboard: ${billboard.id}`);

  // 3. text_canvas child.
  const textNode = await api<NodeRow>(
    `/api/scenes/${encodeURIComponent(args.sceneId)}/nodes`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${NAME_PREFIX} text`,
        kind: 'text_canvas',
        parentId: group.id,
        components: {
          transform: { x: 0.4, y: 0, z: 0 },
          text: {
            content: 'Hello!',
            fontSize: 48,
            color: '#ffffff',
            padding: 16,
            width: 2,
            height: 0.5,
            billboard: true,
          },
        },
        properties: {},
      }),
    }
  );
  console.log(`[seed] text_canvas: ${textNode.id}`);

  // 4. Track clip owned by the text_canvas child: relative-mode, non-looping,
  // 4s. Owning at the text_canvas means `spawn_clip` clones exactly that
  // node — one tmp text bubble per chat message.
  const clip = await api<ClipRow>(
    `/api/scene-nodes/${encodeURIComponent(textNode.id)}/track-clips`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${NAME_PREFIX} move`,
        duration: 4,
        loop: false,
        mode: 'relative',
        autoplay: false,
      }),
    }
  );
  console.log(`[seed] clip: ${clip.id}`);

  // Lane: position.x relative sweep -3 → +3 on the text_canvas itself.
  const lane = await api<{ id: string }>(
    `/api/track-clips/${encodeURIComponent(clip.id)}/lanes`,
    {
      method: 'POST',
      body: JSON.stringify({
        targetKind: 'scene_node',
        targetId: textNode.id,
        paramPath: 'position.x',
        defaultValue: 0,
      }),
    }
  );
  console.log(`[seed] lane: ${lane.id}`);
  await api(
    `/api/track-clip-lanes/${encodeURIComponent(lane.id)}/keyframes`,
    {
      method: 'PUT',
      body: JSON.stringify({
        keyframes: [
          { t: 0, value: -3, easing: 'linear' },
          { t: 4, value: 3, easing: 'linear' },
        ],
      }),
    }
  );

  // 5. Project-scoped graph wiring overlive chat → spawn_clip → set_text.
  // Pick the first overlive account in the project, if any, to pre-fill the
  // `account` defaultConfig on the chat node.
  const accounts = await api<OverliveAccount[]>(
    `/api/projects/${encodeURIComponent(args.projectId)}/overlive-accounts`
  ).catch(() => [] as OverliveAccount[]);
  const accountId = accounts[0]?.id ?? '';
  if (!accountId) {
    console.warn(
      '[seed] no overlive accounts found; the chat node will be wired with an empty account id (no events will route through).'
    );
  } else {
    console.log(`[seed] overlive account: ${accountId}`);
  }

  const graph = await api<GraphRow>(
    `/api/projects/${encodeURIComponent(args.projectId)}/graphs`,
    {
      method: 'POST',
      body: JSON.stringify({ name: `${NAME_PREFIX} chat-billboard` }),
    }
  );

  const descriptor = {
    id: graph.id,
    label: `${NAME_PREFIX} chat-billboard`,
    readonly: false,
    nodes: [
      {
        id: 'chat',
        kind: 'overlive_chat_message',
        position: { x: 0, y: 0 },
        defaultConfig: { account: accountId, channel: '' },
      },
      {
        id: 'spawn',
        kind: 'spawn_clip',
        position: { x: 320, y: 0 },
        defaultConfig: { clipId: clip.id },
      },
      {
        id: 'setText',
        kind: 'set_text',
        position: { x: 640, y: 0 },
        // No targetId — relies on spawnRef. spawn_clip clones the
        // text_canvas (the clip's owner), and `text.content` is a
        // registered paramPath for text_canvas, so the write lands.
        defaultConfig: { targetKind: 'scene_node' },
      },
    ],
    edges: [
      {
        fromNodeId: 'chat',
        fromPort: 'event',
        toNodeId: 'spawn',
        toPort: 'fire',
        kind: 'event',
      },
      {
        fromNodeId: 'spawn',
        fromPort: 'spawned',
        toNodeId: 'setText',
        toPort: 'spawnRef',
        kind: 'event',
      },
      {
        fromNodeId: 'chat',
        fromPort: 'text',
        toNodeId: 'setText',
        toPort: 'text',
        kind: 'value',
      },
    ],
  };
  await api(`/api/graphs/${encodeURIComponent(graph.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, descriptor }),
  });
  console.log(`[seed] graph: ${graph.id}`);

  console.log('\n[seed] done. Try:');
  console.log(
    `  curl -X POST ${args.apiBase}/api/track-clips/${clip.id}/trigger     # animate the static text_canvas across the screen`
  );
  console.log(
    `  send an overlive chat message                                 # spawn a tmp text_canvas + animate + auto-despawn`
  );
  console.log(`  pnpm tsx scripts/seed-test-setup.ts ${args.projectId} ${args.sceneId} --reset   # tear it all down`);
}

async function teardown(
  api: ReturnType<typeof makeApi>,
  sceneId: string,
  projectId: string
): Promise<void> {
  // Order matters because of foreign-key cascades:
  // graphs (project) → track_clips (owned by group) → scene_nodes (cascade
  // deletes children + components).
  const graphs = await api<GraphRow[]>(
    `/api/projects/${encodeURIComponent(projectId)}/graphs`
  );
  for (const g of graphs) {
    if (g.name.startsWith(NAME_PREFIX)) {
      await api(`/api/graphs/${encodeURIComponent(g.id)}`, {
        method: 'DELETE',
      });
      console.log(`[reset] graph removed: ${g.id}`);
    }
  }
  const nodes = await api<NodeRow[]>(
    `/api/scenes/${encodeURIComponent(sceneId)}/nodes`
  );
  for (const n of nodes) {
    if (!n.name.startsWith(NAME_PREFIX)) continue;
    // Clips owned by this node first (route delete cascades by FK once the
    // node row is gone, but we delete explicitly so the playback manager
    // gets the per-clip stop signal).
    const clips = await api<ClipRow[]>(
      `/api/scene-nodes/${encodeURIComponent(n.id)}/track-clips`
    ).catch(() => [] as ClipRow[]);
    for (const c of clips) {
      await api(`/api/track-clips/${encodeURIComponent(c.id)}`, {
        method: 'DELETE',
      });
      console.log(`[reset] clip removed: ${c.id}`);
    }
    await api(`/api/scene-nodes/${encodeURIComponent(n.id)}`, {
      method: 'DELETE',
    });
    console.log(`[reset] node removed: ${n.id}`);
  }
}

interface Args {
  projectId: string;
  sceneId: string;
  reset: boolean;
  apiBase: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let reset = false;
  let apiBase = 'http://localhost:3001';
  for (const a of argv) {
    if (a === '--reset') reset = true;
    else if (a.startsWith('--api=')) apiBase = a.slice('--api='.length);
    else positional.push(a);
  }
  return {
    projectId: positional[0] ?? '',
    sceneId: positional[1] ?? '',
    reset,
    apiBase,
  };
}

function makeApi(base: string) {
  return async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as ApiResult<T>;
    if (!res.ok || !body.ok) {
      const msg = !body.ok ? body.error?.message ?? res.statusText : res.statusText;
      throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${msg}`);
    }
    return body.data;
  };
}

void main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
