/**
 * Transient notices, for outcomes the user has to be told about but must not be
 * interrupted by.
 *
 * This exists because mesh writes could fail silently. A committed write is
 * optimistic — the value is in the store before the authority has agreed to it —
 * and a rejection makes the peer restore the pre-write state. Without a notice
 * that reads as "the field snapped back on its own", which is indistinguishable
 * from a bug. See {@link ../mesh/writeFeedback}.
 *
 * Deliberately NOT a dialog (see {@link ../components/DialogProvider}): a
 * refused write is not a question, and blocking on one would interrupt a gesture
 * the user has already moved on from. Toasts stack, auto-dismiss, and can be
 * dismissed by hand.
 */
import { create } from 'zustand';

export type ToastKind = 'error' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  /** Already-translated text. The store holds no i18n keys: a toast can be
   *  raised from a non-component module (the write helpers), where the `t`
   *  binding is not in scope, so callers translate at the raise site. */
  message: string;
}

/** How long a toast lives. Errors linger: they carry a reason the user may need
 *  to read, and unlike an info notice there is no other trace of them. */
const TTL_MS: Record<ToastKind, number> = { error: 8000, info: 4000 };

/** Cap the stack. A write path that fails in a loop (a subtree delete against a
 *  revoked grant) would otherwise paper the screen with the same message. */
const MAX = 4;

interface ToastState {
  toasts: Toast[];
  /** Raise a notice. Returns its id so a caller can dismiss it early. */
  push: (kind: ToastKind, message: string) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = crypto.randomUUID();
    set((s) => {
      // Collapse an identical message already on screen rather than stacking
      // duplicates: one failing gesture often produces several writes, and the
      // user learns nothing from the third copy.
      const dup = s.toasts.find(
        (t) => t.message === message && t.kind === kind
      );
      if (dup) return s;
      return { toasts: [...s.toasts, { id, kind, message }].slice(-MAX) };
    });
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TTL_MS[kind]);
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Raise a toast from outside React (the mesh write helpers). */
export const pushToast = (kind: ToastKind, message: string): string =>
  useToastStore.getState().push(kind, message);
