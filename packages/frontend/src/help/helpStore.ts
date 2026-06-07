import { create } from 'zustand';

/**
 * Global state for the in-app help window. Kept separate from the editor store
 * so the help system is self-contained and usable from any page.
 */
interface HelpState {
  open: boolean;
  topic: string | null;
  anchor: string | null;
  /** Open the floating help window on a topic, optionally scrolled to an anchor. */
  openHelp: (topic: string, anchor?: string | null) => void;
  /** Navigate the already-open window to a different topic/anchor. */
  goTo: (topic: string, anchor?: string | null) => void;
  closeHelp: () => void;
}

export const useHelpStore = create<HelpState>((set) => ({
  open: false,
  topic: null,
  anchor: null,
  openHelp: (topic, anchor = null) => set({ open: true, topic, anchor }),
  goTo: (topic, anchor = null) => set({ topic, anchor }),
  closeHelp: () => set({ open: false }),
}));
