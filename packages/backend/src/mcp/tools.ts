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
import {
  listAllParamPaths,
  type ParamTargetKind,
} from '@vspark/shared/paramPaths';
import { CAMERA_EFFECT_KINDS } from '@vspark/shared/cameraEffects';
import type { VsparkClient } from './client.js';

/** scene_node → /api/scene-nodes/:id, compose_layer → /api/compose-layers/:id */
function ownerBase(ownerKind: unknown): string {
  return ownerKind === 'compose_layer' ? 'compose-layers' : 'scene-nodes';
}

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

    // ---- Timeline / track clips ----
    {
      name: 'lookup_param_paths',
      description:
        'List the paramPaths that track-clip lanes and set_*_param logic nodes can target for a ' +
        'given targetKind ("scene_node" or "compose_layer"). Returns {path, type, animatable, kinds?} ' +
        'entries — only animatable Float paths (e.g. position.x, rotation.z, opacity, and for layers ' +
        'x/y/width/height/rotation) can be animated by a track-clip lane. Use these EXACT path strings; ' +
        'they are not validated server-side.',
      inputShape: { targetKind: z.enum(['scene_node', 'compose_layer']) },
      handler: async (_c, a) =>
        listAllParamPaths(a.targetKind as ParamTargetKind),
    },
    {
      name: 'list_track_clips',
      description:
        'List the timeline track clips owned by a scene node or a compose layer.',
      inputShape: {
        ownerKind: z.enum(['scene_node', 'compose_layer']),
        ownerId: z.string(),
      },
      handler: (c, a) =>
        c.get(`/api/${ownerBase(a.ownerKind)}/${a.ownerId}/track-clips`),
    },
    {
      name: 'create_track_clip',
      description:
        'Create a timeline track clip owned by a scene node or compose layer. A clip is a container ' +
        'for animation lanes. mode "override" replaces the target value; "relative" adds onto it. ' +
        'duration is in seconds. After creating, add lanes with add_track_clip_lane, then keyframes ' +
        'with set_track_clip_keyframes, then play it with control_track_clip.',
      inputShape: {
        ownerKind: z.enum(['scene_node', 'compose_layer']),
        ownerId: z.string(),
        name: z.string(),
        duration: z.number().optional(),
        loop: z.boolean().optional(),
        mode: z.enum(['override', 'relative']).optional(),
        autoplay: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { ownerKind, ownerId, ...body } = a;
        return c.post(
          `/api/${ownerBase(ownerKind)}/${ownerId}/track-clips`,
          body
        );
      },
    },
    {
      name: 'update_track_clip',
      description:
        'Patch a track clip’s top-level fields (name, duration, loop, mode, autoplay).',
      inputShape: {
        id: z.string(),
        name: z.string().optional(),
        duration: z.number().optional(),
        loop: z.boolean().optional(),
        mode: z.enum(['override', 'relative']).optional(),
        autoplay: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { id, ...body } = a;
        return c.put(`/api/track-clips/${id}`, body);
      },
    },
    {
      name: 'delete_track_clip',
      description:
        'Delete a track clip and all of its lanes/keyframes. Destructive — confirm the id first.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/track-clips/${a.id}`),
    },
    {
      name: 'add_track_clip_lane',
      description:
        'Add a lane to a track clip. A lane animates ONE scalar paramPath on ONE target ' +
        '(targetKind "scene_node"|"compose_layer", targetId, paramPath from lookup_param_paths — ' +
        'must be an animatable Float path). Returns the lane id; add keyframes with set_track_clip_keyframes.',
      inputShape: {
        clipId: z.string(),
        targetKind: z.enum(['scene_node', 'compose_layer']),
        targetId: z.string(),
        paramPath: z.string(),
        defaultValue: z.number().optional(),
      },
      handler: (c, a) => {
        const { clipId, ...body } = a;
        return c.post(`/api/track-clips/${clipId}/lanes`, body);
      },
    },
    {
      name: 'delete_track_clip_lane',
      description: 'Delete a track-clip lane and its keyframes.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/track-clip-lanes/${a.id}`),
    },
    {
      name: 'set_track_clip_keyframes',
      description:
        'Replace ALL keyframes on a lane (send the complete set, not a delta). Each keyframe: ' +
        '{t (seconds), value (number), easing?:"linear"|"step"|"bezier"}. They are auto-sorted by t. ' +
        'Example: animate from 0→5 over 2s = [{t:0,value:0},{t:2,value:5}].',
      inputShape: {
        laneId: z.string(),
        keyframes: z.array(
          z.object({
            t: z.number(),
            value: z.number(),
            easing: z.enum(['linear', 'step', 'bezier']).optional(),
          })
        ),
      },
      handler: (c, a) =>
        c.put(`/api/track-clip-lanes/${a.laneId}/keyframes`, {
          keyframes: a.keyframes,
        }),
    },
    {
      name: 'control_track_clip',
      description:
        'Transport control for a track clip: action "trigger" (play from start), "stop", "pause", ' +
        '"resume", or "seek" (requires t = seconds). Use this to preview or run a clip.',
      inputShape: {
        id: z.string(),
        action: z.enum(['trigger', 'stop', 'pause', 'resume', 'seek']),
        t: z.number().optional(),
      },
      handler: (c, a) =>
        c.post(
          `/api/track-clips/${a.id}/${a.action}`,
          a.action === 'seek' ? { t: a.t } : undefined
        ),
    },

    // ---- Behaviors (avatar/scene-node drivers) ----
    {
      name: 'list_behavior_kinds',
      description:
        'List the behavior kinds that can be attached to a scene node (vmc_receiver, breathing, ' +
        'manual_calibration, lipsync_processor, mediapipe_tracker, api_controller, …). Each entry ' +
        'includes a `defaultConfig` — copy that shape and override fields when calling attach_behavior. ' +
        '`applicableTo` lists which node kinds it suits.',
      inputShape: {},
      handler: (c) => c.get('/api/behavior-kinds'),
    },
    {
      name: 'list_behaviors',
      description: 'List the behaviors currently attached to a scene node.',
      inputShape: { nodeId: z.string() },
      handler: (c, a) => c.get(`/api/scene-nodes/${a.nodeId}/behaviors`),
    },
    {
      name: 'attach_behavior',
      description:
        'Attach a behavior to a scene node (drives it at runtime). `kind` must be a real behavior ' +
        'kind from list_behavior_kinds; `config` should follow that kind’s defaultConfig shape (it is ' +
        'an opaque per-kind blob, not validated here). E.g. vmc_receiver → {host,port,mirror}; ' +
        'lipsync_processor → {sensitivity}. To use play_animation/set_blendshapes on a node, attach an ' +
        'api_controller behavior first.',
      inputShape: {
        nodeId: z.string(),
        kind: z.string(),
        config: z.object({}).passthrough().optional(),
        enabled: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { nodeId, ...body } = a;
        return c.post(`/api/scene-nodes/${nodeId}/behaviors`, body);
      },
    },
    {
      name: 'update_behavior',
      description:
        'Update a behavior’s enabled flag and/or config. config REPLACES the stored config — send the ' +
        'complete object, not a partial.',
      inputShape: {
        id: z.string(),
        enabled: z.boolean().optional(),
        config: z.object({}).passthrough().optional(),
      },
      handler: (c, a) => {
        const { id, ...body } = a;
        return c.put(`/api/behaviors/${id}`, body);
      },
    },
    {
      name: 'delete_behavior',
      description: 'Detach (delete) a behavior from its node by behavior id.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/behaviors/${a.id}`),
    },

    // ---- Assets, expressions, animation playback ----
    {
      name: 'list_assets',
      description:
        'List a project’s asset files (avatars/animations/images/audio/video). Use an asset’s filePath ' +
        'as the filePath when creating/updating the scene node that should display it.',
      inputShape: { projectId: z.string() },
      handler: (c, a) => c.get(`/api/projects/${a.projectId}/assets`),
    },
    {
      name: 'list_avatar_expressions',
      description:
        'List the VRM expression names an avatar node exposes (for blendshapes / default expressions). ' +
        '`reported` is false if the avatar has not been loaded in a viewport yet.',
      inputShape: { projectId: z.string(), nodeId: z.string() },
      handler: (c, a) =>
        c.get(
          `/api/projects/${a.projectId}/nodes/${a.nodeId}/expressions`
        ),
    },
    {
      name: 'list_avatar_animations',
      description:
        'List the animation clips registered for an avatar node (id, name, label, duration). Use a ' +
        'clip name with play_animation / set_animation_queue.',
      inputShape: { projectId: z.string(), nodeId: z.string() },
      handler: (c, a) =>
        c.get(`/api/projects/${a.projectId}/nodes/${a.nodeId}/animations`),
    },
    {
      name: 'play_animation',
      description:
        'Play a single animation clip on an avatar (replaces the queue, loops the last clip). The node ' +
        'must have an api_controller behavior attached. `animation` is a clip name from ' +
        'list_avatar_animations.',
      inputShape: {
        projectId: z.string(),
        nodeId: z.string(),
        animation: z.string(),
      },
      handler: (c, a) =>
        c.put(
          `/api/projects/${a.projectId}/nodes/${a.nodeId}/api-controller/animation`,
          { animation: a.animation }
        ),
    },
    {
      name: 'set_animation_queue',
      description:
        'Set an ordered animation queue on an avatar (api_controller behavior required). loopMode: ' +
        '"none" (play once), "last" (hold final clip), or "queue" (loop the whole list).',
      inputShape: {
        projectId: z.string(),
        nodeId: z.string(),
        queue: z.array(z.object({ animation: z.string() })),
        loopMode: z.enum(['none', 'last', 'queue']).optional(),
      },
      handler: (c, a) => {
        const { projectId, nodeId, ...body } = a;
        return c.put(
          `/api/projects/${projectId}/nodes/${nodeId}/api-controller/animation-queue`,
          body
        );
      },
    },
    {
      name: 'set_blendshapes',
      description:
        'Apply blendshapes to an avatar (api_controller behavior required). Pass EITHER preset (a single ' +
        'expression name at weight 1) OR blendshapes (a map of expression name → weight 0..1). Names ' +
        'come from list_avatar_expressions.',
      inputShape: {
        projectId: z.string(),
        nodeId: z.string(),
        preset: z.string().optional(),
        blendshapes: z.record(z.string(), z.number()).optional(),
      },
      handler: (c, a) => {
        const { projectId, nodeId, preset, blendshapes } = a;
        const body = preset != null ? { preset } : { blendshapes };
        return c.put(
          `/api/projects/${projectId}/nodes/${nodeId}/api-controller/blendshapes`,
          body
        );
      },
    },
    {
      name: 'clear_blendshapes',
      description:
        'Clear all active api_controller blendshape weights on an avatar.',
      inputShape: { projectId: z.string(), nodeId: z.string() },
      handler: (c, a) =>
        c.del(
          `/api/projects/${a.projectId}/nodes/${a.nodeId}/api-controller/blendshapes`
        ),
    },

    // ---- Camera effects (post-processing) ----
    {
      name: 'list_camera_effect_kinds',
      description:
        'List the post-processing effect kinds that can be added to a camera node. Each entry has ' +
        '{kind, label, description, defaultConfig} — kinds are prefixed "fx_" (e.g. fx_bloom, ' +
        'fx_vignette, fx_depth_of_field, fx_glitch). Copy defaultConfig and override fields when ' +
        'calling add_camera_effect / update_camera_effect.',
      inputShape: {},
      handler: async () => CAMERA_EFFECT_KINDS,
    },
    {
      name: 'list_camera_effects',
      description:
        'List the post-processing effects currently on a camera node, in application order.',
      inputShape: { nodeId: z.string() },
      handler: (c, a) => c.get(`/api/scene-nodes/${a.nodeId}/effects`),
    },
    {
      name: 'add_camera_effect',
      description:
        'Add a post-processing effect to a camera node. `kind` must be an "fx_" kind from ' +
        'list_camera_effect_kinds; `config` should follow that kind’s defaultConfig (opaque per-kind ' +
        'blob, not validated here). Effects apply in the order they are added.',
      inputShape: {
        nodeId: z.string(),
        kind: z.string(),
        config: z.object({}).passthrough().optional(),
        enabled: z.boolean().optional(),
      },
      handler: (c, a) => {
        const { nodeId, ...body } = a;
        return c.post(`/api/scene-nodes/${nodeId}/effects`, body);
      },
    },
    {
      name: 'update_camera_effect',
      description:
        'Update a camera effect’s enabled flag and/or config. config REPLACES the stored config — send ' +
        'the complete object.',
      inputShape: {
        id: z.string(),
        enabled: z.boolean().optional(),
        config: z.object({}).passthrough().optional(),
      },
      handler: (c, a) => {
        const { id, ...body } = a;
        return c.put(`/api/camera-effects/${id}`, body);
      },
    },
    {
      name: 'delete_camera_effect',
      description: 'Remove a camera effect by id.',
      inputShape: { id: z.string() },
      handler: (c, a) => c.del(`/api/camera-effects/${a.id}`),
    },

    // ---- UI control (drive the user's editor; needs a sessionId) ----
    {
      name: 'list_ui_sessions',
      description:
        'List the active editor sessions (open browser tabs) that ui_* tools can drive. Returns ' +
        '{sessionId, projectId, connectedAt}. The in-app assistant is told its own sessionId — use that ' +
        'one; external clients pick the session for the project they want to drive.',
      inputShape: {},
      handler: (c) => c.get('/api/ui-sessions'),
    },
    {
      name: 'ui_select_entity',
      description:
        'Select an entity in the user’s editor so its properties open and it is highlighted in the tree. ' +
        'entityKind: "scene_node" (also switches to the Scene tab), "compose_layer" (Compose tab), or ' +
        '"scene". Helpful to show the user what you just created or are talking about.',
      inputShape: {
        sessionId: z.string(),
        entityKind: z.enum(['scene_node', 'compose_layer', 'scene']),
        id: z.string(),
      },
      handler: (c, a) =>
        c.post('/api/ui-actions', {
          sessionId: a.sessionId,
          action: { type: 'select_entity', entityKind: a.entityKind, id: a.id },
        }),
    },
    {
      name: 'ui_open_panel',
      description:
        'Open a dock panel in the user’s editor. dock "left" tab is one of scene|compose|graphs; dock ' +
        '"bottom" tab is one of create|models|animations|images|videos|audio|components|effects|clips|' +
        'presets (the bottom tab also pulses to draw the eye). Use this to take the user to the right place ' +
        '(e.g. the Timeline = bottom "clips", the Preset library = bottom "presets").',
      inputShape: {
        sessionId: z.string(),
        dock: z.enum(['left', 'bottom']),
        tab: z.string(),
      },
      handler: (c, a) =>
        c.post('/api/ui-actions', {
          sessionId: a.sessionId,
          action: { type: 'open_panel', dock: a.dock, tab: a.tab },
        }),
    },
    {
      name: 'ui_open_help',
      description:
        'Open the in-app help window in the user’s editor to a topic (and optional section anchor), e.g. ' +
        'topic "camera-effects", "compose", "track-clips". Use when the user asks how something works.',
      inputShape: {
        sessionId: z.string(),
        topic: z.string(),
        anchor: z.string().optional(),
      },
      handler: (c, a) =>
        c.post('/api/ui-actions', {
          sessionId: a.sessionId,
          action: { type: 'open_help', topic: a.topic, anchor: a.anchor ?? null },
        }),
    },
    {
      name: 'ui_open_window',
      description:
        'Open or close a floating window in the user’s editor. window "assistant" (this chat) — `open` ' +
        'true/false (default true).',
      inputShape: {
        sessionId: z.string(),
        window: z.enum(['assistant']),
        open: z.boolean().optional(),
      },
      handler: (c, a) =>
        c.post('/api/ui-actions', {
          sessionId: a.sessionId,
          action: { type: 'open_window', window: a.window, open: a.open !== false },
        }),
    },
    {
      name: 'ui_highlight_control',
      description:
        'Scroll to and pulse-highlight a specific UI control in the user’s editor, identified by its ' +
        '"vs-" handle (e.g. "vs-topbar-accounts", "vs-preset-save", "vs-clip-play", "vs-asset-add-image"). ' +
        'Use this to point the user at the button they’re looking for. The handle may be given with or ' +
        'without the leading "vs-".',
      inputShape: { sessionId: z.string(), handle: z.string() },
      handler: (c, a) =>
        c.post('/api/ui-actions', {
          sessionId: a.sessionId,
          action: { type: 'highlight_control', handle: a.handle },
        }),
    },
  ];
}
