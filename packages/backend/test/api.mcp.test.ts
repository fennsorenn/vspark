import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestApp } from './helpers/testApp.js';
import { VsparkClient } from '../src/mcp/client.js';
import { createMcpServer } from '../src/mcp/server.js';

/**
 * Exercises the MCP tool layer end-to-end against a real backend: the tools
 * call the REST API over loopback, driven through an in-memory MCP client (the
 * same path the in-app assistant uses).
 */
describe('MCP server', () => {
  let app: Express;
  let httpServer: Server;
  let baseUrl: string;
  let mcp: Client;

  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? '').join('\n');

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, resolve);
    });
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const server = createMcpServer(new VsparkClient({ baseUrl }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
  });

  afterEach(async () => {
    await mcp.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('exposes the full tool catalog', async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('create_scene_node');
    expect(names).toContain('create_compose_layer');
    expect(names).toContain('set_logic_descriptor');
    expect(names).toContain('lookup_node_kind');
    expect(tools.length).toBeGreaterThanOrEqual(18);
  });

  it('creates and reads back a scene node through tools', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const scene = (
      await request(app)
        .post(`/api/projects/${proj.id}/scenes`)
        .send({ name: 'Main' })
    ).body.data;

    const created = (await mcp.callTool({
      name: 'create_scene_node',
      arguments: {
        sceneId: scene.id,
        name: 'Hero',
        kind: 'avatar',
        components: { transform: { type: 'transform', x: 2, y: 0, z: 0 } },
      },
    })) as { content: { type: string; text?: string }[] };
    expect(text(created)).toContain('"id"');

    const listed = (await mcp.callTool({
      name: 'list_scene_nodes',
      arguments: { sceneId: scene.id },
    })) as { content: { type: string; text?: string }[] };
    expect(text(listed)).toContain('Hero');
  });

  it('reports a tool error without throwing the protocol', async () => {
    const res = (await mcp.callTool({
      name: 'create_scene_node',
      arguments: { sceneId: 'does-not-exist', name: 'X', kind: 'avatar' },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(text(res).toLowerCase()).toContain('error');
  });

  it('wires a logic graph via the two-step create + set descriptor', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const created = JSON.parse(
      text(
        (await mcp.callTool({
          name: 'create_project_logic',
          arguments: { projectId: proj.id, name: 'L1' },
        })) as { content: { type: string; text?: string }[] }
      )
    ) as { id: string };

    await mcp.callTool({
      name: 'set_logic_descriptor',
      arguments: {
        id: created.id,
        descriptor: {
          id: 'g1',
          label: 'L1',
          readonly: false,
          nodes: [
            { id: 'clk', kind: 'clock', position: { x: 0, y: 0 } },
            { id: 'rnd', kind: 'random', position: { x: 200, y: 0 } },
          ],
          edges: [
            {
              fromNodeId: 'clk',
              fromPort: 'tick',
              toNodeId: 'rnd',
              toPort: 'fire',
              kind: 'event',
            },
          ],
        },
      },
    });

    const got = JSON.parse(
      text(
        (await mcp.callTool({
          name: 'get_logic',
          arguments: { id: created.id },
        })) as { content: { type: string; text?: string }[] }
      )
    ) as { descriptor: { nodes: unknown[]; edges: unknown[] } };
    expect(got.descriptor.nodes).toHaveLength(2);
    expect(got.descriptor.edges).toHaveLength(1);
  });
});

describe('assistant config API', () => {
  let app: Express;
  beforeEach(async () => {
    // Isolate config.json to a throwaway path so tests don't write into the repo.
    process.env.VSPARK_CONFIG_PATH = `/tmp/vspark-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    ({ app } = await makeTestApp());
  });
  afterEach(() => {
    delete process.env.VSPARK_CONFIG_PATH;
  });

  it('never leaks the api key and redacts to hasApiKey', async () => {
    await request(app)
      .put('/api/assistant-config')
      .send({ enabled: true, baseUrl: 'http://x', model: 'm', apiKey: 'secret' })
      .expect(200);
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.data.assistant.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('keeps the existing key when apiKey is omitted on update', async () => {
    await request(app)
      .put('/api/assistant-config')
      .send({ baseUrl: 'http://x', model: 'm', apiKey: 'secret' });
    const res = await request(app)
      .put('/api/assistant-config')
      .send({ model: 'm2' })
      .expect(200);
    expect(res.body.data.hasApiKey).toBe(true);
    expect(res.body.data.model).toBe('m2');
  });
});
