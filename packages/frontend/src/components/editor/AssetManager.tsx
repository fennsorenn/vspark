import { useState, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { AssetFile } from '../../api/client';
import type { NodeComponent } from '../../store/editorStore';
import { newComponentId, CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { TrackClipTimeline } from './TrackClipTimeline';

export function AssetManager() {
  const {
    assets,
    addAsset,
    deleteAsset,
    activeSceneId,
    addNode,
    projectId,
    selectedNodeId,
    nodes,
    updateNode: storeUpdateNode,
    addNodeComponent,
    nodeComponents,
    componentKinds,
    cameraEffects,
    addCameraEffect,
  } = useEditorStore();
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const canApplyAnim =
    selectedNode?.kind === 'avatar' || selectedNode?.kind === 'model';
  const canApplyTexture =
    selectedNode?.kind === 'billboard' || selectedNode?.kind === 'particle';
  const canApplyCameraBg = selectedNode?.kind === 'camera';
  const tab = useEditorStore((s) => s.bottomTab);
  const setTab = useEditorStore((s) => s.setBottomTab);
  const bottomDockHeight = useEditorStore((s) => s.bottomDockHeight);
  const [uploading, setUploading] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const animInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const models = assets.filter((a) => a.kind === 'model');
  const animations = assets.filter((a) => a.kind === 'animation');
  const images = assets.filter((a) => a.kind === 'image');

  const handleUpload = async (file: File) => {
    if (!projectId) {
      alert('No project loaded.');
      return;
    }
    setUploading(true);
    try {
      const asset = await api.uploadAsset(projectId, file);
      addAsset(asset);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleAddToScene = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert('No active scene. Select or create a scene first.');
      return;
    }
    const ext = asset.name.split('.').pop()?.toLowerCase();
    const nodeKind = ext === 'vrm' ? 'avatar' : 'model';
    try {
      const node = await api.createNode(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: nodeKind,
        filePath: asset.url,
        components: {
          transform: {
            type: 'transform',
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,
            sx: 1,
            sy: 1,
            sz: 1,
          },
        },
      });
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to add to scene');
    }
  };

  const handleAddAsBillboard = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert('No active scene.');
      return;
    }
    try {
      const node = await api.createNode(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: 'billboard',
        filePath: asset.url,
        components: {
          transform: {
            type: 'transform',
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,
            sx: 1,
            sy: 1,
            sz: 1,
          },
          billboard: {
            facing: 'screen',
            backface: 'none',
            width: 1,
            height: 1,
            alpha: 1,
            textureUrl: asset.url,
          },
        },
      });
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to add billboard');
    }
  };

  const handleApplyTexture = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const key = selectedNode.kind === 'particle' ? 'particle' : 'billboard';
    const existing = (selectedNode.components?.[key] ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      [key]: { ...existing, textureUrl: asset.url },
    };
    try {
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to apply texture');
    }
  };

  const handleApplyCameraBg = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const existing = (selectedNode.components?.camera ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      camera: { ...existing, backgroundImage: asset.url },
    };
    try {
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to set camera background');
    }
  };

  const handleApplyAnimation = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const components = {
      ...selectedNode.components,
      animation: { idleUrl: asset.url },
    };
    try {
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to apply animation');
    }
  };

  const handleDelete = async (asset: AssetFile) => {
    try {
      await api.deleteAsset(asset.id);
      deleteAsset(asset.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleAddComponent = async (kind: string) => {
    if (!selectedNode) return;
    const ct = componentKinds.find((c) => c.kind === kind);
    if (!ct) return;
    const comp: NodeComponent = {
      id: newComponentId(),
      nodeId: selectedNode.id,
      kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    };
    addNodeComponent(comp);
    try {
      await api.createNodeComponent(selectedNode.id, comp);
    } catch {
      /* non-fatal */
    }
  };

  const handleAddEffect = async (kind: string) => {
    if (!selectedNode || selectedNode.kind !== 'camera') return;
    const ek = CAMERA_EFFECT_KINDS.find((k) => k.kind === kind);
    if (!ek) return;
    const effect = {
      id: newComponentId(),
      nodeId: selectedNode.id,
      kind,
      enabled: true,
      config: { ...ek.defaultConfig },
    };
    addCameraEffect(effect);
    try {
      await api.createCameraEffect(selectedNode.id, effect);
    } catch {
      /* non-fatal */
    }
  };

  const tabBtn = (
    t: 'models' | 'animations' | 'images' | 'components' | 'effects' | 'clips'
  ): React.CSSProperties => ({
    background: tab === t ? '#2a2a2a' : 'none',
    border: 'none',
    borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
    color: tab === t ? '#e0e0e0' : '#666',
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
  });

  const uploadBtn: React.CSSProperties = {
    background: uploading ? '#1a3a5a' : '#2563eb',
    border: 'none',
    color: '#fff',
    borderRadius: 5,
    padding: '4px 12px',
    cursor: uploading ? 'not-allowed' : 'pointer',
    fontSize: 12,
    fontWeight: 500,
    flexShrink: 0,
  };

  return (
    <div
      style={{
        height: bottomDockHeight,
        flexShrink: 0,
        background: '#141414',
        borderTop: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
      }}
    >
      <BottomDockResizeHandle />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #2a2a2a',
          padding: '0 12px',
          gap: 4,
          flexShrink: 0,
        }}
      >
        <button style={tabBtn('models')} onClick={() => setTab('models')}>
          Models
        </button>
        <button
          style={tabBtn('animations')}
          onClick={() => setTab('animations')}
        >
          Animations
        </button>
        <button style={tabBtn('images')} onClick={() => setTab('images')}>
          Images
        </button>
        <button
          style={tabBtn('components')}
          onClick={() => setTab('components')}
        >
          Components
        </button>
        <button style={tabBtn('effects')} onClick={() => setTab('effects')}>
          Effects
        </button>
        <button style={tabBtn('clips')} onClick={() => setTab('clips')}>
          Clips
        </button>
        <div style={{ flex: 1 }} />
        {tab === 'components' ||
        tab === 'effects' ||
        tab === 'clips' ? null : tab === 'models' ? (
          <>
            <button
              style={uploadBtn}
              disabled={uploading}
              onClick={() => modelInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload Model'}
            </button>
            <input
              ref={modelInputRef}
              type="file"
              accept=".vrm,.glb,.gltf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'animations' ? (
          <>
            <button
              style={uploadBtn}
              disabled={uploading}
              onClick={() => animInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload Animation'}
            </button>
            <input
              ref={animInputRef}
              type="file"
              accept=".fbx,.bvh"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'images' ? (
          <>
            <button
              style={uploadBtn}
              disabled={uploading}
              onClick={() => imageInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload Image'}
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.gif,.avif"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : null}
      </div>

      {tab === 'clips' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <TrackClipTimeline />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {/* Components tab */}
          {tab === 'components' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!selectedNode && (
                <div
                  style={{
                    color: '#555',
                    fontSize: 12,
                    textAlign: 'center',
                    paddingTop: 12,
                  }}
                >
                  Select a node in the scene to add components.
                </div>
              )}
              {selectedNode &&
                componentKinds.map((ct) => {
                  const alreadyAdded = nodeComponents.some(
                    (c) => c.nodeId === selectedNode.id && c.kind === ct.kind
                  );
                  return (
                    <div
                      key={ct.kind}
                      style={{
                        background: '#1e1e1e',
                        border: '1px solid #2a2a2a',
                        borderRadius: 6,
                        padding: '10px 12px',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                      }}
                    >
                      <span
                        style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}
                      >
                        {ct.icon}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: '#e0e0e0',
                            marginBottom: 3,
                          }}
                        >
                          {ct.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: '#666',
                            lineHeight: 1.4,
                          }}
                        >
                          {ct.description}
                        </div>
                      </div>
                      <button
                        style={{
                          background: alreadyAdded ? '#1a2a1a' : '#1a3a1a',
                          border: 'none',
                          color: alreadyAdded ? '#4a7' : '#5b9',
                          borderRadius: 4,
                          padding: '3px 10px',
                          cursor: alreadyAdded ? 'default' : 'pointer',
                          fontSize: 11,
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                        disabled={alreadyAdded}
                        onClick={() => handleAddComponent(ct.kind)}
                        title={
                          alreadyAdded
                            ? 'Already added'
                            : `Add to ${selectedNode.name}`
                        }
                      >
                        {alreadyAdded ? '✓ Added' : '+ Add'}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Effects tab */}
          {tab === 'effects' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(!selectedNode || selectedNode.kind !== 'camera') && (
                <div
                  style={{
                    color: '#555',
                    fontSize: 12,
                    textAlign: 'center',
                    paddingTop: 12,
                  }}
                >
                  Select a camera node to add effects.
                </div>
              )}
              {selectedNode &&
                selectedNode.kind === 'camera' &&
                CAMERA_EFFECT_KINDS.map((ek) => {
                  const alreadyAdded = cameraEffects.some(
                    (e) => e.nodeId === selectedNode.id && e.kind === ek.kind
                  );
                  return (
                    <div
                      key={ek.kind}
                      style={{
                        background: '#1e1e1e',
                        border: '1px solid #2a2a2a',
                        borderRadius: 6,
                        padding: '10px 12px',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                      }}
                    >
                      <span
                        style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}
                      >
                        {ek.icon}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: '#e0e0e0',
                            marginBottom: 3,
                          }}
                        >
                          {ek.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: '#666',
                            lineHeight: 1.4,
                          }}
                        >
                          {ek.description}
                        </div>
                      </div>
                      <button
                        style={{
                          background: alreadyAdded ? '#1a2a1a' : '#1a3a1a',
                          border: 'none',
                          color: alreadyAdded ? '#4a7' : '#5b9',
                          borderRadius: 4,
                          padding: '3px 10px',
                          cursor: alreadyAdded ? 'default' : 'pointer',
                          fontSize: 11,
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                        disabled={alreadyAdded}
                        onClick={() => handleAddEffect(ek.kind)}
                        title={
                          alreadyAdded
                            ? 'Already added'
                            : `Add to ${selectedNode.name}`
                        }
                      >
                        {alreadyAdded ? '✓ Added' : '+ Add'}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Models / Animations / Images tabs */}
          {(tab === 'models' || tab === 'animations' || tab === 'images') &&
            (() => {
              const list =
                tab === 'models'
                  ? models
                  : tab === 'animations'
                    ? animations
                    : images;
              if (list.length === 0)
                return (
                  <div
                    style={{
                      color: '#555',
                      fontSize: 12,
                      textAlign: 'center',
                      paddingTop: 20,
                    }}
                  >
                    No {tab} yet. Upload one above.
                  </div>
                );
              const cardStyle: React.CSSProperties = {
                background: '#1e1e1e',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 140,
                maxWidth: 200,
              };
              const extBadge: React.CSSProperties = {
                display: 'inline-block',
                background: '#2a2a2a',
                borderRadius: 3,
                padding: '1px 6px',
                fontSize: 10,
                color: '#888',
                alignSelf: 'flex-start',
              };
              return (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {list.map((asset) => (
                    <div key={asset.id} style={cardStyle}>
                      {/* Thumbnail for images */}
                      {asset.kind === 'image' && (
                        <img
                          src={asset.url}
                          alt={asset.name}
                          style={{
                            width: '100%',
                            height: 80,
                            objectFit: 'contain',
                            borderRadius: 3,
                            background: '#111',
                          }}
                        />
                      )}
                      <div
                        style={{
                          fontSize: 13,
                          color: '#e0e0e0',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {asset.name}
                      </div>
                      <div style={extBadge}>
                        {asset.name.split('.').pop()?.toUpperCase()}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          marginTop: 2,
                          flexWrap: 'wrap',
                        }}
                      >
                        {asset.kind === 'model' && (
                          <button
                            style={{
                              background: '#1a3a5a',
                              border: 'none',
                              color: '#7ab',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            onClick={() => handleAddToScene(asset)}
                          >
                            Add to Scene
                          </button>
                        )}
                        {asset.kind === 'animation' && canApplyAnim && (
                          <button
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={`Apply to "${selectedNode!.name}"`}
                            onClick={() => handleApplyAnimation(asset)}
                          >
                            Apply to {selectedNode!.name}
                          </button>
                        )}
                        {asset.kind === 'animation' && !canApplyAnim && (
                          <span
                            style={{
                              fontSize: 10,
                              color: '#555',
                              alignSelf: 'center',
                            }}
                          >
                            Select an avatar first
                          </span>
                        )}
                        {asset.kind === 'image' && (
                          <button
                            style={{
                              background: '#1a2a4a',
                              border: 'none',
                              color: '#78b',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            onClick={() => handleAddAsBillboard(asset)}
                          >
                            Add as Billboard
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyTexture && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={`Apply texture to "${selectedNode!.name}"`}
                            onClick={() => handleApplyTexture(asset)}
                          >
                            Apply to {selectedNode!.name}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyCameraBg && (
                          <button
                            style={{
                              background: '#1a2a1a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={`Set as background for "${selectedNode!.name}"`}
                            onClick={() => handleApplyCameraBg(asset)}
                          >
                            Set as BG
                          </button>
                        )}
                        {asset.kind === 'image' &&
                          !canApplyTexture &&
                          !canApplyCameraBg &&
                          selectedNode && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#555',
                                alignSelf: 'center',
                              }}
                            >
                              Select billboard/particle/camera
                            </span>
                          )}
                        <button
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#666',
                            cursor: 'pointer',
                            fontSize: 14,
                            padding: '0 2px',
                          }}
                          onClick={() => handleDelete(asset)}
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}

/** 4px hit-strip along the top edge of the bottom dock. Dragging up enlarges
 *  the dock; the height is clamped in the store action. Highlights on hover so
 *  the user can find it. */
export function BottomDockResizeHandle() {
  const setBottomDockHeight = useEditorStore((s) => s.setBottomDockHeight);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = useEditorStore.getState().bottomDockHeight;
    const onMove = (me: PointerEvent) => {
      setBottomDockHeight(startH + (startY - me.clientY));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      style={{
        position: 'absolute',
        top: -2,
        left: 0,
        right: 0,
        height: 6,
        cursor: 'ns-resize',
        zIndex: 10,
      }}
    />
  );
}
