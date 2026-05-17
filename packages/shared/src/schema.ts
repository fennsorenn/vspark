import { z } from 'zod';

export const sceneNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  boneAttachment: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['avatar', 'model', 'light', 'camera', 'trigger', 'particle', 'sfx', 'fx', 'prop', 'godray_caster']),
  filePath: z.string().nullable(),
  components: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sceneSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nodes: z.array(sceneNodeSchema),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scenes: z.array(sceneSchema),
});

export const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const updateSceneNodeSchema = z.object({
  name: z.string().min(1).optional(),
  parentId: z.string().nullable().optional(),
  boneAttachment: z.string().nullable().optional(),
  kind: z.enum(['avatar', 'model', 'light', 'camera', 'trigger', 'particle', 'sfx', 'fx', 'prop', 'godray_caster']).optional(),
  filePath: z.string().optional(),
  components: z.record(z.string(), z.unknown()).optional(),
});

export const presenceStateSchema = z.object({
  sessionId: z.string(),
  nodeId: z.string(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  updatedAt: z.string(),
});

export const animationStateSchema = z.object({
  clipId: z.string(),
  startedAt: z.number(),
});

export type SceneNodeInput = z.infer<typeof sceneNodeSchema>;
export type SceneInput = z.infer<typeof sceneSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateSceneNodeInput = z.infer<typeof updateSceneNodeSchema>;
export type PresenceStateInput = z.infer<typeof presenceStateSchema>;
export type AnimationStateInput = z.infer<typeof animationStateSchema>;
