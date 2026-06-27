/**
 * The single source of truth for the vspark MCP tool catalog. Each tool is a
 * name + description + a zod input shape + a handler that drives the REST API
 * through a {@link VsparkClient}. server.ts registers these on an McpServer;
 * the assistant agent lists/calls them through an in-memory MCP client.
 *
 * Tool descriptions deliberately encode the non-obvious API semantics that an
 * agent cannot discover by introspection (and that the API does NOT validate):
 *   - scene-node `components` vs `properties` are two different bags;
 *   - compose-layer `config` is REPLACED wholesale on update, not merged;
 *   - logic graphs are created empty, then wired with set_logic_descriptor;
 *   - signal-node port/kind names come from the node-kind catalog, not guesses.
 */
import { z, type ZodRawShape } from 'zod';
import type { VsparkClient } from './client.js';

export interface ToolSpec {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  handler: (
    client: VsparkClient,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}

const SCENE_NODE_KINDS =
  'avatar, model, light, camera, group, particle, billboard, video, audio, text_troika, text_canvas, feed';
const LAYER_KINDS = 'image, video, audio, browser, text, feed, group';

export function buildToolSpecs(): ToolSpec[] {
  return [
    // ---- Discovery ----
    {
      name: 'list_projects',
      description: 'List all vspark projects (id + name).',
      inputShape: {},
      handler: (c) => c.get('/api/projects'),
    },
    {
      name: 'list_scenes',
      description:
        'List the 3D scenes and their nodes for a project. A scene is a scene_node with kind="scene"; its id is the sceneId used to create nodes.',
      inputShape: { projectId: z.string() },
      handler: (c, a) => c.get(`/api/projects/${a.projectId}/scenes`),
    },
    {
      name: 'create_scene',
      description: 'Create a new 3D scene in a project. Returns the scene id.',
      inputShape: { projectId: z.string(), name: z.string() },
      handler: (c, a) =>
        c.post(`/api/projects/${a.projectId}/scenes`, { name: a.name }),
    },
    {
      name: 'list_scene_nodes',
      description: 'List the nodes (objects) within a scene.',
      inputShape: { sceneId: z.string() },
      handler: (c, a) => c.get(`/api/scenes/${a.sceneId}/nodes`),
    },

    // ---- Presets (PREFER these over building from scratch) ----
    {
      name: 'list_presets',
      description:
        'List reusable presets you can instantiate as a ready-made starting point. ' +
        'Returns BUILT-IN presets (prewired and tested) plus the project’s saved presets; ' +
        'each entry is {id, name, description, rootKind, builtin}. ' +
        'ALWAYS check this first when a request matches a common building block — e.g. a chat / ' +
        'feed overlay (a feed node already wired to its data graph), an event alert overlay, a ' +
        'particle effect, or a lighting rig — and instantiate the closest match instead of ' +
        'hand-building objects, feed templates, or logic graphs. rootKind ("compose_layer" or ' +
        '"scene_node") tells you how to instantiate it (see instantiate_preset).',
      inputShape: { projectId: z.string() },
      handler: async (c, a) => {
        const tag = (arr: unknown, builtin: boolean) =>
          (Array.isArray(arr) ? arr : []).map((p: Record<string, unknown>) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            rootKind: p.rootKind,
            builtin,
          }));
        const builtin = await c.get('/api/presets/builtin');
        const project = await c.get(`/api/projects/${a.projectId}/presets`);
        return { presets: [...tag(builtin, true), ...tag(project, false)] };
      },
    },
    {
      name: 'instantiate_preset',
      description:
        'Instantiate a preset (id from list_presets) into a project. This creates the ENTIRE ' +
        'prewired subtree — objects, compose layers, feed templates, logic graphs, track clips — ' +
        'in a single step, with all internal ids freshly minted. ' +
        'Target by the preset’s rootKind: for a "compose_layer" preset pass rootComposeSceneId ' +
        '(a compose scene id — create one first with create_compose_scene if the project has none); ' +
        'for a "scene_node" preset pass rootSceneNodeId (a scene id). ' +
        'Optional: parentId nests the result under an existing node/layer; boneAttachment attaches a ' +
        'scene-node preset to an avatar bone. Returns {rootId, idMap, missingAssets}. ' +
        'After instantiating, read the new subtree back and adjust only what the user asked to change ' +
        '(e.g. rename it, set the account, edit the template) rather than rebuilding it.',
      inputShape: {
        presetId: z.string(),
        projectId: z.string(),
        rootSceneNodeId: z.string().optional(),
        rootComposeSceneId: z.string().optional(),
        parentId: z.string().optional(),
        boneAttachment: z.string().optional(),
      },
      handler: async (c, a) => {
        const presetId = String(a.presetId);
        const full = (await (presetId.startsWith('builtin:')
          ? c.get(`/api/presets/builtin/${presetId}`)
          : c.get(`/api/presets/${presetId}`))) as { payload?: unknown };
        const payload = full?.payload ?? full;
        const body: Record<string, unknown> = {
          payload,
          projectId: a.projectId,
        };
        for (const k of [
          'rootSceneNodeId',
          'rootComposeSceneId',
          'parentId',
          'boneAttachment',
        ]) {
          if (a[k] != null) body[k] = a[k];
        }
        return c.post('/api/presets/instantiate', body);
      },
    },

    // ---- Scene nodes (objects) ----
    {
      name: 'create_scene_node',
      description:
        `Create an object in a scene. kind is one of: ${SCENE_NODE_KINDS}.\n` +
        'IMPORTANT — vspark has TWO separate data bags, do not confuse them:\n' +
        '• components = ECS components keyed by type. Transform goes here as key "transform" with FLAT fields: ' +
        '{"type":"transform","x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0,"sx":1,"sy":1,"sz":1} (position is x/y/z, NOT a nested {position:{...}}). ' +
        'A light goes here as key "light": {"type":"light","lightType":"point"|"directional"|"ambient"|"spot","color":"#rrggbb","intensity":1}. ' +
        'A feed object uses key "feed": {"type":"feed","template":"<htm>","css":"..."}.\n' +
        '• properties = node-level settings (blendTransitionTime, poseDynamics, …). Do NOT put transform/light here.',
      inputShape: {
        sceneId: z.string(),
        name: z.string(),
        kind: z.string(),
        parentId: z.string().optional(),
        boneAttachment: z.string().optional(),
        filePath: z.string().optional(),
        components: z.record(z.string(), z.unknown()).optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
      },
      handler: (c, a) => {
        const { sceneId, ...body } = a;
        return c.post(`/api/scenes/${sceneId}/nodes`, body);
      },
    },
    {
      name: 'update_scene_node',
      description:
        'Patch an object. Only provided fields change. `properties` shallow-merges onto the existing bag; ' +
        '`components` REPLACES the whole components bag (resend every component you want to keep). ' +
        'Use the same flat component shapes as create_scene_node.',
      inputShape: {
        id: z.string(),
        name: z.string().optional(),
        kind: z.string().optional(),
        parentId: z.string().nullable().optional(),
        filePath: z.string().optional(),
        components: z.record(z.string(), z.unknown()).optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        hidden: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { id, ...body } = a;
        return c.put(`/api/scene-nodes/${id}`, body);
      },
    },
    {
      name: 'delete_scene_node',
      description: 'Delete an object (cascades to its behaviors/effects).',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/scene-nodes/${a.id}`),
    },

    // ---- Compose scenes + layers (2D overlays) ----
    {
      name: 'list_compose_scenes',
      description: 'List the 2D compose (overlay) scenes for a project.',
      inputShape: { projectId: z.string() },
      handler: (c, a) => c.get(`/api/projects/${a.projectId}/compose-scenes`),
    },
    {
      name: 'create_compose_scene',
      description:
        'Create a 2D compose (overlay) scene container in a project. Defaults to 1920x1080. Returns its id.',
      inputShape: {
        projectId: z.string(),
        name: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
      },
      handler: (c, a) => {
        const { projectId, ...body } = a;
        return c.post(`/api/projects/${projectId}/compose-scenes`, body);
      },
    },
    {
      name: 'list_compose_layers',
      description: 'List the layers inside a compose scene.',
      inputShape: { composeSceneId: z.string() },
      handler: (c, a) =>
        c.get(`/api/compose-scenes/${a.composeSceneId}/layers`),
    },
    {
      name: 'create_compose_layer',
      description:
        `Create a layer in a compose scene. kind is one of: ${LAYER_KINDS}.\n` +
        'A "feed" layer renders live data through a template held in config.template (htm/JSX-ish: ' +
        '`{chat.map(m => `<div>${m.text}</div>`).join("")}`) styled by config.css. The chat data is exposed ' +
        'in the template as the bare variable `chat` (an array of message objects with .text).',
      inputShape: {
        composeSceneId: z.string(),
        name: z.string(),
        kind: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
        assetId: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        rotation: z.number().optional(),
        anchorH: z.enum(['left', 'right']).optional(),
        anchorV: z.enum(['top', 'bottom']).optional(),
      },
      handler: (c, a) => {
        const { composeSceneId, ...body } = a;
        return c.post(`/api/compose-scenes/${composeSceneId}/layers`, body);
      },
    },
    {
      name: 'delete_compose_layer',
      description:
        'Delete a compose layer (or a whole compose scene by passing its id). Destructive — confirm the id first.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/compose-layers/${a.id}`),
    },
    {
      name: 'update_compose_layer',
      description:
        'Patch a layer. WARNING: the `config` object REPLACES the stored config wholesale — it is NOT merged. ' +
        'When changing one config field (e.g. css), resend the COMPLETE config including template and every other ' +
        'field you want to keep, or they will be lost.',
      inputShape: {
        id: z.string(),
        name: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        rotation: z.number().optional(),
        visible: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { id, ...body } = a;
        return c.put(`/api/compose-layers/${id}`, body);
      },
    },

    // ---- Logic graphs (signal graphs) ----
    {
      name: 'list_node_kinds',
      description:
        'List every signal-node kind available for logic graphs (names only). Use lookup_node_kind for ports.',
      inputShape: {},
      handler: async (c) => {
        const data = (await c.get('/api/signal/node-kinds')) as Array<{
          kind: string;
        }>;
        return data.map((m) => m.kind);
      },
    },
    {
      name: 'lookup_node_kind',
      description:
        'Get the exact input ports, output ports (with types/transport), of one signal-node kind. ' +
        'ALWAYS look up port names here before wiring edges — the API does not validate them and a wrong ' +
        'port name silently produces a dead graph.',
      inputShape: { kind: z.string() },
      handler: async (c, a) => {
        const data = (await c.get('/api/signal/node-kinds')) as Array<{
          kind: string;
          inputPorts?: { name: string; typeTag?: string; transport?: string }[];
          outputPorts?: {
            name: string;
            typeTag?: string;
            transport?: string;
          }[];
        }>;
        const m = data.find((x) => x.kind === a.kind);
        if (!m) return { error: `unknown node kind: ${a.kind}` };
        const fmt = (p?: { name: string; typeTag?: string; transport?: string }[]) =>
          (p ?? []).map((x) => ({
            name: x.name,
            type: x.typeTag,
            transport: x.transport,
          }));
        return {
          kind: m.kind,
          inputs: fmt(m.inputPorts),
          outputs: fmt(m.outputPorts),
        };
      },
    },
    {
      name: 'list_project_logic',
      description:
        'List the project-scoped logic graphs (each with its full descriptor).',
      inputShape: { projectId: z.string() },
      handler: (c, a) => c.get(`/api/projects/${a.projectId}/logic`),
    },
    {
      name: 'create_project_logic',
      description:
        'Create an EMPTY project logic graph. Returns its id. The descriptor is NOT set here — wire the nodes ' +
        'and edges with set_logic_descriptor in a second step.',
      inputShape: { projectId: z.string(), name: z.string() },
      handler: (c, a) =>
        c.post(`/api/projects/${a.projectId}/logic`, { name: a.name }),
    },
    {
      name: 'get_logic',
      description: 'Read back a logic graph (descriptor + metadata) by id.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.get(`/api/logic/${a.id}`),
    },
    {
      name: 'delete_logic',
      description:
        'Delete a logic graph by id (stops the running instance first). Destructive — confirm the id first.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/logic/${a.id}`),
    },
    {
      name: 'set_logic_descriptor',
      description:
        'Replace a logic graph descriptor (the nodes + edges). Shape:\n' +
        '{ id, label, readonly:false,\n' +
        '  nodes:[{ id, kind, position:{x,y}, defaultConfig:{...} }],\n' +
        '  edges:[{ fromNodeId, fromPort, toNodeId, toPort, kind:"event"|"value" }] }\n' +
        'Trigger/event ports connect with kind "event"; data ports with kind "value". Node `kind` must be a real ' +
        'signal-node kind and port names must match lookup_node_kind exactly — neither is validated server-side, so ' +
        'verify them or the graph silently no-ops.',
      inputShape: {
        id: z.string(),
        descriptor: z.object({}).passthrough(),
      },
      handler: (c, a) =>
        c.put(`/api/logic/${a.id}`, { descriptor: a.descriptor }),
    },
  ];
}
