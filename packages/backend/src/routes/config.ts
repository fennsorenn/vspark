import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
  AppConfig,
  AssistantConfig,
  AssistantConfigPublic,
  UpdateChannel,
} from '@vspark/shared';
import { getInstallDir, checkForUpdates } from './update.js';

const VALID_CHANNELS: UpdateChannel[] = ['stable', 'recent', 'experimental'];

// No hard-coded, provider-specific default: the model comes from config.json or
// ASSISTANT_MODEL, and when neither is set the agent auto-detects it from the
// endpoint's /v1/models (see AssistantManager). '' means "ask the endpoint".
const DEFAULT_ASSISTANT_MODEL = process.env.ASSISTANT_MODEL ?? '';

/** Config file path. VSPARK_CONFIG_PATH overrides it (tests, custom installs);
 *  otherwise it lives next to the install. */
function configPath(): string {
  return process.env.VSPARK_CONFIG_PATH ?? join(getInstallDir(), 'config.json');
}

async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(), 'utf-8');
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { channel: 'stable' };
  }
}

async function writeConfig(cfg: AppConfig): Promise<void> {
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Effective assistant config = persisted config.json values, falling back to
 * env for any field not set. The endpoint is any OpenAI-compatible base URL
 * (vLLM, llama.cpp, Ollama's /v1, OpenAI itself, …). Env vars, in precedence
 * order: ASSISTANT_BASE_URL / ASSISTANT_API_KEY / ASSISTANT_MODEL (preferred,
 * provider-neutral), then legacy VLLM_HOST / VLLM_AUTH for back-compat. Used by
 * both the API surface and the agent wiring in index.ts.
 */
export async function resolveAssistantConfig(): Promise<AssistantConfig> {
  const stored = (await readConfig()).assistant;
  const envBase =
    process.env.ASSISTANT_BASE_URL ?? process.env.VLLM_HOST ?? '';
  const envKey = process.env.ASSISTANT_API_KEY ?? process.env.VLLM_AUTH ?? '';
  const baseUrl = stored?.baseUrl ?? envBase;
  return {
    enabled: stored?.enabled ?? Boolean(baseUrl),
    baseUrl,
    apiKey: stored?.apiKey ?? envKey,
    model: stored?.model ?? DEFAULT_ASSISTANT_MODEL,
  };
}

function toPublic(cfg: AssistantConfig): AssistantConfigPublic {
  return {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model,
  };
}

export const configRoutes = Router();

configRoutes.get('/config', async (_req, res) => {
  const cfg = await readConfig();
  const assistant = toPublic(await resolveAssistantConfig());
  // Never leak the raw assistant.apiKey; expose a redacted view instead.
  res.json({ ok: true, data: { channel: cfg.channel, assistant } });
});

configRoutes.put('/config', async (req, res) => {
  const { channel } = req.body as Partial<AppConfig>;
  if (!channel || !VALID_CHANNELS.includes(channel)) {
    res.status(400).json({
      ok: false,
      error: {
        message: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
      },
    });
    return;
  }
  const current = await readConfig();
  const updated: AppConfig = { ...current, channel };
  await writeConfig(updated);
  void checkForUpdates();
  res.json({ ok: true, data: { channel: updated.channel } });
});

/**
 * Update the assistant settings. apiKey is only overwritten when a non-empty
 * string is supplied, so callers can change the model/endpoint without
 * resending the secret. Returns the redacted public view.
 */
configRoutes.put('/assistant-config', async (req, res) => {
  const body = req.body as Partial<AssistantConfig>;
  const current = await readConfig();
  const base = await resolveAssistantConfig();
  const next: AssistantConfig = {
    enabled:
      typeof body.enabled === 'boolean' ? body.enabled : base.enabled,
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : base.baseUrl,
    model: typeof body.model === 'string' && body.model ? body.model : base.model,
    apiKey:
      typeof body.apiKey === 'string' && body.apiKey.length > 0
        ? body.apiKey
        : base.apiKey,
  };
  await writeConfig({ ...current, assistant: next });
  res.json({ ok: true, data: toPublic(next) });
});
