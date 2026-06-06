import { useState, useRef, useEffect } from 'react';
import { useEditorStore, type PresetSummary } from '../../store/editorStore';
import {
  getPresets,
  createPreset,
  deletePreset,
  getPreset,
  getBuiltinPresets,
  getBuiltinPreset,
  serializePreset,
  instantiatePreset,
  type BuiltinPresetSummary,
} from '../../api/client';

export function PresetLibrary() {
  const projectId = useEditorStore((s) => s.projectId);
  const activeSceneId = useEditorStore((s) => s.activeSceneId);
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );
  const presets = useEditorStore((s) => s.presets);
  const setPresets = useEditorStore((s) => s.setPresets);
  const addPreset = useEditorStore((s) => s.addPreset);
  const removePreset = useEditorStore((s) => s.removePreset);
  const [saving, setSaving] = useState(false);
  const [instantiating, setInstantiating] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [embedAssets, setEmbedAssets] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [builtins, setBuiltins] = useState<BuiltinPresetSummary[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Built-in presets are shipped with the app and don't depend on the project.
  useEffect(() => {
    getBuiltinPresets()
      .then(setBuiltins)
      .catch(() => {});
  }, []);

  const handleInstantiateBuiltin = async (id: string) => {
    setInstantiating(id);
    try {
      const data = await getBuiltinPreset(id);
      await instantiatePayload(data.payload);
    } catch (e) {
      console.error('Failed to instantiate builtin preset:', e);
    } finally {
      setInstantiating(null);
    }
  };

  const loadPresets = async () => {
    if (!projectId) return;
    try {
      const list = await getPresets(projectId);
      setPresets(list);
    } catch {
      /* ignore */
    }
  };

  /** Instantiate a preset payload, routing it to the 3D scene or the compose
   *  scene depending on the preset's rootKind, then reload affected state. */
  const instantiatePayload = async (
    rawPayload: unknown
  ): Promise<{ missingAssets: string[] } | null> => {
    if (!projectId) return null;
    const payload = rawPayload as { format?: string; rootKind?: string };
    if (
      payload.format !== 'vspark.preset.v1' &&
      payload.format !== 'vspark.preset.v2'
    )
      return null;
    const isCompose = payload.rootKind === 'compose_layer';
    if (isCompose) {
      if (!activeComposeSceneId) return null;
      // Only nest under the selected layer if it actually lives in the active
      // compose scene; otherwise the new layer would get a parent from another
      // scene and never render (orphaned in the tree). Fall back to a root layer.
      const selected = selectedComposeLayerId
        ? useEditorStore
            .getState()
            .composeLayers.find((l) => l.id === selectedComposeLayerId)
        : null;
      const parentId =
        selected && selected.rootComposeSceneId === activeComposeSceneId
          ? selectedComposeLayerId
          : null;
      const result = await instantiatePreset(
        payload,
        projectId,
        // No 3D scene root for compose presets.
        '',
        activeComposeSceneId,
        parentId
      );
      const { api: apiClient } = await import('../../api/client');
      const data = await apiClient.getScenes(projectId);
      const store = useEditorStore.getState();
      store.setComposeScenes(
        data.composeLayers.filter((l) => l.kind === 'compose_scene')
      );
      store.setComposeLayers(
        data.composeLayers.filter((l) => l.kind !== 'compose_scene')
      );
      // Compose presets can carry track clips owned by their layers; refresh
      // them too so the pasted clips show up in the layer's Clips section.
      store.setTrackClips(data.trackClips);
      return result;
    }
    if (!activeSceneId) return null;
    const result = await instantiatePreset(
      payload,
      projectId,
      activeSceneId,
      null,
      selectedNodeId
    );
    const { api: apiClient } = await import('../../api/client');
    const data = await apiClient.getScenes(projectId);
    const store = useEditorStore.getState();
    store.setNodes(data.nodes);
    store.setBehaviors(data.behaviors);
    store.setCameraEffects(data.cameraEffects);
    store.setTrackClips(data.trackClips);
    return result;
  };

  const handleSave = async () => {
    if (!projectId || !name.trim()) return;
    const rootKind = selectedComposeLayerId ? 'compose_layer' : 'scene_node';
    const rootId = selectedComposeLayerId ?? selectedNodeId;
    if (!rootId) return;
    setSaving(true);
    try {
      const preset = await createPreset(projectId, {
        name: name.trim(),
        description: description.trim(),
        rootKind,
        rootId,
        embedAssets,
      });
      addPreset(preset as unknown as PresetSummary);
      setName('');
      setDescription('');
      setShowSaveForm(false);
    } catch (e) {
      console.error('Failed to save preset:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleInstantiate = async (presetId: string) => {
    if (!projectId) return;
    setInstantiating(presetId);
    try {
      const presetData = await getPreset(presetId);
      const result = await instantiatePayload(presetData.payload);
      if (result && result.missingAssets.length > 0) {
        console.warn('Missing assets:', result.missingAssets);
      }
    } catch (e) {
      console.error('Failed to instantiate preset:', e);
    } finally {
      setInstantiating(null);
    }
  };

  const handleDelete = async (presetId: string) => {
    try {
      await deletePreset(presetId);
      removePreset(presetId);
    } catch (e) {
      console.error('Failed to delete preset:', e);
    }
  };

  const handleExport = async (presetId: string) => {
    try {
      const presetData = await getPreset(presetId);
      const blob = new Blob([JSON.stringify(presetData.payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${presetData.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export preset:', e);
    }
  };

  const handleImport = async (file: File) => {
    if (!projectId) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await instantiatePayload(payload);
      if (!result) {
        console.error('Invalid or non-instantiable preset');
        return;
      }
      if (result.missingAssets.length > 0) {
        console.warn('Missing assets:', result.missingAssets);
      }
    } catch (e) {
      console.error('Failed to import preset:', e);
    }
  };

  const handleCopy = async () => {
    const rootKind = selectedComposeLayerId ? 'compose_layer' : 'scene_node';
    const rootId = selectedComposeLayerId ?? selectedNodeId;
    if (!rootId) return;
    try {
      const payload = await serializePreset(rootKind, rootId, false);
      await navigator.clipboard.writeText(JSON.stringify(payload));
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const handlePaste = async () => {
    if (!projectId) return;
    try {
      const text = await navigator.clipboard.readText();
      const payload = JSON.parse(text);
      await instantiatePayload(payload);
    } catch {
      /* not a preset on clipboard, ignore */
    }
  };

  const canSave = selectedNodeId || selectedComposeLayerId;

  const sectionHeader: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: '#888',
    padding: '6px 8px',
    letterSpacing: '0.5px',
    background: '#181818',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const btnStyle: React.CSSProperties = {
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    borderRadius: 3,
    color: '#ccc',
    fontSize: 11,
    padding: '3px 8px',
    cursor: 'pointer',
  };

  const groupLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: '2px 2px 6px',
  };

  const modalInput: React.CSSProperties = {
    background: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: 4,
    color: '#ccc',
    padding: '6px 8px',
    fontSize: 12,
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Actions bar */}
      <div style={sectionHeader}>
        <span>Preset Library</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            style={{ ...btnStyle, opacity: canSave ? 1 : 0.4 }}
            onClick={() => {
              if (!canSave) return;
              setShowSaveForm(true);
              loadPresets();
            }}
            disabled={!canSave}
            title={
              canSave
                ? 'Save the selected node/layer as a preset'
                : 'Select a node or layer first'
            }
          >
            Save
          </button>
          <button
            style={btnStyle}
            onClick={handleCopy}
            disabled={!canSave}
            title="Copy selected to clipboard"
          >
            Copy
          </button>
          <button
            style={btnStyle}
            onClick={handlePaste}
            title="Paste from clipboard"
          >
            Paste
          </button>
          <button
            style={btnStyle}
            onClick={() => fileInputRef.current?.click()}
            title="Import .json preset"
          >
            Import
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImport(f);
          e.target.value = '';
        }}
      />

      {/* Preset list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {/* Built-in (shipped, read-only) presets */}
        {builtins.length > 0 && (
          <>
            <div style={groupLabel}>Built-in</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {builtins.map((b) => {
                const target =
                  b.rootKind === 'compose_layer'
                    ? activeComposeSceneId
                    : activeSceneId;
                return (
                  <div
                    key={b.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: '1px solid #2a2a2a',
                      background: '#181818',
                      fontSize: 12,
                      color: '#ccc',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {b.rootKind === 'scene_node' ? '🧩' : '🎨'} {b.name}
                      </div>
                      {b.description && (
                        <div style={{ fontSize: 10, color: '#666' }}>
                          {b.description}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        style={{
                          ...btnStyle,
                          fontSize: 10,
                          padding: '2px 5px',
                          opacity: instantiating === b.id ? 0.5 : 1,
                        }}
                        onClick={() => handleInstantiateBuiltin(b.id)}
                        disabled={instantiating === b.id || !target}
                        title="Instantiate into the current scene"
                      >
                        Use
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={groupLabel}>Project</div>
          </>
        )}
        {presets.length === 0 && (
          <div
            style={{
              color: '#555',
              fontSize: 11,
              padding: 12,
              textAlign: 'center',
            }}
          >
            No presets saved yet.
            {canSave
              ? ' Select a node and save it as a preset.'
              : ' Select a node first.'}
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 8,
          }}
        >
          {presets.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #2a2a2a',
                background: '#1a1a1a',
                cursor: 'default',
                fontSize: 12,
                color: '#ccc',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.rootKind === 'scene_node' ? '🧩' : '🎨'} {p.name}
                </div>
                {p.description && (
                  <div
                    style={{
                      fontSize: 10,
                      color: '#666',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.description}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {(() => {
                  const target =
                    p.rootKind === 'compose_layer'
                      ? activeComposeSceneId
                      : activeSceneId;
                  return (
                    <button
                      style={{
                        ...btnStyle,
                        fontSize: 10,
                        padding: '2px 5px',
                        opacity: instantiating === p.id ? 0.5 : 1,
                      }}
                      onClick={() => handleInstantiate(p.id)}
                      disabled={instantiating === p.id || !target}
                      title={
                        p.rootKind === 'compose_layer'
                          ? 'Instantiate into current compose scene'
                          : 'Instantiate into current 3D scene'
                      }
                    >
                      Use
                    </button>
                  );
                })()}
                <button
                  style={{ ...btnStyle, fontSize: 10, padding: '2px 5px' }}
                  onClick={() => handleExport(p.id)}
                  title="Export as .json"
                >
                  Export
                </button>
                <button
                  style={{
                    ...btnStyle,
                    fontSize: 10,
                    padding: '2px 5px',
                    color: '#a55',
                  }}
                  onClick={() => handleDelete(p.id)}
                  title="Delete preset"
                >
                  Del
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Save-as-preset modal */}
      {showSaveForm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          onClick={() => !saving && setShowSaveForm(false)}
        >
          <div
            style={{
              width: 340,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 8,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: '#ddd' }}>
              Save as Preset
            </div>
            <input
              autoFocus
              placeholder="Preset name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !saving) handleSave();
                if (e.key === 'Escape') setShowSaveForm(false);
              }}
              style={modalInput}
            />
            <input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={modalInput}
            />
            <label
              style={{
                fontSize: 11,
                color: '#888',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={embedAssets}
                onChange={(e) => setEmbedAssets(e.target.checked)}
              />
              Embed assets (portable across projects)
            </label>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 6,
                marginTop: 4,
              }}
            >
              <button style={btnStyle} onClick={() => setShowSaveForm(false)}>
                Cancel
              </button>
              <button
                style={{
                  ...btnStyle,
                  background: '#2563eb',
                  border: '1px solid #2563eb',
                  color: '#fff',
                  opacity: saving || !name.trim() ? 0.5 : 1,
                }}
                onClick={handleSave}
                disabled={saving || !name.trim()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
