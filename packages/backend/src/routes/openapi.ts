import swaggerJSDoc from 'swagger-jsdoc';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import {
  errorEnvelopeSchema,
  emptyOkSchema,
  sceneNodeKindSchema,
  createProjectSchema,
  updateProjectSchema,
  createSceneSchema,
  updateSceneSchema,
  createSceneNodeSchema,
  updateSceneNodeSchema,
  sceneNodePropertiesSchema,
  createAnimationClipSchema,
  createAssetSchema,
  createBehaviorSchema,
  updateBehaviorSchema,
  createCameraEffectSchema,
  updateCameraEffectSchema,
  createComposeLayerSchema,
  updateComposeLayerSchema,
  reorderComposeLayersSchema,
  fireGraphEventSchema,
  apiControllerAnimationSchema,
  apiControllerAnimationQueueSchema,
  apiControllerBlendshapesSchema,
} from '@vspark/shared/schema';

/**
 * Build the `components.schemas` block from Zod schemas in @vspark/shared.
 *
 * Schemas in packages/shared/src/schema.ts are tagged with `.openapi('Name')`
 * via @asteasolutions/zod-to-openapi. We register them here so the generator
 * produces a JSON Schema for each — the same names we reference from $ref's
 * in the route-level @openapi JSDoc blocks.
 */
function buildZodComponentSchemas(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  const schemas = [
    errorEnvelopeSchema,
    emptyOkSchema,
    sceneNodeKindSchema,
    createProjectSchema,
    updateProjectSchema,
    createSceneSchema,
    updateSceneSchema,
    createSceneNodeSchema,
    updateSceneNodeSchema,
    sceneNodePropertiesSchema,
    createAnimationClipSchema,
    createAssetSchema,
    createBehaviorSchema,
    updateBehaviorSchema,
    createCameraEffectSchema,
    updateCameraEffectSchema,
    createComposeLayerSchema,
    updateComposeLayerSchema,
    reorderComposeLayersSchema,
    fireGraphEventSchema,
    apiControllerAnimationSchema,
    apiControllerAnimationQueueSchema,
    apiControllerBlendshapesSchema,
  ];
  // Each schema carries its OpenAPI name via .openapi('Name') in schema.ts;
  // pass it explicitly here so the registry indexes it correctly.
  const named: Array<[string, (typeof schemas)[number]]> = [
    ['Error', errorEnvelopeSchema],
    ['EmptyOk', emptyOkSchema],
    ['SceneNodeKind', sceneNodeKindSchema],
    ['CreateProject', createProjectSchema],
    ['UpdateProject', updateProjectSchema],
    ['CreateScene', createSceneSchema],
    ['UpdateScene', updateSceneSchema],
    ['CreateSceneNode', createSceneNodeSchema],
    ['UpdateSceneNode', updateSceneNodeSchema],
    ['SceneNodeProperties', sceneNodePropertiesSchema],
    ['CreateAnimationClip', createAnimationClipSchema],
    ['CreateAsset', createAssetSchema],
    ['CreateBehavior', createBehaviorSchema],
    ['UpdateBehavior', updateBehaviorSchema],
    ['CreateCameraEffect', createCameraEffectSchema],
    ['UpdateCameraEffect', updateCameraEffectSchema],
    ['CreateComposeLayer', createComposeLayerSchema],
    ['UpdateComposeLayer', updateComposeLayerSchema],
    ['ReorderComposeLayers', reorderComposeLayersSchema],
    ['FireGraphEvent', fireGraphEventSchema],
    ['ApiControllerAnimation', apiControllerAnimationSchema],
    ['ApiControllerAnimationQueue', apiControllerAnimationQueueSchema],
    ['ApiControllerBlendshapes', apiControllerBlendshapesSchema],
  ];
  for (const [name, s] of named) registry.register(name, s);
  const generated = new OpenApiGeneratorV3(
    registry.definitions
  ).generateComponents();
  return (generated.components?.schemas ?? {}) as Record<string, unknown>;
}

/**
 * OpenAPI 3.0 spec for the vspark backend.
 *
 * Path-level documentation lives in @openapi JSDoc blocks above each route
 * in the per-resource files under this directory; swagger-jsdoc scans those
 * files at startup and merges the resulting paths into this base document.
 *
 * Reusable request/response component schemas are *generated* from the Zod
 * schemas in packages/shared/src/schema.ts — the validation and the docs
 * cannot drift.
 */
export const openApiDoc = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'vspark backend',
      version: '0.1.0',
      description: 'REST API for the vspark 3D avatar/scene streaming backend',
    },
    servers: [{ url: 'http://localhost:3001' }],
    components: {
      schemas: buildZodComponentSchemas(),
    },
    tags: [
      { name: 'projects', description: 'Project CRUD' },
      { name: 'scenes', description: 'Scene CRUD within a project' },
      { name: 'scene_nodes', description: 'Scene node CRUD + animation clips' },
      { name: 'assets', description: 'Project asset uploads + listing' },
      {
        name: 'node_components',
        description: 'Behavioural components attached to scene nodes',
      },
      {
        name: 'api_controller',
        description: 'REST control surface for api_controller components',
      },
      {
        name: 'expressions',
        description:
          'Read-only listings of VRM expressions and animation clips',
      },
      {
        name: 'camera_effects',
        description: 'Post-processing effects bound to camera nodes',
      },
      {
        name: 'compose_layers',
        description:
          '2D overlay/underlay layers composited with the 3D scene render',
      },
      {
        name: 'signal',
        description: 'Signal graph introspection + event firing',
      },
      {
        name: 'meta',
        description:
          'Component-kind metadata, system info, body-calibration state',
      },
    ],
  },
  apis: ['./src/routes/*.ts'],
});
