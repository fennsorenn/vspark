/**
 * Minimal OpenAI-compatible chat client (works against vLLM, Ollama, OpenAI,
 * etc.). Non-streaming for the tool-calling loop body; the agent streams
 * user-visible deltas itself via WS. Kept dependency-free (global fetch).
 */
/** A multimodal content part (OpenAI vision shape). A user turn that carries an
 *  attached image is sent as an array of these so a vision-capable endpoint
 *  (e.g. gemma-3) actually sees the pixels instead of just a url string. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
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

/** Ask an OpenAI-compatible endpoint for its model list and return the first id.
 *  Lets the assistant work with no model configured against a single-model
 *  server (vLLM, llama.cpp, Ollama) — returns '' if it can't be determined. */
export async function fetchFirstModel(
  baseUrl: string,
  apiKey?: string
): Promise<string> {
  try {
    const url = baseUrl.replace(/\/$/, '') + '/v1/models';
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return '';
    const json = (await res.json()) as { data?: { id?: string }[] };
    return json.data?.[0]?.id ?? '';
  } catch {
    return '';
  }
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
      // Conservative default: small-context models (e.g. 16k) overflow when a
      // long tool-call history meets a big requested completion. Reserve more
      // room for input; raise per-call via opts.maxTokens if a big output is
      // genuinely needed.
      max_tokens: opts.maxTokens ?? 1024,
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
