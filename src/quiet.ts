/** Output spread over at least this long counts as "busy". */
export const BUSY_MS = 2000;

/**
 * Decides when a background tab has gone quiet: it was busy (a copy, a long
 * show, a reload) and then sent nothing for the quiet period. A lone line, such
 * as a syslog message or an echo, never makes a burst busy. Times are
 * milliseconds from one clock; the tab owns the timer, so this stays pure.
 */
export class QuietWatch {
  private burstStart = 0;
  lastOutput = 0;

  /** Records output. True once the current burst has become busy. */
  output(now: number): boolean {
    if (!this.burstStart) this.burstStart = now;
    this.lastOutput = now;
    return now - this.burstStart >= BUSY_MS;
  }

  /** Milliseconds until the burst has been quiet for `quietMs`. */
  remaining(now: number, quietMs: number): number {
    return quietMs - (now - this.lastOutput);
  }

  /** Ends the burst. True when it was busy, so the tab should be marked. */
  settle(): boolean {
    const busy = this.burstStart > 0 && this.lastOutput - this.burstStart >= BUSY_MS;
    this.burstStart = 0;
    return busy;
  }

  reset() {
    this.burstStart = 0;
  }
}
