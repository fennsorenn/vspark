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
  captureProjectSnapshot,
  revertChangeSet,
  type ProjectSnapshot,
} from './checkpoint.js';
import {
  chatCompletion,
  type ChatMessage,
  type ChatTool,
  type ContentPart,
  type LlmConfig,
} from './llm.js';

const MAX_TOOL_ROUNDS = 24;
/** Tool results within this many of the latest are kept verbatim. */
const RECENT_TOOL_RESULTS = 8;
/** Never compact/drop the last N messages (protects the in-flight reasoning). */
const KEEP_LAST_MESSAGES = 12;
/** Hard cap on total message-content chars (~6k tokens) so a multi-turn
 *  conversation degrades gracefully instead of overflowing a 16k window. */
const HISTORY_CHAR_BUDGET = 24000;
/** Older results from these tools are still reasoning fuel — keep them (capped).
 *  Everything else is an action whose stale result collapses to its id/ok. */
const REFERENCE_TOOL = /^(list_|lookup_|get_)/;
const REFERENCE_CAP = 1800;

/**
 * Additive lazy tool-loading (#1): the mutation (action) tools are grouped by
 * family and hidden until the agent calls enable_tools(group). Everything NOT
 * listed here — list_ and lookup_ discovery + ui_ pointing — is always-on core.
 * This keeps ~4k tokens of action-tool schemas out of the per-call prompt until
 * they're needed, which matters a lot on a 16k-context model.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  objects: ['create_scene_node', 'update_scene_node', 'delete_scene_node'],
  compose: [
    'create_compose_scene',
    'create_compose_layer',
    'update_compose_layer',
    'delete_compose_layer',
  ],
  presets: ['instantiate_preset'],
  logic: [
    'create_project_logic',
    'update_logic',
    'set_logic_descriptor',
    'delete_logic',
  ],
  timeline: [
    'create_track_clip',
    'update_track_clip',
    'delete_track_clip',
    'add_track_clip_lane',
    'delete_track_clip_lane',
    'set_track_clip_keyframes',
    'control_track_clip',
  ],
  behaviors: [
    'attach_behavior',
    'update_behavior',
    'delete_behavior',
    'play_animation',
    'set_animation_queue',
    'set_blendshapes',
    'clear_blendshapes',
  ],
  effects: [
    'add_camera_effect',
    'update_camera_effect',
    'delete_camera_effect',
  ],
};
const TOOL_TO_GROUP = new Map<string, string>(
  Object.entries(TOOL_GROUPS).flatMap(([g, names]) =>
    names.map((n) => [n, g] as [string, string])
  )
);
/** Agent-side tool, surfaced only after a turn mutated the project, so "undo
 *  that" can roll the whole turn back (see assistant/checkpoint.ts). */
const REVERT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'revert_last_change',
    description:
      'Undo everything your previous change-making turn did to the project, restoring it to how it was just ' +
      'before. Call this when the user asks to undo / revert / take back your last changes. Only available ' +
      'right after a turn that modified the project; reverts that one turn (not older ones).',
    parameters: { type: 'object', properties: {} },
  },
};

const ENABLE_TOOLS: ChatTool = {
  type: 'function',
  function: {
    name: 'enable_tools',
    description:
      'Action tools (create/update/delete/wire) are lazy-loaded to save space. Call this to load the ' +
      'family you need BEFORE acting, then call the tool. group is one of: objects (scene nodes/objects), ' +
      'compose (2D overlay layers), presets (instantiate a preset), logic (signal/logic graphs), timeline ' +
      '(track clips + animation), behaviors (avatar drivers + animation playback), effects (camera post-FX). ' +
      'Enable several by calling repeatedly. Discovery (list_*/lookup_*) and pointing (ui_*) tools are ' +
      'always available without enabling.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: Object.keys(TOOL_GROUPS) },
      },
      required: ['group'],
    },
  },
};

/** Strip leaked chat-template control/channel tokens from visible assistant text
 *  (e.g. gemma/harmony "<|channel>thought<channel|>" markers). Once a control
 *  token appears, the rest is internal formatting that leaked — cut there, then
 *  remove any residual "<|...|>" / "<...|>" tokens. */
export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  const cut = text.search(
    /<\|?(channel|message|start_of_turn|end_of_turn|im_start|im_end|start|end|assistant|system|user)\b/i
  );
  let out = cut >= 0 ? text.slice(0, cut) : text;
  out = out.replace(/<\|[^>]*?\|?>|<[^<>]*?\|>/g, '');
  return out.trimEnd();
}

/** Collapse a stale action-tool result to the bit the agent might still need:
 *  the returned id / ok flag, else a short stub. */
function stubActionResult(content: string): string {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const k of ['id', 'rootId', 'ok', 'delivered', 'error'])
      if (k in obj) keep[k] = obj[k];
    if (Object.keys(keep).length) return JSON.stringify(keep);
  } catch {
    /* not JSON */
  }
  return content.length > 80 ? content.slice(0, 80) + ' …' : content;
}

/**
 * Selective history compaction (#4): bound context growth WITHOUT breaking the
 * assistant↔tool pairing — never drop messages, only shorten stale tool results.
 * The most recent results stay verbatim; older `list_*`/`lookup_*`/`get_*`
 * reference fetches (what the agent reasons on) are kept but capped, while older
 * action results (create/update/set/…) collapse to their id/ok. Mutates in place.
 */
/** Replace inlined image parts in older user turns with a short text note, so a
 *  conversation with several image attachments doesn't re-transmit every base64
 *  blob on every round. The image only needed to be seen on its own turn. */
export function stripStaleImages(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'tool') continue;
    if (!Array.isArray(m.content)) continue;
    if (!m.content.some((p) => p.type === 'image_url')) continue;
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    const n = m.content.filter((p) => p.type === 'image_url').length;
    m.content =
      (text ? text + '\n' : '') +
      `[${n} attached image${n > 1 ? 's' : ''} omitted from history]`;
  }
}

export function compactToolHistory(messages: ChatMessage[]): void {
  const idToName = new Map<string, string>();
  for (const m of messages)
    if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls) idToName.set(tc.id, tc.function.name);

  // Pass 1 — shorten stale tool RESULTS (keep recent + reference fetches).
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    seen++;
    if (seen <= RECENT_TOOL_RESULTS) continue; // recent → untouched
    const name = idToName.get(m.tool_call_id ?? '') ?? '';
    if (REFERENCE_TOOL.test(name)) {
      if (m.content.length > REFERENCE_CAP && !m.content.endsWith('…'))
        m.content = m.content.slice(0, REFERENCE_CAP) + ' …';
    } else {
      m.content = stubActionResult(m.content);
    }
  }

  // Pass 2 — stub stale action-tool-call ARGUMENTS (e.g. a full graph descriptor
  // the model emitted; once executed it's dead weight). Keep '{}' so it stays
  // valid JSON, and leave the last KEEP_LAST_MESSAGES alone.
  const cut = messages.length - KEEP_LAST_MESSAGES;
  for (let i = 1; i < cut; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls)
      if (
        !REFERENCE_TOOL.test(tc.function.name) &&
        tc.function.name !== 'enable_tools' &&
        tc.function.arguments.length > 2
      )
        tc.function.arguments = '{}';
  }

  // Pass 3 — hard cap: drop the oldest complete (assistant + its tool results)
  // groups until under budget.
  const size = () =>
    messages.reduce((s, m) => s + JSON.stringify(m).length, 0);
  while (size() > HISTORY_CHAR_BUDGET) {
    if (!dropOldestGroup(messages)) break; // nothing safe left to drop
  }
}

/** Remove the oldest complete (assistant-with-tool_calls + its tool results)
 *  group, atomically so tool-call pairing stays valid. Never touches the system
 *  message, user turns, or the last KEEP_LAST_MESSAGES. Returns false if none. */
function dropOldestGroup(messages: ChatMessage[]): boolean {
  let idx = -1;
  for (let i = 1; i < messages.length - KEEP_LAST_MESSAGES; i++)
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      idx = i;
      break;
    }
  if (idx === -1) return false;
  let j = idx + 1;
  while (j < messages.length && messages[j].role === 'tool') j++;
  messages.splice(idx, j - idx);
  return true;
}

/** Recovery prune: drop oldest groups until at most `targetLen` messages remain. */
export function pruneOldestGroups(
  messages: ChatMessage[],
  targetLen: number
): void {
  while (messages.length > targetLen && dropOldestGroup(messages)) {
    /* keep dropping */
  }
}

const SYSTEM_PROMPT =
  'You are the vspark assistant, embedded in a 3D avatar/scene editor. You help the user by ' +
  'operating their project through the provided tools — creating and configuring scene objects, 2D ' +
  'compose layers and feed templates, and building/wiring logic (signal) graphs. Work step by step. ' +
  'PREFER PRESETS OVER BUILDING FROM SCRATCH: when a request matches a common building block — a chat / ' +
  'feed overlay, an event alert, a particle effect, a lighting rig — call list_presets first and ' +
  'instantiate_preset the closest match, then adjust only what the user asked to change. Presets come ' +
  'prewired (e.g. a feed node already connected to its data graph), so this is far more reliable than ' +
  'hand-building feed templates or logic graphs. Only build from scratch when no preset fits. ' +
  'Action tools (create/update/delete/wire) are LAZY-LOADED to save space: before you create or edit ' +
  'anything, call enable_tools(group) for the family you need (objects, compose, presets, logic, ' +
  'timeline, behaviors, effects), then call the tool. Discovery (list_*/lookup_*) and pointing (ui_*) ' +
  'tools are always available. ' +
  'You can SEE images: call view_asset(assetId) to look at an image asset (e.g. to pick a ' +
  'border-image-slice from how deep a frame’s ornament runs), and render_feed_template(template, css, ' +
  'data) to rasterize a feed template to a picture and verify it looks right BEFORE applying it. ' +
  'Use the list_* and lookup_* tools to discover project ids and signal-node port names before you ' +
  'mutate anything; never invent ids or ports. Read tool descriptions carefully — some API semantics ' +
  '(components vs properties, config-replace-on-update, the two-step logic create+wire) are easy to get ' +
  'wrong. For event-driven motion (e.g. "bounce/react when a chat message arrives") the idiomatic ' +
  'pattern is: make a track clip for the motion, then a logic graph that fires the start_clip node ' +
  'on the event — call list_node_kinds (it describes what each node does) to find the right nodes ' +
  'instead of guessing kind names, then lookup_node_kind for exact ports. ' +
  'Deleting is destructive: before calling any delete tool, confirm with the user in plain ' +
  'language and wait for their reply unless they already clearly asked for that exact deletion. ' +
  'If the user asks to UNDO or revert your last change, call revert_last_change (offered only right ' +
  'after a turn that modified the project) — it rolls that whole turn back. ' +
  'You can REFERENCE an existing streaming account (list_overlive_accounts) when wiring a chat/event ' +
  'feed, but you cannot CONNECT one — connecting Twitch/StreamElements is an OAuth login only the user ' +
  'can do. When an account is missing or needs connecting, do not attempt it: open the Accounts dialog ' +
  '(ui_open_window window:"accounts") or highlight it (ui_highlight_control "vs-topbar-accounts") and ' +
  'ask the user to connect there. ' +
  'When the task is done, briefly tell the user what you changed in plain language — but only AFTER ' +
  'you have read the result back and confirmed it (see verification below), claiming only what you verified.';

/** Injected once, after the model makes changes and tries to finish, to force a
 *  read-back before it claims success (a tool call returning ok does NOT mean the
 *  right thing landed — wrong target id / wrong tool can still "succeed"). */
const VERIFY_NUDGE =
  'Before you reply to the user: VERIFY your changes actually applied. Read the affected entities back ' +
  '(e.g. list_track_clips on the node, get_logic, list_scene_nodes, list_camera_effects, ' +
  'list_compose_layers) and check they match what was asked — right target, right values, right name. ' +
  'If anything is missing or landed wrong, fix it now. Then write your summary, claiming ONLY what the ' +
  'read-back confirmed.';

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
  /** Full catalog from MCP; the LLM sees a lazy-loaded subset (see activeTools). */
  private allTools: ChatTool[] = [];
  /** Action-tool families the agent has enabled this conversation. */
  private enabledGroups = new Set<string>();
  /** Project snapshot taken at the start of the current turn. */
  private turnStartSnapshot: ProjectSnapshot | null = null;
  /** The before/after snapshots bracketing the last turn that mutated — their
   *  diff is the agent's change-set, which revert_last_change rolls back (only
   *  docs the agent changed, only if untouched since — never a user's edits). */
  private revertable: { before: ProjectSnapshot; after: ProjectSnapshot } | null =
    null;
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
    this.allTools = tools.map((t) => ({
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

  /** Tools shown to the LLM this round: always-on core (anything not in a group)
   *  + currently-enabled action families + the enable_tools loader. */
  private activeTools(): ChatTool[] {
    const active = this.allTools.filter((t) => {
      const g = TOOL_TO_GROUP.get(t.function.name);
      return !g || this.enabledGroups.has(g);
    });
    active.push(ENABLE_TOOLS);
    // Offer undo only when there's a mutating turn to roll back.
    if (this.revertable) active.push(REVERT_TOOL);
    return active;
  }

  reset(): void {
    this.messages = [{ role: 'system', content: this.systemMessage() }];
    this.enabledGroups.clear();
  }

  /** chatCompletion, but if the model reports a context-length overflow, prune
   *  the history harder (drop more old groups) and retry once so a long
   *  conversation degrades gracefully instead of dying. */
  private async completeWithRecovery(
    signal?: AbortSignal
  ): Promise<{ message: ChatMessage }> {
    try {
      return await chatCompletion(this.llm, this.messages, this.activeTools(), {
        signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/context length|too many tokens|maximum context/i.test(msg)) throw e;
      // Aggressively drop the oldest groups (keep ~half) and retry once.
      pruneOldestGroups(this.messages, Math.ceil(this.messages.length / 2));
      return await chatCompletion(this.llm, this.messages, this.activeTools(), {
        signal,
      });
    }
  }


  /** Run one user turn to completion, emitting events as it goes. */
  async runTurn(
    userContent: string | ContentPart[],
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
      // Start each turn lean: re-enable only the action families this turn needs,
      // so a long multi-feature conversation doesn't carry every group's schemas.
      this.enabledGroups.clear();
      // Inlined attachment images are only relevant to the turn they arrive on.
      // Strip them from prior user turns so the conversation doesn't re-ship
      // every base64 blob each round (transport bloat on a small-context model).
      stripStaleImages(this.messages);
      this.messages.push({ role: 'user', content: userContent });

      // Checkpoint the project before this turn touches anything, so a mutating
      // turn can be rolled back wholesale via revert_last_change (undo).
      this.turnStartSnapshot = this.projectId
        ? captureProjectSnapshot(this.projectId)
        : null;

      // Did this turn make any mutations, and have we forced the read-back yet?
      let mutated = false;
      let verifyRequested = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (signal?.aborted) return;
        compactToolHistory(this.messages);
        const { message } = await this.completeWithRecovery(signal);
        if (typeof message.content === 'string')
          message.content = sanitizeAssistantText(message.content);
        this.messages.push(message);

        const calls = message.tool_calls ?? [];

        // The model wants to finish. If it changed things but hasn't verified
        // yet, force one read-back pass — and SUPPRESS this (premature) claim so
        // the user only ever sees the verified summary.
        if (calls.length === 0 && mutated && !verifyRequested) {
          verifyRequested = true;
          this.messages.push({ role: 'user', content: VERIFY_NUDGE });
          continue;
        }

        if (typeof message.content === 'string' && message.content)
          events.onText(message.content);
        if (calls.length === 0) {
          // Turn finished. If it changed the project, capture the after-state so
          // its diff vs. the start snapshot is this turn's revertable change-set.
          if (mutated && this.turnStartSnapshot && this.projectId)
            this.revertable = {
              before: this.turnStartSnapshot,
              after: captureProjectSnapshot(this.projectId),
            };
          return; // model is done
        }

        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments
              ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
              : {};
          } catch {
            /* malformed args → empty; tool will likely error, which we report */
          }
          if (TOOL_TO_GROUP.has(call.function.name)) mutated = true;
          events.onToolCall({ id: call.id, name: call.function.name, args });
          const { ok, text, images } = await this.callTool(
            call.function.name,
            args
          );
          events.onToolResult({ id: call.id, ok, text });
          const capped = text.slice(0, 4000);
          // A tool that returns image(s) (view_asset, render_feed_template) ships
          // them in the tool message so the (vision) model can see them.
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: images.length
              ? [{ type: 'text', text: capped }, ...images]
              : capped,
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
  ): Promise<{ ok: boolean; text: string; images: ContentPart[] }> {
    // enable_tools is an agent-side meta-tool — it reveals an action family to
    // the LLM rather than hitting the MCP server.
    if (name === 'enable_tools') {
      const g = String(args.group ?? '');
      if (!(g in TOOL_GROUPS))
        return {
          ok: false,
          images: [],
          text: `unknown group "${g}". groups: ${Object.keys(TOOL_GROUPS).join(', ')}`,
        };
      this.enabledGroups.add(g);
      return {
        ok: true,
        images: [],
        text: `Enabled ${g} tools: ${TOOL_GROUPS[g].join(', ')}. You can now call them.`,
      };
    }
    // revert_last_change is agent-side — it restores the snapshot captured before
    // the last mutating turn (auto-checkpoint undo), via the mesh so the editor
    // updates too. Single-level: clears the snapshot once used.
    if (name === 'revert_last_change') {
      if (!this.revertable)
        return {
          ok: false,
          images: [],
          text: 'Nothing to undo — there is no recent change of mine to revert.',
        };
      const { before, after } = this.revertable;
      this.revertable = null;
      try {
        const { reverted, skipped } = await revertChangeSet(before, after);
        const note =
          skipped > 0
            ? ` (left ${skipped} item(s) alone because they were changed after my turn).`
            : '.';
        return {
          ok: true,
          images: [],
          text: `Undid my last change — reverted ${reverted} item(s) I had modified${note} I only touched what I changed, not any edits made since.`,
        };
      } catch (e) {
        return {
          ok: false,
          images: [],
          text: `Failed to revert: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    // If the model called an action tool whose family isn't enabled yet (it knew
    // the name anyway), auto-enable and proceed instead of failing.
    const grp = TOOL_TO_GROUP.get(name);
    if (grp) this.enabledGroups.add(grp);
    // render_feed_template / screenshot_viewport act on THIS editor session —
    // inject our sessionId so the model doesn't have to (it may not know it for
    // non-ui_* tools).
    if (
      (name === 'render_feed_template' || name === 'screenshot_viewport') &&
      this.sessionId &&
      !args.sessionId
    )
      args = { ...args, sessionId: this.sessionId };
    if (!this.mcp)
      return { ok: false, images: [], text: 'MCP client not initialised' };
    try {
      const res = (await this.mcp.callTool({
        name,
        arguments: args,
      })) as {
        isError?: boolean;
        content?: { type: string; text?: string; data?: string; mimeType?: string }[];
      };
      const content = res.content ?? [];
      const text = content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
      const images: ContentPart[] = content
        .filter((c) => c.type === 'image' && c.data)
        .map((c) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${c.mimeType ?? 'image/png'};base64,${c.data}` },
        }));
      return { ok: !res.isError, text: text || '(no output)', images };
    } catch (e) {
      return {
        ok: false,
        images: [],
        text: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async close(): Promise<void> {
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
  }
}
