import swaggerJSDoc from 'swagger-jsdoc';

/**
 * OpenAPI 3.0 spec for the vspark backend.
 *
 * Path-level documentation lives in @openapi JSDoc blocks above each route
 * in the per-resource files under this directory; swagger-jsdoc scans those
 * files at startup and merges the resulting paths into this base document.
 *
 * Reusable request/response component schemas are declared inline below.
 * They mirror the Zod schemas in packages/shared/src/schema.ts — if you
 * change a Zod schema there, update the matching entry here.
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
      schemas: {
        // --- Envelope shapes ---
        Error: {
          type: 'object',
          properties: {
            ok:    { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              properties: {
                status:  { type: 'integer' },
                message: { type: 'string' },
                code:    { type: 'string' },
              },
            },
          },
        },
        EmptyOk: {
          type: 'object',
          properties: {
            ok:   { type: 'boolean', enum: [true] },
            data: { type: 'object' },
          },
        },

        // --- Projects ---
        CreateProject: {
          type: 'object',
          required: ['name'],
          properties: {
            name:        { type: 'string', minLength: 1 },
            description: { type: 'string' },
          },
        },
        UpdateProject: {
          type: 'object',
          properties: {
            name:        { type: 'string', minLength: 1 },
            description: { type: 'string', nullable: true },
          },
        },

        // --- Scenes ---
        CreateScene: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1 } },
        },
        UpdateScene: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            runtimeSettings: {
              type: 'object',
              properties: { broadcastTickHz: { type: 'number', minimum: 1, maximum: 240 } },
            },
          },
        },

        // --- Scene Nodes ---
        SceneNodeKind: {
          type: 'string',
          enum: ['avatar', 'model', 'light', 'camera', 'trigger', 'particle', 'sfx', 'fx', 'prop', 'godray_caster'],
        },
        CreateSceneNode: {
          type: 'object',
          required: ['name', 'kind'],
          properties: {
            name:           { type: 'string', minLength: 1 },
            kind:           { $ref: '#/components/schemas/SceneNodeKind' },
            parentId:       { type: 'string', nullable: true },
            boneAttachment: { type: 'string', nullable: true },
            filePath:       { type: 'string', nullable: true },
            components:     { type: 'object', additionalProperties: true },
          },
        },
        UpdateSceneNode: {
          type: 'object',
          properties: {
            name:           { type: 'string', minLength: 1 },
            kind:           { $ref: '#/components/schemas/SceneNodeKind' },
            parentId:       { type: 'string', nullable: true },
            boneAttachment: { type: 'string', nullable: true },
            filePath:       { type: 'string' },
            components:     { type: 'object', additionalProperties: true },
            hidden:         { type: 'boolean' },
          },
        },

        // --- Animation Clips ---
        CreateAnimationClip: {
          type: 'object',
          required: ['name', 'sourceFilePath', 'duration'],
          properties: {
            name:           { type: 'string' },
            sourceFilePath: { type: 'string' },
            clipIndex:      { type: 'integer', default: 0 },
            label:          { type: 'string' },
            startTime:      { type: 'number', default: 0 },
            endTime:        { type: 'number' },
            duration:       { type: 'number' },
            fps:            { type: 'number', default: 30 },
          },
        },

        // --- Assets ---
        CreateAsset: {
          type: 'object',
          required: ['name', 'data'],
          properties: {
            name:     { type: 'string', description: 'Original filename with extension' },
            mimeType: { type: 'string' },
            data:     { type: 'string', format: 'byte', description: 'Base64-encoded file contents' },
          },
        },

        // --- Node Components ---
        CreateNodeComponent: {
          type: 'object',
          required: ['kind'],
          properties: {
            id:        { type: 'string' },
            kind:      { type: 'string' },
            enabled:   { type: 'boolean' },
            config:    { type: 'object', additionalProperties: true },
            sortOrder: { type: 'integer' },
          },
        },
        UpdateNodeComponent: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            config:  { type: 'object', additionalProperties: true },
          },
        },

        // --- API Controller ---
        ApiControllerAnimation: {
          type: 'object',
          required: ['animation'],
          properties: { animation: { type: 'string', minLength: 1 } },
        },
        ApiControllerAnimationQueue: {
          type: 'object',
          required: ['queue'],
          properties: {
            queue: {
              type: 'array',
              items: {
                type: 'object',
                required: ['animation'],
                properties: { animation: { type: 'string', minLength: 1 } },
              },
            },
            loopMode: { type: 'string', enum: ['none', 'last', 'queue'] },
          },
        },
        ApiControllerBlendshapes: {
          oneOf: [
            {
              type: 'object',
              required: ['preset'],
              properties: { preset: { type: 'string', minLength: 1 } },
            },
            {
              type: 'object',
              required: ['blendshapes'],
              properties: {
                blendshapes: {
                  type: 'object',
                  additionalProperties: { type: 'number' },
                },
              },
            },
          ],
        },

        // --- Camera Effects ---
        CreateCameraEffect: {
          type: 'object',
          required: ['kind'],
          properties: {
            id:      { type: 'string' },
            kind:    { type: 'string' },
            enabled: { type: 'boolean' },
            config:  { type: 'object', additionalProperties: true },
          },
        },
        UpdateCameraEffect: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            config:  { type: 'object', additionalProperties: true },
          },
        },

        // --- Signal Graph ---
        FireGraphEvent: {
          type: 'object',
          required: ['nodeId', 'port'],
          properties: {
            nodeId: { type: 'string' },
            port:   { type: 'string' },
          },
        },
      },
    },
    tags: [
      { name: 'projects',        description: 'Project CRUD' },
      { name: 'scenes',          description: 'Scene CRUD within a project' },
      { name: 'scene_nodes',     description: 'Scene node CRUD + animation clips' },
      { name: 'assets',          description: 'Project asset uploads + listing' },
      { name: 'node_components', description: 'Behavioural components attached to scene nodes' },
      { name: 'api_controller',  description: 'REST control surface for api_controller components' },
      { name: 'expressions',     description: 'Read-only listings of VRM expressions and animation clips' },
      { name: 'camera_effects',  description: 'Post-processing effects bound to camera nodes' },
      { name: 'signal',          description: 'Signal graph introspection + event firing' },
      { name: 'meta',            description: 'Component-kind metadata, system info, body-calibration state' },
    ],
  },
  apis: ['./src/routes/*.ts'],
});
