// Shared helpers for the overlive outbound-action nodes. Each action node reads
// its destination `account` (port → config fallback) and coerces string/number
// ports into the shapes OverliveManager expects. All nodes fire-and-forget; the
// manager swallows + logs errors.

import { getOverliveManager } from '../../../overlive/manager.js';

/** Resolve the destination account: `account` port value, else config fallback.
 *  Takes the thunk + config value (not the node) because `Node.config` is
 *  protected and can't be read through a structural type. */
export function acct(getter: () => unknown, cfgAccount?: string): string | undefined {
  const v = getter() as string | undefined;
  return v && v.length > 0 ? v : cfgAccount;
}

/** Like {@link acct}, but an empty account (port and config) falls back to the
 *  project's default account — the same fallback the inbound trigger nodes get
 *  in `OverliveManager.nodeAcceptsEvent`. Used by the nodes the Actions
 *  templates send through (`overlive_send_chat`, `overlive_redemption_status`),
 *  whose account setting is empty unless the user picks one. The other action
 *  nodes keep "no account → do nothing". */
export function acctOrDefault(
  getter: () => unknown,
  cfg: { account?: string; _projectId?: unknown } | undefined
): string | undefined {
  const a = acct(getter, cfg?.account);
  if (a) return a;
  const projectId = cfg?._projectId;
  if (typeof projectId !== 'string' || projectId === '') return undefined;
  return getOverliveManager().getDefaultAccountId(projectId) ?? undefined;
}

/** Port value (string) with a config fallback; trimmed-empty stays as ''. */
export function strOf(getter: () => string | undefined, cfgVal?: string): string {
  const v = getter();
  if (typeof v === 'string') return v;
  return cfgVal ?? '';
}

/** Port value (number) with a config fallback; undefined if neither is finite. */
export function numOf(getter: () => number | undefined, cfgVal?: number): number | undefined {
  const v = getter();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof cfgVal === 'number' && Number.isFinite(cfgVal)) return cfgVal;
  return undefined;
}

/** Parse an on/off toggle. `undefined`/blank → leave unchanged. */
export function toggle(v?: string): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'on' || s === 'true' || s === '1') return true;
  if (s === 'off' || s === 'false' || s === '0') return false;
  return undefined;
}

/** Parse a chat-mode duration field: blank → unchanged, `off` → disable, `on` →
 *  enable with default, a number → enable with that value (minutes/seconds). */
export function durationSetting(v?: string): boolean | number | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'off') return false;
  if (s === 'on') return true;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Split a comma/newline-separated list into trimmed, non-empty entries. */
export function splitList(v?: string): string[] {
  if (!v) return [];
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
