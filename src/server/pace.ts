// Pace/tempo helpers — pure math, no local imports (so nothing here can create a
// cycle: stats.ts imports this; doctor.ts/standup.ts reach the derived thresholds
// via stats.ts's boardPace()). Two concerns:
//   1. Adaptive time-series bucketing — pick a bucket size that scales with the
//      board's actual age, so an agent-driven board that's hours old renders a
//      useful multi-point graph instead of one daily dot (see docs/13-analytics §3).
//   2. Pace-aware aging thresholds — derive "stale" from observed completion tempo
//      rather than a fixed 7d, so fast boards don't read "fresh" forever.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---- adaptive bucketing --------------------------------------------------

/** Candidate bucket widths, ascending. Every sub-day rung divides 24h so those
 *  buckets land on clean UTC clock boundaries; `1d`/`2d` land on UTC midnight;
 *  `7d` is Thursday-aligned (epoch-anchored — deterministic, not special-cased). */
export const BUCKET_LADDER = [
  5 * MIN_MS,
  15 * MIN_MS,
  30 * MIN_MS,
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
];

/** Target upper bound on series length. ~33 sparkline chars fit an 80-col line
 *  after the label; the 560px SVG (≈524px plot) gives ≥15px per point at 33. */
export const TARGET_MAX_BUCKETS = 32;

/** Floor on the rendered span: below this, buckets would be noise. A board with a
 *  task older than one bucket (~5m) always yields ≥2 points, so charts never hit
 *  the "not enough data" (<2) path. */
export const MIN_SPAN_MS = 30 * MIN_MS;

/** Smallest ladder step whose bucket count over `spanMs` is ≤ TARGET_MAX_BUCKETS.
 *  A 365d window falls through to weekly (≤53 buckets — accepted overflow; weekly
 *  is the natural top unit). */
export function chooseBucket(spanMs: number): number {
  for (const step of BUCKET_LADDER) if (Math.ceil(spanMs / step) <= TARGET_MAX_BUCKETS) return step;
  return BUCKET_LADDER[BUCKET_LADDER.length - 1];
}

export interface BucketRange {
  /** Bucket-start epochs (ms), ascending. The last bucket is partial: it runs to
   *  `nowMs`, not `start + step`. */
  starts: number[];
  step: number;
}

/**
 * Epoch-aligned bucket edges spanning `[nowMs - spanMs, nowMs]`. The first start
 * is floored to a multiple of `step` from the Unix epoch, so edges land on clean
 * boundaries; flooring can add one bucket beyond the target (accepted). Always
 * returns ≥2 starts for `spanMs ≥ MIN_SPAN_MS`.
 */
export function bucketRange(nowMs: number, spanMs: number): BucketRange {
  const step = chooseBucket(spanMs);
  const firstStart = Math.floor((nowMs - spanMs) / step) * step;
  const lastStart = Math.floor(nowMs / step) * step;
  const starts: number[] = [];
  for (let s = firstStart; s <= lastStart; s += step) starts.push(s);
  return { starts, step };
}

/** Compact human label for a bucket width: `5m` / `1h` / `12h` / `1d` / `7d`. */
export function bucketLabel(ms: number): string {
  if (ms < HOUR_MS) return `${Math.round(ms / MIN_MS)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

// ---- pace-aware aging ----------------------------------------------------

/** Fixed fallback when the board has too little completion history to derive a
 *  tempo — mirrors the legacy fresh ≤1d / stale >7d constants. */
export const DEFAULT_STALE_MS = 7 * DAY_MS;
export const DEFAULT_FRESH_MS = DAY_MS;
/** Below this many completions the p90 cycle time is too noisy to trust. */
export const MIN_COMPLETIONS = 5;
/** "Stale" = this many times the p90 completion time. */
export const PACE_K = 3;
/** Never call work stale in under an hour, however fast the board runs. */
export const STALE_FLOOR_MS = HOUR_MS;

export interface PaceThresholds {
  /** Age (ms) beyond which a task counts as stale. */
  stale_ms: number;
  /** Age (ms) at or under which a task counts as fresh. */
  fresh_ms: number;
  /** `cycle-time` = derived from tempo; `default` = fixed fallback. */
  basis: 'cycle-time' | 'default';
  /** Completions the estimate rests on (for the never-silent render). */
  n: number;
}

/**
 * Aging thresholds from observed tempo. With fewer than `MIN_COMPLETIONS` (or no
 * usable p90) it returns the fixed legacy thresholds. Otherwise `stale = 3 × p90
 * cycle time`, clamped to `[1h, 7d]` — the 7d ceiling means pace-awareness only
 * ever *tightens* vs. today; `fresh = stale / 7` (mirroring the legacy 1d:7d
 * ratio), floored at 5m.
 */
export function paceThresholds(cycleP90Ms: number, n: number): PaceThresholds {
  if (n < MIN_COMPLETIONS || cycleP90Ms <= 0)
    return { stale_ms: DEFAULT_STALE_MS, fresh_ms: DEFAULT_FRESH_MS, basis: 'default', n };
  const stale_ms = Math.min(DEFAULT_STALE_MS, Math.max(STALE_FLOOR_MS, PACE_K * cycleP90Ms));
  return { stale_ms, fresh_ms: Math.max(stale_ms / 7, 5 * MIN_MS), basis: 'cycle-time', n };
}
