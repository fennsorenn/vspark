import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// --- Reusable response envelopes ---

export const errorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({
      status: z.number().int(),
      message: z.string(),
      code: z.string(),
    }),
  })
  .openapi('Error');

export const emptyOkSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({}).passthrough(),
  })
  .openapi('EmptyOk');

// --- Scene nodes / scenes / projects ---

export const sceneNodeKindSchema = z
  .enum([
    'scene',
    'scene_instance',
    'avatar',
    'model',
    'light',
    'camera',
    'trigger',
    'particle',
    'sfx',
    'fx',
    'prop',
    'godray_caster',
    'billboard',
    'video',
    'audio',
    'group',
    'text_troika',
    'text_canvas',
    'feed',
  ])
  .openapi('SceneNodeKind');

export const sceneNodePropertiesSchema = z
  .object({
    blendTransitionTime: z.number().min(0).max(10).optional(),
    broadcastTickHz: z.number().min(1).max(240).optional(),
    sourceSceneId: z.string().optional(),
  })
  .openapi('SceneNodeProperties');

export const sceneNodeSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    boneAttachment: z.string().nullable(),
    name: z.string(),
    kind: sceneNodeKindSchema,
    filePath: z.string().nullable(),
    components: z.record(z.string(), z.unknown()),
    properties: sceneNodePropertiesSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('SceneNode');

export const sceneRuntimeSettingsSchema = z
  .object({
    broadcastTickHz: z.number().min(1).max(240).optional(),
  })
  .openapi('SceneRuntimeSettings');

export const sceneSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runtimeSettings: sceneRuntimeSettingsSchema,
    nodes: z.array(sceneNodeSchema),
  })
  .openapi('Scene');

export const createSceneSchema = z
  .object({
    name: z.string().min(1),
  })
  .openapi('CreateScene');

export const updateSceneSchema = z
  .object({
    name: z.string().min(1).optional(),
    runtimeSettings: sceneRuntimeSettingsSchema.optional(),
  })
  .openapi('UpdateScene');

export const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    scenes: z.array(sceneSchema),
  })
  .openapi('Project');

export const createProjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .openapi('CreateProject');

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .openapi('UpdateProject');

export const createSceneNodeSchema = z
  .object({
    name: z.string().min(1),
    kind: sceneNodeKindSchema,
    parentId: z.string().nullable().optional(),
    boneAttachment: z.string().nullable().optional(),
    filePath: z.string().nullable().optional(),
    components: z.record(z.string(), z.unknown()).optional(),
    properties: sceneNodePropertiesSchema.optional(),
  })
  .openapi('CreateSceneNode');

export const updateSceneNodeSchema = z
  .object({
    name: z.string().min(1).optional(),
    parentId: z.string().nullable().optional(),
    boneAttachment: z.string().nullable().optional(),
    kind: sceneNodeKindSchema.optional(),
    filePath: z.string().optional(),
    components: z.record(z.string(), z.unknown()).optional(),
    properties: sceneNodePropertiesSchema.optional(),
    hidden: z.boolean().optional(),
  })
  .openapi('UpdateSceneNode');

// --- Animation clips ---

export const createAnimationClipSchema = z
  .object({
    name: z.string(),
    sourceFilePath: z.string(),
    clipIndex: z.number().int().default(0),
    label: z.string().optional(),
    startTime: z.number().default(0),
    endTime: z.number().optional(),
    duration: z.number(),
    fps: z.number().default(30),
  })
  .openapi('CreateAnimationClip');

// --- Assets ---

export const createAssetSchema = z
  .object({
    name: z.string().describe('Original filename with extension'),
    mimeType: z.string().optional(),
    data: z.string().describe('Base64-encoded file contents'),
  })
  .openapi('CreateAsset');

// --- Node components ---

export const createBehaviorSchema = z
  .object({
    id: z.string().optional(),
    kind: z.string(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi('CreateBehavior');

export const updateBehaviorSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('UpdateBehavior');

// --- Camera effects ---

export const createCameraEffectSchema = z
  .object({
    id: z.string().optional(),
    kind: z.string(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CreateCameraEffect');

export const updateCameraEffectSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('UpdateCameraEffect');

// --- Compose layers ---

export const composeLayerKindSchema = z
  .enum([
    'compose_scene',
    'scene_include',
    'camera_view',
    'image',
    'video',
    'audio',
    'browser',
    'group',
    'text',
    'feed',
  ])
  .openapi('ComposeLayerKind');
export const composeAnchorHSchema = z
  .enum(['left', 'right'])
  .openapi('ComposeAnchorH');
export const composeAnchorVSchema = z
  .enum(['top', 'bottom'])
  .openapi('ComposeAnchorV');

export const createComposeLayerSchema = z
  .object({
    id: z.string().optional(),
    cameraNodeId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    name: z.string().min(1),
    kind: composeLayerKindSchema,
    assetId: z.string().nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().optional(),
    anchorH: composeAnchorHSchema.optional(),
    anchorV: composeAnchorVSchema.optional(),
    sceneOrder: z.number().int().optional(),
    cameraOrder: z.number().int().optional(),
    visible: z.boolean().optional(),
  })
  .openapi('CreateComposeLayer');

export const updateComposeLayerSchema = z
  .object({
    name: z.string().min(1).optional(),
    parentId: z.string().nullable().optional(),
    assetId: z.string().nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotation: z.number().optional(),
    anchorH: composeAnchorHSchema.optional(),
    anchorV: composeAnchorVSchema.optional(),
    sceneOrder: z.number().int().optional(),
    cameraOrder: z.number().int().optional(),
    visible: z.boolean().optional(),
  })
  .openapi('UpdateComposeLayer');

export const reorderComposeLayersSchema = z
  .object({
    updates: z
      .array(
        z.object({
          id: z.string(),
          sceneOrder: z.number().int(),
          cameraOrder: z.number().int(),
        })
      )
      .min(1),
  })
  .openapi('ReorderComposeLayers');

// --- Track clips (timeline parameter animation) ---

export const trackClipModeSchema = z
  .enum(['override', 'relative'])
  .openapi('TrackClipMode');
export const trackClipTargetKindSchema = z
  .enum(['scene_node', 'compose_layer'])
  .openapi('TrackClipTargetKind');
export const trackClipEasingSchema = z
  .enum(['linear', 'step', 'bezier'])
  .openapi('TrackClipEasing');

export const trackClipKeyframeSchema = z
  .object({
    id: z.string().optional(),
    t: z.number().min(0),
    value: z.number(),
    easing: trackClipEasingSchema.optional(),
    inHandleTFraction: z.number().nullable().optional(),
    inHandleVFraction: z.number().nullable().optional(),
    outHandleTFraction: z.number().nullable().optional(),
    outHandleVFraction: z.number().nullable().optional(),
  })
  .openapi('TrackClipKeyframe');

export const createTrackClipSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    duration: z.number().positive().optional(),
    loop: z.boolean().optional(),
    mode: trackClipModeSchema.optional(),
    autoplay: z.boolean().optional(),
  })
  .openapi('CreateTrackClip');

export const updateTrackClipSchema = z
  .object({
    name: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    loop: z.boolean().optional(),
    mode: trackClipModeSchema.optional(),
    autoplay: z.boolean().optional(),
  })
  .openapi('UpdateTrackClip');

export const createTrackClipLaneSchema = z
  .object({
    id: z.string().optional(),
    targetKind: trackClipTargetKindSchema,
    targetId: z.string().min(1),
    paramPath: z.string().min(1),
    defaultValue: z.number().optional(),
  })
  .openapi('CreateTrackClipLane');

export const updateTrackClipLaneSchema = z
  .object({
    targetKind: trackClipTargetKindSchema.optional(),
    targetId: z.string().min(1).optional(),
    paramPath: z.string().min(1).optional(),
    defaultValue: z.number().optional(),
  })
  .openapi('UpdateTrackClipLane');

export const replaceTrackClipKeyframesSchema = z
  .object({
    keyframes: z.array(trackClipKeyframeSchema),
  })
  .openapi('ReplaceTrackClipKeyframes');

// --- Graphs (generalized owner-scoped) ---

export const graphOwnerKindSchema = z
  .enum(['project', 'scene_node', 'compose_layer'])
  .openapi('AutomationOwnerKind');

export const createAutomationSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    descriptor: z.unknown().optional(),
  })
  .openapi('CreateAutomation');

export const updateAutomationSchema = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    descriptor: z.unknown().optional(),
  })
  .openapi('UpdateAutomation');

// --- Presets ---

export const presetRootKindSchema = z
  .enum(['scene_node', 'compose_layer'])
  .openapi('PresetRootKind');

export const presetAssetSchema = z
  .object({
    presetAssetId: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number(),
    sha256: z.string(),
    originalPath: z.string(),
    kind: z.enum(['scene_node_file', 'asset_file']),
    dataBase64: z.string().optional(),
  })
  .openapi('PresetAsset');

export const presetComponentSchema = z
  .object({
    presetId: z.string(),
    kind: z.string(),
    enabled: z.boolean(),
    sortOrder: z.number().int(),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('PresetComponent');

export const presetCameraEffectSchema = z
  .object({
    presetId: z.string(),
    kind: z.string(),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('PresetCameraEffect');

export const presetSceneNodeSchema = z
  .object({
    presetId: z.string(),
    parentPresetId: z.string().nullable(),
    name: z.string(),
    kind: z.string(),
    filePresetAssetId: z.string().nullable(),
    boneAttachment: z.string().nullable(),
    hidden: z.boolean(),
    properties: z.record(z.string(), z.unknown()),
    components: z.array(presetComponentSchema),
    cameraEffects: z.array(presetCameraEffectSchema).optional(),
  })
  .openapi('PresetSceneNode');

export const presetComposeLayerSchema = z
  .object({
    presetId: z.string(),
    parentPresetId: z.string().nullable(),
    name: z.string(),
    kind: z.string(),
    assetPresetAssetId: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number(),
    anchorH: z.string(),
    anchorV: z.string(),
    sceneOrder: z.number().int(),
    cameraOrder: z.number().int(),
    visible: z.boolean(),
    cameraNodePresetId: z.string().nullable(),
  })
  .openapi('PresetComposeLayer');

export const presetAutomationSchema = z
  .object({
    presetId: z.string(),
    ownerKind: z.enum(['scene_node', 'compose_layer']),
    ownerPresetId: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    descriptor: z.unknown(),
    nodeState: z.unknown(),
  })
  .openapi('PresetAutomation');

export const presetAnimationClipSchema = z
  .object({
    presetId: z.string(),
    sourceNodePresetId: z.string(),
    sourceFilePresetAssetId: z.string().nullable(),
    clipIndex: z.number().int(),
    label: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    duration: z.number(),
    fps: z.number(),
  })
  .openapi('PresetAnimationClip');

export const presetTrackClipKeyframeSchema = z
  .object({
    presetId: z.string(),
    t: z.number(),
    value: z.number(),
    easing: z.string(),
    inHandleTFraction: z.number().nullable(),
    inHandleVFraction: z.number().nullable(),
    outHandleTFraction: z.number().nullable(),
    outHandleVFraction: z.number().nullable(),
  })
  .openapi('PresetTrackClipKeyframe');

export const presetTrackClipLaneSchema = z
  .object({
    presetId: z.string(),
    targetKind: z.enum(['scene_node', 'compose_layer']),
    targetPresetId: z.string(),
    paramPath: z.string(),
    defaultValue: z.number(),
    keyframes: z.array(presetTrackClipKeyframeSchema),
  })
  .openapi('PresetTrackClipLane');

export const presetTrackClipSchema = z
  .object({
    presetId: z.string(),
    ownerKind: z.enum(['scene_node', 'compose_layer']),
    ownerPresetId: z.string(),
    name: z.string(),
    duration: z.number(),
    loop: z.boolean(),
    mode: z.string(),
    autoplay: z.boolean(),
    lanes: z.array(presetTrackClipLaneSchema),
  })
  .openapi('PresetTrackClip');

export const presetPayloadSchema = z
  .object({
    // v1 = pre-scenes-as-nodes; v2 = scenes-as-nodes (only exportedFrom metadata
    // changed — the instantiable structure is identical, so both are accepted).
    format: z.enum(['vspark.preset.v1', 'vspark.preset.v2']),
    rootKind: presetRootKindSchema,
    exportedAt: z.string(),
    exportedFrom: z.object({
      projectId: z.string(),
      sceneId: z.string().optional(),
      rootSceneNodeId: z.string().optional(),
      rootId: z.string(),
    }),
    assets: z.array(presetAssetSchema),
    sceneNodes: z.array(presetSceneNodeSchema).optional(),
    composeLayers: z.array(presetComposeLayerSchema).optional(),
    graphs: z.array(presetAutomationSchema).optional(),
    animationClips: z.array(presetAnimationClipSchema).optional(),
    trackClips: z.array(presetTrackClipSchema).optional(),
  })
  .openapi('PresetPayload');

export const createPresetSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    rootKind: presetRootKindSchema,
    rootId: z.string(),
    embedAssets: z.boolean().optional(),
  })
  .openapi('CreatePreset');

export const instantiatePresetSchema = z
  .object({
    payload: presetPayloadSchema,
    projectId: z.string(),
    sceneId: z.string(),
    parentId: z.string().nullable().optional(),
    /** Override the root scene node's bone_attachment on insert. Used by
     *  the "paste onto bone" path in the editor. Only meaningful when
     *  rootKind = 'scene_node'. */
    boneAttachment: z.string().nullable().optional(),
  })
  .openapi('InstantiatePreset');

export const serializePresetSchema = z
  .object({
    rootKind: presetRootKindSchema,
    rootId: z.string(),
    embedAssets: z.boolean().optional(),
  })
  .openapi('SerializePreset');

// --- Signal graph ---

export const fireGraphEventSchema = z
  .object({
    nodeId: z.string(),
    port: z.string(),
  })
  .openapi('FireGraphEvent');

// --- Misc ---

export const presenceStateSchema = z
  .object({
    sessionId: z.string(),
    nodeId: z.string(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    updatedAt: z.string(),
  })
  .openapi('PresenceState');

export const animationStateSchema = z
  .object({
    clipId: z.string(),
    startedAt: z.number(),
  })
  .openapi('AnimationState');

// --- API controller component schemas ---

export const apiControllerAnimationSchema = z
  .object({
    animation: z.string().min(1),
  })
  .openapi('ApiControllerAnimation');

export const apiControllerAnimationQueueSchema = z
  .object({
    queue: z.array(z.object({ animation: z.string().min(1) })),
    loopMode: z.enum(['none', 'last', 'queue']).optional(),
  })
  .openapi('ApiControllerAnimationQueue');

export const apiControllerBlendshapesSchema = z
  .union([
    z.object({ preset: z.string().min(1) }),
    z.object({ blendshapes: z.record(z.string(), z.number()) }),
  ])
  .openapi('ApiControllerBlendshapes');

// --- Type exports ---

export type ApiControllerAnimationInput = z.infer<
  typeof apiControllerAnimationSchema
>;
export type ApiControllerAnimationQueueInput = z.infer<
  typeof apiControllerAnimationQueueSchema
>;
export type ApiControllerBlendshapesInput = z.infer<
  typeof apiControllerBlendshapesSchema
>;

export type SceneNodePropertiesInput = z.infer<
  typeof sceneNodePropertiesSchema
>;
export type SceneNodeInput = z.infer<typeof sceneNodeSchema>;
export type SceneInput = z.infer<typeof sceneSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateSceneInput = z.infer<typeof createSceneSchema>;
export type UpdateSceneInput = z.infer<typeof updateSceneSchema>;
export type CreateSceneNodeInput = z.infer<typeof createSceneNodeSchema>;
export type UpdateSceneNodeInput = z.infer<typeof updateSceneNodeSchema>;
export type SceneRuntimeSettingsInput = z.infer<
  typeof sceneRuntimeSettingsSchema
>;
export type CreateAnimationClipInput = z.infer<
  typeof createAnimationClipSchema
>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type CreateBehaviorInput = z.infer<
  typeof createBehaviorSchema
>;
export type UpdateBehaviorInput = z.infer<
  typeof updateBehaviorSchema
>;
export type CreateCameraEffectInput = z.infer<typeof createCameraEffectSchema>;
export type UpdateCameraEffectInput = z.infer<typeof updateCameraEffectSchema>;
export type CreateComposeLayerInput = z.infer<typeof createComposeLayerSchema>;
export type UpdateComposeLayerInput = z.infer<typeof updateComposeLayerSchema>;
export type ReorderComposeLayersInput = z.infer<
  typeof reorderComposeLayersSchema
>;
export type FireGraphEventInput = z.infer<typeof fireGraphEventSchema>;
export type PresenceStateInput = z.infer<typeof presenceStateSchema>;
export type AnimationStateInput = z.infer<typeof animationStateSchema>;
export type CreateTrackClipInput = z.infer<typeof createTrackClipSchema>;
export type UpdateTrackClipInput = z.infer<typeof updateTrackClipSchema>;
export type CreateTrackClipLaneInput = z.infer<
  typeof createTrackClipLaneSchema
>;
export type UpdateTrackClipLaneInput = z.infer<
  typeof updateTrackClipLaneSchema
>;
export type ReplaceTrackClipKeyframesInput = z.infer<
  typeof replaceTrackClipKeyframesSchema
>;
export type TrackClipKeyframeInput = z.infer<typeof trackClipKeyframeSchema>;
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
export type CreatePresetInput = z.infer<typeof createPresetSchema>;
export type InstantiatePresetInput = z.infer<typeof instantiatePresetSchema>;
export type SerializePresetInput = z.infer<typeof serializePresetSchema>;
export type PresetPayloadInput = z.infer<typeof presetPayloadSchema>;
