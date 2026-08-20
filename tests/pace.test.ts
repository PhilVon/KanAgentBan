import { describe, it, expect } from 'vitest';
import {
  BUCKET_LADDER,
  TARGET_MAX_BUCKETS,
  MIN_SPAN_MS,
  chooseBucket,
  bucketRange,
  bucketLabel,
  paceThresholds,
  DEFAULT_STALE_MS,
  DEFAULT_FRESH_MS,
  STALE_FLOOR_MS,
  PACE_K,
} from '../src/server/pace';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('pace: bucket selection', () => {
  it('picks the expected ladder step across board ages', () => {
    const cases: [number, number][] = [
      [30 * MIN, 5 * MIN],
      [6 * HOUR, 15 * MIN],
      [3 * DAY, 4 * HOUR],
      [14 * DAY, 12 * HOUR],
      [30 * DAY, DAY],
      [60 * DAY, 2 * DAY],
      [365 * DAY, 7 * DAY],
    ];
    for (const [span, expected] of cases) expect(chooseBucket(span)).toBe(expected);
  });

  it('keeps the count within target (except the 7d overflow rung)', () => {
    for (const span of [30 * MIN, 6 * HOUR, 3 * DAY, 14 * DAY, 30 * DAY, 60 * DAY]) {
      const { starts } = bucketRange(Date.now(), span);
      // Flooring the first edge can add one bucket beyond the target.
      expect(starts.length).toBeLessThanOrEqual(TARGET_MAX_BUCKETS + 1);
    }
  });

  // 365d falls through to the weekly rung — bounded, but allowed to exceed the
  // target. The bound has to be DERIVED, not picked: bucketRange floors both edges,
  // so count = floor(now/step) - floor((now - span)/step) + 1, and 365d spans
  // 365/7 = 52.142857 weekly steps. The difference is therefore 52 or 53 depending
  // on where `now` sits inside the week, i.e. the count is 53 or 54 — 54 on exactly
  // 2 days in every 14 (the 0.142857 fractional part). A hand-picked 53 failed on
  // 14% of calendar days, on every platform.
  it('bounds the 365d fall-through at ceil(span/step) + 1 at every phase of the week', () => {
    const span = 365 * DAY;
    const step = chooseBucket(span);
    const bound = Math.ceil(span / step) + 1; // 53 + 1 = 54
    const counts = new Set<number>();

    // Sweep two whole weeks of day offsets so the assertion cannot depend on the
    // date the suite happens to run: 14 consecutive days cover all 7 phases twice.
    for (let day = 0; day < 14; day++) {
      const { starts } = bucketRange(Date.now() + day * DAY, span);
      expect(starts.length).toBeLessThanOrEqual(bound);
      counts.add(starts.length);
    }

    // …and the sweep must actually reach the wide case, or the bound is untested.
    expect(Math.max(...counts)).toBe(bound);
  });

  it('falls through to the top rung when nothing fits the target', () => {
    expect(chooseBucket(10 * 365 * DAY)).toBe(BUCKET_LADDER[BUCKET_LADDER.length - 1]);
  });
});

describe('pace: bucket range', () => {
  it('aligns starts to exact multiples of the step and yields >=2 at min span', () => {
    const now = 1_700_000_123_456; // fixed, arbitrary
    const { starts, step } = bucketRange(now, MIN_SPAN_MS);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const s of starts) expect(s % step).toBe(0);
    // Ascending & contiguous by step.
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBe(step);
  });

  it('spans up to now — the last bucket start is <= now < last start + step', () => {
    const now = 1_700_000_123_456;
    const { starts, step } = bucketRange(now, 6 * HOUR);
    const last = starts[starts.length - 1];
    expect(last).toBeLessThanOrEqual(now);
    expect(last + step).toBeGreaterThan(now);
  });
});

describe('pace: labels', () => {
  it('formats bucket widths compactly', () => {
    expect(bucketLabel(5 * MIN)).toBe('5m');
    expect(bucketLabel(HOUR)).toBe('1h');
    expect(bucketLabel(12 * HOUR)).toBe('12h');
    expect(bucketLabel(DAY)).toBe('1d');
    expect(bucketLabel(7 * DAY)).toBe('7d');
  });
});

describe('pace: aging thresholds', () => {
  it('falls back to fixed legacy thresholds below the completion floor', () => {
    const t = paceThresholds(2 * HOUR, 4);
    expect(t.basis).toBe('default');
    expect(t.stale_ms).toBe(DEFAULT_STALE_MS);
    expect(t.fresh_ms).toBe(DEFAULT_FRESH_MS);
  });

  it('falls back when there is no usable p90', () => {
    expect(paceThresholds(0, 20).basis).toBe('default');
  });

  it('derives stale = k*p90 with fresh = stale/7 once enough completions exist', () => {
    const p90 = 2 * HOUR;
    const t = paceThresholds(p90, 8);
    expect(t.basis).toBe('cycle-time');
    expect(t.stale_ms).toBe(PACE_K * p90);
    expect(t.fresh_ms).toBe(t.stale_ms / 7);
  });

  it('clamps to the 1h floor and 7d ceiling', () => {
    expect(paceThresholds(60_000, 10).stale_ms).toBe(STALE_FLOOR_MS); // 3*1m -> floored to 1h
    expect(paceThresholds(10 * DAY, 10).stale_ms).toBe(DEFAULT_STALE_MS); // 3*10d -> capped at 7d
  });
});
