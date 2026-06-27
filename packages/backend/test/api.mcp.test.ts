import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestApp } from './helpers/testApp.js';
import { VsparkClient } from '../src/mcp/client.js';
import { createMcpServer } from '../src/mcp/server.js';
import { TOOL_GROUPS } from '../src/assistant/agent.js';

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
    expect(names).toContain('delete_compose_layer');
    expect(names).toContain('delete_logic');
    expect(names).toContain('list_presets');
    expect(names).toContain('instantiate_preset');
    expect(names).toContain('create_track_clip');
    expect(names).toContain('add_track_clip_lane');
    expect(names).toContain('set_track_clip_keyframes');
    expect(names).toContain('control_track_clip');
    expect(names).toContain('lookup_param_paths');
    expect(names).toContain('list_behavior_kinds');
    expect(names).toContain('attach_behavior');
    expect(names).toContain('play_animation');
    expect(names).toContain('set_blendshapes');
    expect(names).toContain('list_assets');
    expect(names).toContain('list_camera_effect_kinds');
    expect(names).toContain('add_camera_effect');
    expect(names).toContain('list_ui_sessions');
    expect(names).toContain('ui_select_entity');
    expect(names).toContain('ui_highlight_control');
    expect(names).toContain('ui_open_panel');
    expect(names).toContain('list_overlive_accounts');
    expect(names).toContain('ui_select_camera_effect');
    expect(names).toContain('ui_open_logic_graph');
    expect(names).toContain('lookup_component_schema');
    expect(names).toContain('list_ui_controls');
    expect(names).toContain('update_logic');
    expect(tools.length).toBeGreaterThanOrEqual(60);
  });

  it('lazy-load tool groups reference only real, non-core action tools', async () => {
    const { tools } = await mcp.listTools();
    const names = new Set(tools.map((t) => t.name));
    const grouped = Object.values(TOOL_GROUPS).flat();
    // no name appears in two groups
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const name of grouped) {
      expect(names.has(name)).toBe(true); // exists in the catalog
      // groups hold only mutation tools — never always-on core families
      expect(name).not.toMatch(/^(list_|lookup_|get_|ui_)/);
    }
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

  // A 1x1 transparent PNG.
  const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('view_asset returns the image as MCP image content', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const asset = (
      await request(app)
        .post(`/api/projects/${proj.id}/assets`)
        .send({ name: 'pic.png', mimeType: 'image/png', data: PNG_1x1 })
    ).body.data;

    const res = (await mcp.callTool({
      name: 'view_asset',
      arguments: { assetId: asset.id },
    })) as { content: { type: string; data?: string; mimeType?: string }[] };
    const img = res.content.find((c) => c.type === 'image');
    expect(img).toBeTruthy();
    expect(img?.mimeType).toBe('image/png');
    expect((img?.data ?? '').length).toBeGreaterThan(20);
  });

  it('view_asset errors on a non-image asset', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const asset = (
      await request(app)
        .post(`/api/projects/${proj.id}/assets`)
        .send({ name: 'a.mp3', mimeType: 'audio/mpeg', data: PNG_1x1 })
    ).body.data;
    const res = (await mcp.callTool({
      name: 'view_asset',
      arguments: { assetId: asset.id },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not an image/);
  });

  it('render_feed_template degrades gracefully with no editor session', async () => {
    // Rendering happens in a connected editor; with none, it returns a note
    // (not an error) so the agent can proceed. (The editor round-trip itself is
    // covered by the ws feed-preview tests.)
    const res = (await mcp.callTool({
      name: 'render_feed_template',
      arguments: {
        template:
          '<div class="chat">${chat.map((m) => html`<div class="msg">${m.text}</div>`)}</div>',
        css: '.msg{border:2px solid #555;padding:4px}',
        data: { chat: [{ text: 'hi' }, { text: 'gg' }] },
        width: 200,
        height: 120,
      },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/editor session|apply it/i);
  });

  it('render_feed_template rejects a syntactically broken template', async () => {
    const res = (await mcp.callTool({
      name: 'render_feed_template',
      arguments: { template: '<div>${chat', data: {} },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Template syntax error/);
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

  it('resolves the endpoint from generic env, with legacy fallback', async () => {
    const { resolveAssistantConfig } = await import('../src/routes/config.js');
    const saved = {
      a: process.env.ASSISTANT_BASE_URL,
      b: process.env.VLLM_HOST,
    };
    try {
      delete process.env.ASSISTANT_BASE_URL;
      delete process.env.VLLM_HOST;
      // no endpoint anywhere → disabled (frontend hides the AI surface)
      expect((await resolveAssistantConfig()).enabled).toBe(false);
      // legacy var still works
      process.env.VLLM_HOST = 'http://legacy/v1';
      expect((await resolveAssistantConfig()).baseUrl).toBe('http://legacy/v1');
      // generic var takes precedence
      process.env.ASSISTANT_BASE_URL = 'http://generic/v1';
      const c = await resolveAssistantConfig();
      expect(c.baseUrl).toBe('http://generic/v1');
      expect(c.enabled).toBe(true);
    } finally {
      if (saved.a === undefined) delete process.env.ASSISTANT_BASE_URL;
      else process.env.ASSISTANT_BASE_URL = saved.a;
      if (saved.b === undefined) delete process.env.VLLM_HOST;
      else process.env.VLLM_HOST = saved.b;
    }
  });
});
