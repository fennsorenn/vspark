/**
 * useMacros — the Macros panel's data layer.
 *
 * Reads every project-scoped logic graph, projects their descriptors into macro
 * rows (so macros authored on the canvas show up too), and exposes CRUD that
 * writes back through the same descriptors (api.updateLogic). New macros land in
 * a single auto-created "Macros" logic graph; per-macro enable rides the hotkey
 * node's `enabled` config gate. See dev-notes/plans/macro-ui.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { api, type LogicRecord } from '../../../api/client';
import { projectMacros } from './projection';
import { assembleSingleMacro, buildHotkeyNode } from './build';
import {
  insertSubgraph,
  patchNodeConfig,
  removeMacro,
  setSingleAction,
} from './edit';
import type { HotkeyCombo, MacroActionInstance, MacroRow } from './types';

const MACROS_GRAPH_NAME = 'Macros';

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

function emptyDescriptor(id: string): GraphDescriptor {
  return { id, label: MACROS_GRAPH_NAME, readonly: false, nodes: [], edges: [] };
}

function descriptorOf(rec: LogicRecord): GraphDescriptor {
  return rec.descriptor ?? emptyDescriptor(rec.id);
}

export interface UseMacros {
  rows: MacroRow[];
  loading: boolean;
  addMacro: (shortcut: HotkeyCombo, action: MacroActionInstance | null) => Promise<void>;
  setShortcut: (row: MacroRow, shortcut: HotkeyCombo) => Promise<void>;
  setEnabled: (row: MacroRow, enabled: boolean) => Promise<void>;
  setAction: (row: MacroRow, action: MacroActionInstance | null) => Promise<void>;
  removeRow: (row: MacroRow) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useMacros(projectId: string | undefined): UseMacros {
  const [logics, setLogics] = useState<LogicRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const logicsRef = useRef<LogicRecord[]>([]);
  logicsRef.current = logics;
  // Suppress the background poll while our own write is in flight so it can't
  // clobber the optimistic descriptor with a pre-write server snapshot.
  const writing = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await api.getProjectLogic(projectId);
      if (writing.current === 0) setLogics(list);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const rows = useMemo(
    () =>
      projectMacros(
        logics.map((l) => ({ logicId: l.id, descriptor: descriptorOf(l) }))
      ),
    [logics]
  );

  const persist = useCallback(
    async (logicId: string, next: GraphDescriptor) => {
      writing.current += 1;
      setLogics((ls) =>
        ls.map((l) => (l.id === logicId ? { ...l, descriptor: next } : l))
      );
      try {
        await api.updateLogic(logicId, { descriptor: next });
      } finally {
        writing.current -= 1;
      }
    },
    []
  );

  const mutate = useCallback(
    (logicId: string, fn: (d: GraphDescriptor) => GraphDescriptor) => {
      const rec = logicsRef.current.find((l) => l.id === logicId);
      if (!rec) return Promise.resolve();
      return persist(logicId, fn(descriptorOf(rec)));
    },
    [persist]
  );

  const ensureMacrosGraph = useCallback(async (): Promise<LogicRecord> => {
    const existing = logicsRef.current.find((l) => l.name === MACROS_GRAPH_NAME);
    if (existing) return existing;
    const created = await api.createProjectLogic(projectId!, MACROS_GRAPH_NAME);
    setLogics((ls) => [...ls, created]);
    return created;
  }, [projectId]);

  const addMacro = useCallback(
    async (shortcut: HotkeyCombo, action: MacroActionInstance | null) => {
      if (!projectId) return;
      const graph = await ensureMacrosGraph();
      const sub = action
        ? assembleSingleMacro(shortcut, action, newId)
        : { nodes: [buildHotkeyNode(shortcut, newId)], edges: [] };
      await persist(graph.id, insertSubgraph(descriptorOf(graph), sub));
    },
    [projectId, ensureMacrosGraph, persist]
  );

  const setShortcut = useCallback(
    (row: MacroRow, shortcut: HotkeyCombo) =>
      mutate(row.logicId, (d) =>
        patchNodeConfig(d, row.hotkeyNodeId, {
          key: shortcut.key,
          ctrl: shortcut.ctrl,
          shift: shortcut.shift,
          alt: shortcut.alt,
          meta: shortcut.meta,
        })
      ),
    [mutate]
  );

  const setEnabled = useCallback(
    (row: MacroRow, enabled: boolean) =>
      mutate(row.logicId, (d) =>
        patchNodeConfig(d, row.hotkeyNodeId, { enabled })
      ),
    [mutate]
  );

  const setAction = useCallback(
    (row: MacroRow, action: MacroActionInstance | null) =>
      mutate(row.logicId, (d) =>
        setSingleAction(d, row.hotkeyNodeId, action, newId)
      ),
    [mutate]
  );

  const removeRow = useCallback(
    (row: MacroRow) => mutate(row.logicId, (d) => removeMacro(d, row.hotkeyNodeId)),
    [mutate]
  );

  return {
    rows,
    loading,
    addMacro,
    setShortcut,
    setEnabled,
    setAction,
    removeRow,
    refresh,
  };
}
