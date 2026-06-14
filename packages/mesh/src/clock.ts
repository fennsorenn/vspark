/**
 * Hybrid logical clock with remote-stamp merge.
 *
 * Extends the single-node monotonic clock from @vspark/shared/sync with
 * `observe()`: folding every received remote stamp in guarantees that stamps
 * minted here order after everything this peer has already seen, even when
 * wall clocks disagree between peers.
 */
import type { HLC } from '@vspark/shared/sync';

export class HlcClock {
  private lastT = 0;
  private lastC = 0;

  constructor(readonly peerId: string) {}

  /** Fold a remote stamp in so subsequent local stamps order after it. */
  observe(v: HLC): void {
    if (v.t > this.lastT) {
      this.lastT = v.t;
      this.lastC = v.c;
    } else if (v.t === this.lastT && v.c > this.lastC) {
      this.lastC = v.c;
    }
  }

  /** Mint a stamp strictly greater than every stamp minted or observed. */
  tick(): HLC {
    const now = Date.now();
    if (now > this.lastT) {
      this.lastT = now;
      this.lastC = 0;
    } else {
      this.lastC += 1;
    }
    return { t: this.lastT, c: this.lastC, n: this.peerId };
  }
}
