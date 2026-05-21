import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// --- Reusable response envelopes ---

export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    status:  z.number().int(),
    message: z.string(),
    code:    z.string(),
  }),
}).openapi('Error');

export const emptyOkSchema = z.object({
  ok:   z.literal(true),
  data: z.object({}).passthrough(),
}).openapi('EmptyOk');

// --- Scene nodes / scenes / projects ---

export const sceneNodeKindSchema = z
  .enum(['avatar', 'model', 'light', 'camera', 'trigger', 'particle', 'sfx', 'fx', 'prop', 'godray_caster'])
  .openapi('SceneNodeKind');

export const sceneNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  boneAttachment: z.string().nullable(),
  name: z.string(),
  kind: sceneNodeKindSchema,
  filePath: z.string().nullable(),
  components: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('SceneNode');

export const sceneRuntimeSettingsSchema = z.object({
  broadcastTickHz: z.number().min(1).max(240).optional(),
}).openapi('SceneRuntimeSettings');

export const sceneSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  runtimeSettings: sceneRuntimeSettingsSchema,
  nodes: z.array(sceneNodeSchema),
}).openapi('Scene');

export const createSceneSchema = z.object({
  name: z.string().min(1),
}).openapi('CreateScene');

export const updateSceneSchema = z.object({
  name: z.string().min(1).optional(),
  runtimeSettings: sceneRuntimeSettingsSchema.optional(),
}).openapi('UpdateScene');

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scenes: z.array(sceneSchema),
}).openapi('Project');

export const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
}).openapi('CreateProject');

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
}).openapi('UpdateProject');

export const createSceneNodeSchema = z.object({
  name: z.string().min(1),
  kind: sceneNodeKindSchema,
  parentId: z.string().nullable().optional(),
  boneAttachment: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  components: z.record(z.string(), z.unknown()).optional(),
}).openapi('CreateSceneNode');

export const updateSceneNodeSchema = z.object({
  name: z.string().min(1).optional(),
  parentId: z.string().nullable().optional(),
  boneAttachment: z.string().nullable().optional(),
  kind: sceneNodeKindSchema.optional(),
  filePath: z.string().optional(),
  components: z.record(z.string(), z.unknown()).optional(),
  hidden: z.boolean().optional(),
}).openapi('UpdateSceneNode');

// --- Animation clips ---

export const createAnimationClipSchema = z.object({
  name:           z.string(),
  sourceFilePath: z.string(),
  clipIndex:      z.number().int().default(0),
  label:          z.string().optional(),
  startTime:      z.number().default(0),
  endTime:        z.number().optional(),
  duration:       z.number(),
  fps:            z.number().default(30),
}).openapi('CreateAnimationClip');

// --- Assets ---

export const createAssetSchema = z.object({
  name:     z.string().describe('Original filename with extension'),
  mimeType: z.string().optional(),
  data:     z.string().describe('Base64-encoded file contents'),
}).openapi('CreateAsset');

// --- Node components ---

export const createNodeComponentSchema = z.object({
  id:        z.string().optional(),
  kind:      z.string(),
  enabled:   z.boolean().optional(),
  config:    z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
}).openapi('CreateNodeComponent');

export const updateNodeComponentSchema = z.object({
  enabled: z.boolean().optional(),
  config:  z.record(z.string(), z.unknown()).optional(),
}).openapi('UpdateNodeComponent');

// --- Camera effects ---

export const createCameraEffectSchema = z.object({
  id:      z.string().optional(),
  kind:    z.string(),
  enabled: z.boolean().optional(),
  config:  z.record(z.string(), z.unknown()).optional(),
}).openapi('CreateCameraEffect');

export const updateCameraEffectSchema = z.object({
  enabled: z.boolean().optional(),
  config:  z.record(z.string(), z.unknown()).optional(),
}).openapi('UpdateCameraEffect');

// --- Signal graph ---

export const fireGraphEventSchema = z.object({
  nodeId: z.string(),
  port:   z.string(),
}).openapi('FireGraphEvent');

// --- Misc ---

export const presenceStateSchema = z.object({
  sessionId: z.string(),
  nodeId: z.string(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  updatedAt: z.string(),
}).openapi('PresenceState');

export const animationStateSchema = z.object({
  clipId: z.string(),
  startedAt: z.number(),
}).openapi('AnimationState');

// --- API controller component schemas ---

export const apiControllerAnimationSchema = z.object({
  animation: z.string().min(1),
}).openapi('ApiControllerAnimation');

export const apiControllerAnimationQueueSchema = z.object({
  queue: z.array(z.object({ animation: z.string().min(1) })),
  loopMode: z.enum(['none', 'last', 'queue']).optional(),
}).openapi('ApiControllerAnimationQueue');

export const apiControllerBlendshapesSchema = z.union([
  z.object({ preset: z.string().min(1) }),
  z.object({ blendshapes: z.record(z.string(), z.number()) }),
]).openapi('ApiControllerBlendshapes');

// --- Type exports ---

export type ApiControllerAnimationInput       = z.infer<typeof apiControllerAnimationSchema>;
export type ApiControllerAnimationQueueInput  = z.infer<typeof apiControllerAnimationQueueSchema>;
export type ApiControllerBlendshapesInput     = z.infer<typeof apiControllerBlendshapesSchema>;

export type SceneNodeInput              = z.infer<typeof sceneNodeSchema>;
export type SceneInput                  = z.infer<typeof sceneSchema>;
export type ProjectInput                = z.infer<typeof projectSchema>;
export type CreateProjectInput          = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput          = z.infer<typeof updateProjectSchema>;
export type CreateSceneInput            = z.infer<typeof createSceneSchema>;
export type UpdateSceneInput            = z.infer<typeof updateSceneSchema>;
export type CreateSceneNodeInput        = z.infer<typeof createSceneNodeSchema>;
export type UpdateSceneNodeInput        = z.infer<typeof updateSceneNodeSchema>;
export type SceneRuntimeSettingsInput   = z.infer<typeof sceneRuntimeSettingsSchema>;
export type CreateAnimationClipInput    = z.infer<typeof createAnimationClipSchema>;
export type CreateAssetInput            = z.infer<typeof createAssetSchema>;
export type CreateNodeComponentInput    = z.infer<typeof createNodeComponentSchema>;
export type UpdateNodeComponentInput    = z.infer<typeof updateNodeComponentSchema>;
export type CreateCameraEffectInput     = z.infer<typeof createCameraEffectSchema>;
export type UpdateCameraEffectInput     = z.infer<typeof updateCameraEffectSchema>;
export type FireGraphEventInput         = z.infer<typeof fireGraphEventSchema>;
export type PresenceStateInput          = z.infer<typeof presenceStateSchema>;
export type AnimationStateInput         = z.infer<typeof animationStateSchema>;
