/**
 * Learned Tracking camera preview: which editor tabs watch which behavior's
 * runtime, and with what (picture, landmarks or both).
 *
 * A tab's preview window subscribes over /ws (`learned_preview` with
 * `behaviorId`, `image`, `landmarks`; both false unsubscribes) and repeats it
 * every few seconds, so a reconnected socket or a restarted backend picks it up
 * again. The runtime is asked for the union of what its subscribers want
 * (motiontracker's stdin `preview` command) and sends nothing while nobody
 * watches. Each frame goes only to the subscribed sockets
 * (`learned_preview_frame`), stripped to what each one asked for, not to every
 * tab: viewer pages and OBS sources are tabs too.
 */

export interface PreviewWanted {
  image: boolean;
  landmarks: boolean;
}

export const PREVIEW_OFF: PreviewWanted = { image: false, landmarks: false };

/** Subscriptions by behavior; K is the socket (generic for tests). */
export class PreviewHub<K> {
  private readonly subs = new Map<string, Map<K, PreviewWanted>>();

  /** Set one socket's subscription (both false drops it); returns what the
   *  behavior's runtime must now send. */
  set(behaviorId: string, sock: K, want: PreviewWanted): PreviewWanted {
    let m = this.subs.get(behaviorId);
    if (want.image || want.landmarks) {
      if (!m) this.subs.set(behaviorId, (m = new Map()));
      m.set(sock, { image: !!want.image, landmarks: !!want.landmarks });
    } else if (m) {
      m.delete(sock);
      if (m.size === 0) this.subs.delete(behaviorId);
    }
    return this.wanted(behaviorId);
  }

  /** Forget a closed socket; returns the behaviors it watched. */
  drop(sock: K): string[] {
    const hit: string[] = [];
    for (const [id, m] of this.subs) {
      if (!m.delete(sock)) continue;
      hit.push(id);
      if (m.size === 0) this.subs.delete(id);
    }
    return hit;
  }

  /** Union of the subscribers' wants. */
  wanted(behaviorId: string): PreviewWanted {
    const out = { ...PREVIEW_OFF };
    for (const w of this.subs.get(behaviorId)?.values() ?? []) {
      out.image ||= w.image;
      out.landmarks ||= w.landmarks;
    }
    return out;
  }

  /** The runtime's `preview` event, per subscriber with only what it asked for. */
  deliveries(
    behaviorId: string,
    ev: Record<string, unknown>
  ): Array<[K, Record<string, unknown>]> {
    const out: Array<[K, Record<string, unknown>]> = [];
    for (const [sock, w] of this.subs.get(behaviorId) ?? []) {
      const p: Record<string, unknown> = {
        behaviorId,
        t: ev.t,
        width: ev.width,
        height: ev.height,
        mirrored: ev.mirrored,
      };
      if (w.image && ev.image) p.image = ev.image;
      if (w.landmarks && ev.landmarks) p.landmarks = ev.landmarks;
      out.push([sock, p]);
    }
    return out;
  }
}
