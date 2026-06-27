/**
 * The assistant agent. Per WS connection we hold one {@link AssistantAgent}
 * that keeps conversation state and an in-process MCP client linked (via the
 * SDK's in-memory transport) to a real vspark MCP server — so the agent drives
 * the project through exactly the same tool surface external clients use.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { VsparkClient } from '../mcp/client.js';
import { createMcpServer } from '../mcp/server.js';
import {
  chatCompletion,
  type ChatMessage,
  type ChatTool,
  type LlmConfig,
} from './llm.js';

const MAX_TOOL_ROUNDS = 16;

const SYSTEM_PROMPT =
  'You are the vspark assistant, embedded in a 3D avatar/scene editor. You help the user by ' +
  'operating their project through the provided tools — creating and configuring scene objects, 2D ' +
  'compose layers and feed templates, and building/wiring logic (signal) graphs. Work step by step. ' +
  'PREFER PRESETS OVER BUILDING FROM SCRATCH: when a request matches a common building block — a chat / ' +
  'feed overlay, an event alert, a particle effect, a lighting rig — call list_presets first and ' +
  'instantiate_preset the closest match, then adjust only what the user asked to change. Presets come ' +
  'prewired (e.g. a feed node already connected to its data graph), so this is far more reliable than ' +
  'hand-building feed templates or logic graphs. Only build from scratch when no preset fits. ' +
  'Use the list_* and lookup_* tools to discover project ids and signal-node port names before you ' +
  'mutate anything; never invent ids or ports. Read tool descriptions carefully — some API semantics ' +
  '(components vs properties, config-replace-on-update, the two-step logic create+wire) are easy to get ' +
  'wrong. For event-driven motion (e.g. "bounce/react when a chat message arrives") the idiomatic ' +
  'pattern is: make a track clip for the motion, then a logic graph that fires the start_clip node ' +
  'on the event — call list_node_kinds (it describes what each node does) to find the right nodes ' +
  'instead of guessing kind names, then lookup_node_kind for exact ports. ' +
  'Deleting is destructive: before calling any delete tool, confirm with the user in plain ' +
  'language and wait for their reply unless they already clearly asked for that exact deletion. ' +
  'You can REFERENCE an existing streaming account (list_overlive_accounts) when wiring a chat/event ' +
  'feed, but you cannot CONNECT one — connecting Twitch/StreamElements is an OAuth login only the user ' +
  'can do. When an account is missing or needs connecting, do not attempt it: open the Accounts dialog ' +
  '(ui_open_window window:"accounts") or highlight it (ui_highlight_control "vs-topbar-accounts") and ' +
  'ask the user to connect there. ' +
  'When the task is done, briefly tell the user what you changed in plain language.';

export interface AgentEvents {
  /** Visible assistant text produced in a round (may be intermediate). */
  onText: (text: string) => void;
  onToolCall: (c: { id: string; name: string; args: unknown }) => void;
  onToolResult: (r: { id: string; ok: boolean; text: string }) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

export class AssistantAgent {
  private mcp: Client | null = null;
  private tools: ChatTool[] = [];
  private messages: ChatMessage[];
  private busy = false;

  constructor(
    private readonly vspark: VsparkClient,
    private readonly llm: LlmConfig,
    /** This client's editor session id — injected so the agent can drive that
     *  exact tab via the ui_* tools without the user having to supply it. */
    private readonly sessionId?: string,
    /** The project the user currently has open — injected so the agent acts on
     *  the right project instead of guessing from list_projects. */
    private readonly projectId?: string
  ) {
    this.messages = [{ role: 'system', content: this.systemMessage() }];
  }

  private systemMessage(): string {
    let msg = SYSTEM_PROMPT;
    if (this.projectId)
      msg +=
        `\n\nThe user is CURRENTLY working in project ${this.projectId}. Use this ` +
        'project id for everything unless they clearly ask about a different one — ' +
        'do NOT call list_projects to pick a project, and never operate on a project ' +
        'the user is not looking at.';
    if (this.sessionId)
      msg +=
        `\n\nThe user's editor session id is ${this.sessionId}. Pass it as the ` +
        'sessionId argument to any ui_* tool to select an entity, open a panel/help ' +
        'window, or highlight a control in THEIR editor — do this to show the user ' +
        'what you created or to point them at the control they are looking for.';
    return msg;
  }

  /** Connect the in-memory MCP client and cache the tool list. */
  async init(): Promise<void> {
    if (this.mcp) return;
    const server = createMcpServer(this.vspark);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vspark-assistant', version: '0.1.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    this.mcp = client;
    const { tools } = await client.listTools();
    this.tools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  reset(): void {
    this.messages = [{ role: 'system', content: this.systemMessage() }];
  }

  /** Run one user turn to completion, emitting events as it goes. */
  async runTurn(
    userText: string,
    events: AgentEvents,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.busy) {
      events.onError('The assistant is still working on the previous message.');
      return;
    }
    this.busy = true;
    try {
      await this.init();
      this.messages.push({ role: 'user', content: userText });

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (signal?.aborted) return;
        const { message } = await chatCompletion(
          this.llm,
          this.messages,
          this.tools,
          { signal }
        );
        this.messages.push(message);

        if (message.content) events.onText(message.content);

        const calls = message.tool_calls ?? [];
        if (calls.length === 0) return; // model is done

        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments
              ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
              : {};
          } catch {
            /* malformed args → empty; tool will likely error, which we report */
          }
          events.onToolCall({ id: call.id, name: call.function.name, args });
          const { ok, text } = await this.callTool(call.function.name, args);
          events.onToolResult({ id: call.id, ok, text });
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: text.slice(0, 4000),
          });
        }
      }
      events.onText(
        '(Stopped after reaching the maximum number of tool steps.)'
      );
    } catch (e) {
      events.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
      events.onDone();
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; text: string }> {
    if (!this.mcp) return { ok: false, text: 'MCP client not initialised' };
    try {
      const res = (await this.mcp.callTool({
        name,
        arguments: args,
      })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      const text = (res.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
      return { ok: !res.isError, text: text || '(no output)' };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  async close(): Promise<void> {
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
  }
}
