/**
 * Bridges the assistant agent to the editor WebSocket. Holds one
 * {@link AssistantAgent} per connected client (conversation state is
 * per-socket), routes inbound assistant_* messages, and streams agent events
 * back to that single socket via wsSync.sendTo.
 */
import type { WebSocket } from 'ws';
import type { WSSync } from '../ws/index.js';
import { VsparkClient } from '../mcp/client.js';
import { resolveAssistantConfig } from '../routes/config.js';
import { AssistantAgent } from './agent.js';

export class AssistantManager {
  private readonly agents = new Map<WebSocket, AssistantAgent>();

  constructor(
    private readonly wsSync: WSSync,
    /** Loopback base URL the MCP tools hit (e.g. http://127.0.0.1:3001). */
    private readonly loopbackBaseUrl: string
  ) {}

  /** Returns true if it handled the message kind. */
  handle(kind: string, payload: unknown, ws: WebSocket): boolean {
    if (kind === 'assistant_user_message') {
      const text = (payload as { text?: string }).text;
      if (typeof text === 'string' && text.trim()) void this.runTurn(ws, text);
      return true;
    }
    if (kind === 'assistant_reset') {
      this.agents.get(ws)?.reset();
      return true;
    }
    return false;
  }

  private async runTurn(ws: WebSocket, text: string): Promise<void> {
    let agent = this.agents.get(ws);
    if (!agent) {
      const cfg = await resolveAssistantConfig();
      if (!cfg.enabled || !cfg.baseUrl) {
        this.wsSync.sendTo(ws, 'assistant_error', {
          message:
            'The assistant is not configured. Set the LLM endpoint in the assistant settings.',
        });
        this.wsSync.sendTo(ws, 'assistant_done', {});
        return;
      }
      agent = new AssistantAgent(
        new VsparkClient({ baseUrl: this.loopbackBaseUrl }),
        { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        this.wsSync.sessionIdFor(ws) ?? undefined
      );
      this.agents.set(ws, agent);
      ws.on('close', () => {
        this.agents.get(ws)?.close();
        this.agents.delete(ws);
      });
    }

    await agent.runTurn(text, {
      onText: (t) => this.wsSync.sendTo(ws, 'assistant_text', { text: t }),
      onToolCall: (c) =>
        this.wsSync.sendTo(ws, 'assistant_tool_call', {
          id: c.id,
          name: c.name,
          args: c.args as Record<string, unknown>,
        }),
      onToolResult: (r) =>
        this.wsSync.sendTo(ws, 'assistant_tool_result', {
          id: r.id,
          ok: r.ok,
          text: r.text.slice(0, 2000),
        }),
      onError: (message) =>
        this.wsSync.sendTo(ws, 'assistant_error', { message }),
      onDone: () => this.wsSync.sendTo(ws, 'assistant_done', {}),
    });
  }
}
