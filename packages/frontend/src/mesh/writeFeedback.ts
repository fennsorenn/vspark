/**
 * Turning a mesh write's outcome into something the user can see.
 *
 * Every committed write is optimistic: the value lands in the replica (and so in
 * the store, and so on screen) before the authority has agreed to it. When the
 * authority refuses — a backend guard throws, a descriptor is unrunnable, a
 * grant was revoked — the peer restores the pre-write state and the UI snaps
 * back. Without a notice, that is indistinguishable from a bug in the editor.
 *
 * Before this, all three write shapes dropped the outcome in a different way:
 *
 *   - `commitDocPath` (every bound field — the most common write in the app)
 *     never looked at the ack at all;
 *   - the create/delete helpers threw, and their callers either swallowed it
 *     (a bare `catch` with a "non-fatal" comment) or didn't catch at all;
 *   - the REST fallback ended in `.catch(() => {})`.
 *
 * So this module is the single place a write outcome becomes a message, and the
 * helpers call it rather than each call site remembering to.
 *
 * Text is translated HERE rather than at the call site: these run outside React,
 * where no `t` binding is in scope, so they read the i18n instance directly.
 */
import type { WriteOutcome } from '@vspark/mesh';
import i18n from '../i18n';
import { pushToast } from '../store/toastStore';

const tr = (key: string, vars?: Record<string, unknown>): string =>
  i18n.t(key, { ns: 'misc', ...vars }) as string;

/** What the user calls the thing that failed to save. An rtype is an internal
 *  word — "scene_node" in a message would be worse than saying nothing. */
export function actionLabel(rtype: string): string {
  return tr(`write.subject.${rtype}`, {
    defaultValue: tr('write.subject.doc'),
  });
}

/** Report a refusal. `reason` is the authority's own words (a guard's throw
 *  message), which is usually the only specific thing we can tell the user. */
export function reportRejected(subject: string, reason?: string): void {
  pushToast(
    'error',
    reason
      ? tr('write.rejectedWithReason', { subject, reason })
      : tr('write.rejected', { subject })
  );
}

/** Report that the write never landed — no peer, no authority, and the REST
 *  fallback failed too. Distinct from a refusal: nothing judged the write, it
 *  just didn't arrive. */
export function reportFailed(subject: string): void {
  pushToast('error', tr('write.failed', { subject }));
}

/** Inspect an outcome and report it if it is a refusal. Returns whether the
 *  write stands, so callers can `if (!settled(o, subject)) return;`. */
export function settled(outcome: WriteOutcome, subject: string): boolean {
  if (outcome.status === 'rejected') {
    reportRejected(subject, outcome.reason);
    return false;
  }
  return true;
}

/** Follow a fire-and-forget write. The bound-field path cannot await — an input
 *  commit is synchronous from the UI's side — so the handle is followed here
 *  and only a refusal surfaces. */
export function watch(ack: Promise<WriteOutcome>, subject: string): void {
  void ack.then(
    (o) => {
      if (o.status === 'rejected') reportRejected(subject, o.reason);
    },
    // A handle that never resolves (peer torn down mid-flight) is not worth
    // shouting about: the reconnect path re-syncs the document anyway.
    () => {}
  );
}
