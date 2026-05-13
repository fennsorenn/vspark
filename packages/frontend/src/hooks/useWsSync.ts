import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import type { NodeRecord } from '../store/editorStore'
import { setVmcPose, setVmcBlendshapes } from '../vmcPoseStore'

const WS_URL = 'ws://localhost:3001/ws'
const RECONNECT_MS = 3000

export function useWsSync() {
  const setVmcStatus   = useEditorStore((s) => s.setVmcStatus)
  const setVmcTracking = useEditorStore((s) => s.setVmcTracking)
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let dead = false

    const connect = () => {
      if (dead) return
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

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
