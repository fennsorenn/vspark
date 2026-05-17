import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { AppConfig, UpdateChannel } from '@vspark/shared';
import { getInstallDir, checkForUpdates } from './update.js';

const VALID_CHANNELS: UpdateChannel[] = ['stable', 'recent', 'experimental'];

async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(join(getInstallDir(), 'config.json'), 'utf-8');
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { channel: 'stable' };
  }
}

async function writeConfig(cfg: AppConfig): Promise<void> {
  await writeFile(join(getInstallDir(), 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

export const configRoutes = Router();

configRoutes.get('/config', async (_req, res) => {
  const cfg = await readConfig();
  res.json({ ok: true, data: cfg });
});

configRoutes.put('/config', async (req, res) => {
  const { channel } = req.body as Partial<AppConfig>;
  if (!channel || !VALID_CHANNELS.includes(channel)) {
    res.status(400).json({ ok: false, error: { message: `channel must be one of: ${VALID_CHANNELS.join(', ')}` } });
    return;
  }
  const current = await readConfig();
  const updated: AppConfig = { ...current, channel };
  await writeConfig(updated);
  void checkForUpdates();
  res.json({ ok: true, data: updated });
});
