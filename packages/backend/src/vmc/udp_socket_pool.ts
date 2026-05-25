import { createSocket, type Socket, type RemoteInfo } from 'dgram'

/**
 * Refcounted UDP socket pool. Lets multiple subscribers share one bound socket
 * per port — UDP doesn't fan packets out across multiple sockets bound to the
 * same port, so a shared receive socket is the only way two vmc_receiver
 * components can both react to a single VMC source.
 *
 * Subscribers receive *every* packet on the socket; per-subscriber processing
 * (tracking detection, calibration, pose publication, etc.) stays in the caller.
 *
 * The first subscriber binds the socket; the last unsubscribe closes it.
 */
export type UdpListener = (buf: Buffer, rinfo: RemoteInfo) => void

interface Entry {
  socket:    Socket
  listeners: Set<UdpListener>
}

export class UdpSocketPool {
  /** port → bound socket + listener set. host is fixed to 0.0.0.0 for now. */
  private readonly _entries = new Map<number, Entry>()

  /**
   * Subscribe to a UDP port. Returns an unsubscribe function. The first
   * subscriber on a given port binds; subsequent subscribers join an existing
   * socket and start receiving immediately.
   *
   * The `onBound` callback fires once the socket is actually bound (or right
   * away if it's already bound from a prior subscribe).
   */
  subscribe(
    port:     number,
    listener: UdpListener,
    onBound?: () => void,
  ): () => void {
    let entry = this._entries.get(port)
    if (!entry) {
      const socket = createSocket('udp4')
      entry = { socket, listeners: new Set() }
      this._entries.set(port, entry)

      socket.on('message', (buf, rinfo) => {
        // Snapshot in case a listener unsubscribes during dispatch.
        for (const l of [...entry!.listeners]) {
          try { l(buf, rinfo) } catch (err) {
            console.error(`[UdpSocketPool] listener on port ${port} threw:`, err)
          }
        }
      })
      socket.on('error', (err) => {
        console.error(`[UdpSocketPool] socket error on port ${port}:`, err.message)
      })
      socket.bind(port, '0.0.0.0', () => {
        console.log(`[UdpSocketPool] bound port ${port}`)
        // Fire onBound for the first subscriber after the socket is actually bound.
        onBound?.()
      })
      entry.listeners.add(listener)
    } else {
      entry.listeners.add(listener)
      // Already bound — fire immediately so callers don't have to special-case.
      onBound?.()
    }

    return () => this._unsubscribe(port, listener)
  }

  private _unsubscribe(port: number, listener: UdpListener): void {
    const entry = this._entries.get(port)
    if (!entry) return
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      this._entries.delete(port)
      try { entry.socket.close() } catch { /* already closed */ }
      console.log(`[UdpSocketPool] closed port ${port}`)
    }
  }

  /** Close all sockets (used at shutdown). */
  closeAll(): void {
    for (const [port, entry] of this._entries) {
      try { entry.socket.close() } catch { /* already closed */ }
      console.log(`[UdpSocketPool] closed port ${port} (shutdown)`)
    }
    this._entries.clear()
  }
}

/** Process-wide pool. There's no reason to have more than one. */
export const udpSocketPool = new UdpSocketPool()
