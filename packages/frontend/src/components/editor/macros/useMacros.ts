/**
 * useMacros — the Macros panel's data layer.
 *
 * Reads every project-scoped logic graph from the mesh replica, projects their
 * descriptors into macro rows (so macros authored on the canvas show up too),
 * and exposes CRUD that writes back through the same descriptors on the mesh
 * (mesh/logicWrites — only the nodes and edges an edit changes, as one undo
 * action). New macros land in a single auto-created "Macros" logic graph;
 * per-macro enable rides the hotkey node's `enabled` config gate. See
 * dev-notes/plans/macro-ui.md.
 */

import { useCallback, useMemo } from 'react';
import type { GraphDescriptor } from '@vspark/shared/signal';
import type { LogicRecord } from '../../../api/client';
import { useLogicRecords } from '../../../mesh/hooks';
import {
  commitGraphDiff,
  commitLogicCreate,
  logicFor,
} from '../../../mesh/logicWrites';
import { projectMacros } from './projection';
import { assembleSingleMacro, buildHotkeyNode } from './build';
import {
  insertSubgraph,
  patchNodeConfig,
  removeMacro,
  setSingleAction,
} from './edit';
import type { HotkeyCombo, MacroActionInstance, MacroRow } from './types';
import { randomUUID } from '@vspark/shared/sync';

const MACROS_GRAPH_NAME = 'Macros';

function newId(): string {
  return randomUUID();
}

function emptyDescriptor(id: string): GraphDescriptor {
  return {
    id,
    label: MACROS_GRAPH_NAME,
    readonly: false,
    nodes: [],
    edges: [],
  };
}

function descriptorOf(rec: LogicRecord): GraphDescriptor {
  return rec.descriptor ?? emptyDescriptor(rec.id);
}

export interface UseMacros {
  rows: MacroRow[];
  /** The replica is loaded before the editor renders, so this is always false;
   *  kept so the panel's empty state reads the same. */
  loading: boolean;
  addMacro: (
    shortcut: HotkeyCombo,
    action: MacroActionInstance | null
  ) => Promise<void>;
  setShortcut: (row: MacroRow, shortcut: HotkeyCombo) => Promise<void>;
  setEnabled: (row: MacroRow, enabled: boolean) => Promise<void>;
  setAction: (
    row: MacroRow,
    action: MacroActionInstance | null
  ) => Promise<void>;
  removeRow: (row: MacroRow) => Promise<void>;
}

export function useMacros(projectId: string | undefined): UseMacros {
  const all = useLogicRecords();
  const logics = useMemo(
    () =>
      Object.values(all)
        .filter((l) => l.ownerKind === 'project' && l.ownerId === projectId)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')),
    [all, projectId]
  );

  const rows = useMemo(
    () =>
      projectMacros(
        logics.map((l) => ({ logicId: l.id, descriptor: descriptorOf(l) }))
      ),
    [logics]
  );

  /** Apply a whole-descriptor transform, writing only what it changed. Reads the
   *  graph fresh from the replica so a stale render can't undo a newer edit. */
  const mutate = useCallback(
    async (logicId: string, fn: (d: GraphDescriptor) => GraphDescriptor) => {
      if (!projectId) return;
      const rec = logicFor({ kind: 'project', id: projectId }).find(
        (l) => l.id === logicId
      );
      if (!rec) return;
      const before = descriptorOf(rec);
      commitGraphDiff(logicId, before, fn(before));
    },
    [projectId]
  );

  const addMacro = useCallback(
    async (shortcut: HotkeyCombo, action: MacroActionInstance | null) => {
      if (!projectId) return;
      const sub = action
        ? assembleSingleMacro(shortcut, action, newId)
        : { nodes: [buildHotkeyNode(shortcut, newId)], edges: [] };
      const existing = logicFor({ kind: 'project', id: projectId }).find(
        (l) => l.name === MACROS_GRAPH_NAME
      );
      if (existing) {
        await mutate(existing.id, (d) => insertSubgraph(d, sub));
        return;
      }
      // First macro: create the graph with it in place — one committed write.
      const id = newId();
      await commitLogicCreate(
        { kind: 'project', id: projectId },
        MACROS_GRAPH_NAME,
        insertSubgraph(emptyDescriptor(id), sub)
      );
    },
    [projectId, mutate]
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
    (row: MacroRow) =>
      mutate(row.logicId, (d) => removeMacro(d, row.hotkeyNodeId)),
    [mutate]
  );

  return {
    rows,
    loading: false,
    addMacro,
    setShortcut,
    setEnabled,
    setAction,
    removeRow,
  };
}
