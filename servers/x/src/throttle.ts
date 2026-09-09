/**
 * Pacing and backoff for every tool call that drives the browser.
 *
 * The write behaviours already wait between individual clicks; nothing spaced
 * the tool calls themselves, and a stream of scrapes with no gap is the pattern
 * that gets an account flagged. `pace` puts a jittered floor under the interval
 * between calls. `penalize` is what the 429 listener was missing: X was already
 * being detected, and the server did nothing with it beyond reporting.
 */

const PACE_MIN_MS = 5_000;
const PACE_JITTER_MS = 5_000;
// The first step has to be short enough to sit out inside one `wait` call.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** A single wait call sleeps at most this long; longer cooldowns take several. */
const WAIT_CAP_MS = 45_000;
/** Blocked this many times in one cooldown and we stop waiting — hanging is not a plan. */
const MAX_BLOCKED = 3;

export class Throttle {
  private last = 0;
  private until = 0;
  private strikes = 0;
  private blocked = 0;

  /** Blocks until enough time has passed since the previous call. */
  async pace(): Promise<void> {
    const gap = PACE_MIN_MS + Math.floor(Math.random() * PACE_JITTER_MS);
    const wait = this.last === 0 ? 0 : this.last + gap - Date.now();
    this.last = Date.now() + Math.max(0, wait);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /**
   * The remaining cooldown, or null. This reports; it does not sit and wait —
   * waiting is the `wait` tool's job, so the caller gets to decide between
   * waiting it out and going to do something else.
   */
  check(): string | null {
    const remaining = this.until - Date.now();
    if (remaining <= 0) {
      this.blocked = 0; // this cooldown is over
      return null;
    }

    this.blocked += 1;
    const secs = Math.ceil(remaining / 1000);
    if (this.blocked >= MAX_BLOCKED) {
      return (
        `Waiting out X's cooldown did not work: blocked ${this.blocked} times, ${secs}s ` +
        `still left. Stop waiting and report this read as failed — whether the caller ` +
        `still wants it is their call.`
      );
    }
    return (
      `Rate limited by X — ${secs}s of cooldown left (${this.strikes} in a row, ` +
      `blocked ${this.blocked}/${MAX_BLOCKED}). X is not gone, just unusable right now: ` +
      `call wait to sit it out, then retry.`
    );
  }

  /**
   * Sleeps off up to WAIT_CAP_MS of the cooldown. Chunked because one tool call
   * cannot block indefinitely; if time remains, the caller just calls again.
   */
  async cool(): Promise<{ slept: number; remaining: number }> {
    const remaining = this.until - Date.now();
    // Once we have given up, wait must stop sleeping, or it becomes the place
    // the whole thing hangs.
    if (remaining <= 0 || this.blocked >= MAX_BLOCKED) {
      return { slept: 0, remaining: Math.max(0, remaining) };
    }

    const slept = Math.min(remaining, WAIT_CAP_MS);
    await new Promise((resolve) => setTimeout(resolve, slept));
    return { slept, remaining: remaining - slept };
  }

  penalize(): void {
    this.strikes += 1;
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (this.strikes - 1), BACKOFF_MAX_MS);
    this.until = Date.now() + wait;
  }

  succeed(): void {
    this.strikes = 0;
    this.blocked = 0;
    this.until = 0;
  }
}
