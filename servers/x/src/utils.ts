/**
 * Random integer between min and max, inclusive.
 */
export function r(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export type RateLimitHit = { status: number; url: string; at: number };

export class RateLimitError extends Error {
  constructor(public readonly hit: RateLimitHit) {
    let pathname = hit.url;
    try {
      pathname = new URL(hit.url).pathname;
    } catch {}
    super(`Rate limited by X: HTTP ${hit.status} on ${pathname}. Back off and retry later.`);
    this.name = "RateLimitError";
  }
}

const RATE_LIMIT_PROP = "__xMcpRateLimitHit";

export function recordRateLimitHit(target: object, hit: RateLimitHit): void {
  (target as Record<string, RateLimitHit>)[RATE_LIMIT_PROP] = hit;
}

export function getRateLimitHit(target: object | null | undefined): RateLimitHit | undefined {
  if (!target) return undefined;
  return (target as Record<string, RateLimitHit | undefined>)[RATE_LIMIT_PROP];
}
