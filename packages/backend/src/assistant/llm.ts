/**
 * Minimal OpenAI-compatible chat client (works against vLLM, Ollama, OpenAI,
 * etc.). Non-streaming for the tool-calling loop body; the agent streams
 * user-visible deltas itself via WS. Kept dependency-free (global fetch).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
}

/** One blocking chat completion with optional tools. */
export async function chatCompletion(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ChatTool[],
  opts: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<ChatResult> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      temperature: 0,
      max_tokens: opts.maxTokens ?? 1500,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
  };
  const choice = json.choices?.[0];
  if (!choice?.message) throw new Error('LLM returned no message');
  return {
    message: {
      role: 'assistant',
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    },
    finishReason: choice.finish_reason ?? null,
  };
}
