/**
 * Validation of `plugin_account` / `plugin_app` documents for every writer
 * (mesh `validate`). Tabs may rename an account, make it the default or
 * delete it, and edit a provider's app fields; accounts are only CREATED by
 * the server after a completed OAuth flow (the tab grant has no `create`).
 */
const PROVIDER_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

type Dto = Record<string, unknown>;

const isObj = (v: unknown): v is Dto => typeof v === 'object' && v !== null && !Array.isArray(v);

export function guardPluginAccount(d: Dto, prev: Dto | undefined, fromTab: boolean): Dto {
  if (typeof d.id !== 'string' || !d.id) throw new Error('An account needs an id.');
  if (typeof d.projectId !== 'string' || !d.projectId) throw new Error('An account needs a project.');
  if (typeof d.provider !== 'string' || !PROVIDER_RE.test(d.provider))
    throw new Error('An account needs a provider "<plugin>:<provider>".');
  const out: Dto = {
    ...d,
    label: typeof d.label === 'string' ? d.label.slice(0, 120) : '',
    identity: isObj(d.identity) ? d.identity : {},
    isDefault: d.isDefault === true,
  };
  // What the server established at connect time is not a tab's to change.
  if (fromTab && prev)
    for (const k of ['projectId', 'provider', 'identity', 'createdAt'] as const)
      if (k in prev) out[k] = prev[k];
  return out;
}

export function guardPluginApp(d: Dto, allowedFields?: readonly string[]): Dto {
  if (typeof d.projectId !== 'string' || !d.projectId) throw new Error('App credentials need a project.');
  if (typeof d.provider !== 'string' || !PROVIDER_RE.test(d.provider))
    throw new Error('App credentials need a provider "<plugin>:<provider>".');
  if (d.id !== `${d.projectId}:${d.provider}`) throw new Error('App credentials id must be "<projectId>:<provider>".');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(isObj(d.fields) ? d.fields : {})) {
    if (allowedFields && !allowedFields.includes(k)) continue;
    if (typeof v === 'string') fields[k] = v.trim().slice(0, 500);
  }
  return { ...d, fields };
}
