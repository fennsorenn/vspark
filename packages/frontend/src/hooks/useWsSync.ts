import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import type { NodeRecord } from '../store/editorStore'
import type { CameraEffectRecord } from '../api/client'
import { setVmcPose, setVmcBlendshapes } from '../vmcPoseStore'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
const RECONNECT_MS = 3000

export function useWsSync() {
  const setVmcStatus   = useEditorStore((s) => s.setVmcStatus)
  const setVmcTracking = useEditorStore((s) => s.setVmcTracking)
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingReloadRef = useRef<boolean>(false)

  useEffect(() => {
    let dead = false

    const connect = () => {
      if (dead) return
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        if (pendingReloadRef.current) {
          pendingReloadRef.current = false
          useEditorStore.getState().setPendingReload(false)
          window.location.reload()
        }
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { kind: string; payload: Record<string, unknown> }
          if (msg.kind === 'vmc_status') {
            setVmcStatus(msg.payload.componentId as string, msg.payload.connected as boolean)
          } else if (msg.kind === 'vmc_tracking_state') {
            setVmcTracking(msg.payload.componentId as string, msg.payload.tracking as boolean)
          } else if (msg.kind === 'vmc_pose') {
            setVmcPose(msg.payload.nodeId as string, msg.payload.bones as Record<string, [number, number, number, number]>)
          } else if (msg.kind === 'vmc_blendshapes') {
            setVmcBlendshapes(msg.payload.nodeId as string, msg.payload.blendshapes as Record<string, number>)
          } else if (msg.kind === 'node_updated') {
            const { id, ...updates } = msg.payload as { id: string } & Record<string, unknown>
            useEditorStore.getState().updateNode(id, updates)
          } else if (msg.kind === 'node_added') {
            const store = useEditorStore.getState()
            const node = msg.payload as unknown as NodeRecord
            // Only add if we have this scene loaded; avoid duplicates
            if (store.nodes.every((n) => n.id !== node.id)) {
              store.addNode(node)
            }
          } else if (msg.kind === 'node_removed') {
            useEditorStore.getState().deleteNode(msg.payload.id as string)
          } else if (msg.kind === 'camera_effect_added') {
            const p = msg.payload as Record<string, unknown>
            const effect: CameraEffectRecord = {
              id: p.id as string,
              nodeId: (p.node_id ?? p.nodeId) as string,
              kind: p.kind as string,
              enabled: Boolean(p.enabled),
              config: typeof p.config === 'string' ? JSON.parse(p.config) : (p.config as Record<string, unknown> ?? {}),
            }
            const store = useEditorStore.getState()
            if (store.cameraEffects.every((e) => e.id !== effect.id)) store.addCameraEffect(effect)
          } else if (msg.kind === 'camera_effect_updated') {
            const p = msg.payload as { id: string; enabled?: boolean; config?: Record<string, unknown> }
            useEditorStore.getState().updateCameraEffect(p.id, {
              ...(p.enabled != null ? { enabled: p.enabled } : {}),
              ...(p.config != null ? { config: p.config } : {}),
            })
          } else if (msg.kind === 'camera_effect_removed') {
            useEditorStore.getState().removeCameraEffect(msg.payload.id as string)
          } else if (msg.kind === 'server_update') {
            if ((msg.payload as { reloadOnReconnect?: boolean }).reloadOnReconnect) {
              pendingReloadRef.current = true
              useEditorStore.getState().setPendingReload(true)
            }
          }
        } catch { /* ignore malformed */ }
      }

      ws.onclose = () => {
        if (!dead) timerRef.current = setTimeout(connect, RECONNECT_MS)
      }
    }

    connect()
    return () => {
      dead = true
      if (timerRef.current) clearTimeout(timerRef.current)
      wsRef.current?.close()
    }
  }, [setVmcStatus, setVmcTracking])
}
