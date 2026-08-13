import { create } from 'zustand';
import type { AssistantAttachment } from '@vspark/shared';

/**
 * Standalone store for the in-app Assistant chat window (mirrors helpStore's
 * self-contained pattern). The transcript is a flat list of entries: user
 * turns, assistant text, and tool-call activity. Fed by the WS handlers in
 * useWsSync; read by AssistantWindow.
 */
export type AssistantEntryKind = 'user' | 'assistant' | 'tool' | 'error';

export interface AssistantEntry {
  id: string;
  kind: AssistantEntryKind;
  /** Text for user/assistant/error entries. */
  text?: string;
  /** Tool entry fields. */
  toolName?: string;
  args?: unknown;
  ok?: boolean;
  result?: string;
}

interface AssistantState {
  open: boolean;
  streaming: boolean;
  entries: AssistantEntry[];
  /** Whether the backend reports an assistant LLM endpoint is configured. */
  available: boolean | null;
  /** Attach-picker mode: the editor dims and attachable elements light up. */
  attachMode: boolean;
  /** Elements the user attached to the next message. */
  attachments: AssistantAttachment[];

  openAssistant: () => void;
  closeAssistant: () => void;
  toggleAssistant: () => void;
  setAvailable: (v: boolean) => void;
  setAttachMode: (v: boolean) => void;
  addAttachment: (a: AssistantAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  pushUser: (text: string) => void;
  pushAssistantText: (text: string) => void;
  pushToolCall: (c: { id: string; name: string; args: unknown }) => void;
  resolveToolResult: (r: { id: string; ok: boolean; text: string }) => void;
  pushError: (message: string) => void;
  setStreaming: (v: boolean) => void;
  clear: () => void;
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  streaming: false,
  entries: [],
  available: null,
  attachMode: false,
  attachments: [],

  openAssistant: () => set({ open: true }),
  closeAssistant: () => set({ open: false, attachMode: false }),
  toggleAssistant: () => set((s) => ({ open: !s.open })),
  setAvailable: (v) => set({ available: v }),
  setAttachMode: (v) => set({ attachMode: v }),
  addAttachment: (a) =>
    set((s) =>
      s.attachments.some((x) => x.id === a.id && x.kind === a.kind)
        ? s
        : { attachments: [...s.attachments, a] }
    ),
  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),

  pushUser: (text) =>
    set((s) => ({
      entries: [...s.entries, { id: uid(), kind: 'user', text }],
      streaming: true,
    })),
  pushAssistantText: (text) =>
    set((s) => ({
      entries: [...s.entries, { id: uid(), kind: 'assistant', text }],
    })),
  pushToolCall: (c) =>
    set((s) => ({
      entries: [
        ...s.entries,
        { id: c.id, kind: 'tool', toolName: c.name, args: c.args },
      ],
    })),
  resolveToolResult: (r) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === r.id && e.kind === 'tool'
          ? { ...e, ok: r.ok, result: r.text }
          : e
      ),
    })),
  pushError: (message) =>
    set((s) => ({
      entries: [...s.entries, { id: uid(), kind: 'error', text: message }],
    })),
  setStreaming: (v) => set({ streaming: v }),
  clear: () => set({ entries: [] }),
}));
