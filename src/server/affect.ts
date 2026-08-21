/**
 * Affect hints — the board's half of the EmotionalBrain integration, and *only*
 * that half. See ADR 0009.
 *
 * The board emits a labelled line of **text**: an `eb consult …` command the
 * agent may choose to run. It never executes `eb`, never opens a socket to the
 * brain, never stores a stance/cue-aggregate/feeling, and never renders affect to
 * the human. EmotionalBrain's ADR 0008 ("No Linkage to Project or Task Stores")
 * forbids the linkage form by name and leaves exactly this door open: *"if that
 * is ever wanted, the agent does it."*
 *
 * What the board contributes is the half `eb` cannot supply for itself: **the
 * moment** — it is the only thing that knows when a choice is actually being made
 * — and **the vocabulary**, because a task's *mapped* labels become cue keys, so the
 * cue namespace is inherited rather than reinvented each session. Cue sprawl
 * (`activity:test-fixing` invented beside an existing `activity:flaky-tests`) is
 * the main way a brain becomes useless: every cue stuck at n=1 is evidence that
 * never crosses a threshold.
 *
 * Everything here is a pure string builder. A machine with no `eb` installed is
 * unaffected — the feature is text.
 */

/** Every finding/hint the board emits is prefixed so it can never be mistaken
 *  for the board's own judgement (ADR 0009 guard rail). */
export const AFFECT_PREFIX = 'affect:';

/**
 * `eb`'s cue namespaces, minus `proj:`. The set is closed — an unknown namespace
 * is a rejected write (`eb` exit 4) — and `proj:` is deliberately absent: `eb`
 * derives it from the cwd basename itself, so a board emitting one would be
 * inventing a fact about a project rather than passing on a cue.
 */
export const CUE_NAMESPACES = ['tool', 'lang', 'activity', 'context', 'collab'] as const;

/** `eb consult --options` refuses more than four: past four it is a survey, not
 *  a choice. Emitting five would be a command the agent cannot run. */
export const MAX_CONSULT_OPTIONS = 4;

export interface AffectConfig {
  enabled: boolean;
  /** label -> cue. A label absent from the map emits **no cue** — see `cuesFor`. */
  map: Record<string, string>;
  /**
   * Write hints (`eb feel`) — a **separate** opt-in from `enabled`, per ADR 0010.
   * A read hint offers a question the agent may ignore; a write hint asks it to put
   * something in a store that has no delete. Turning on consult hints is not
   * consent to be prompted to write.
   */
  writes?: boolean;
}

export const AFFECT_OFF: AffectConfig = { enabled: false, map: {}, writes: false };

/**
 * Validate a configured cue. Returns null when fine, else the reason — the
 * caller decides whether that is a CLI error or a 400.
 */
export function cueError(cue: string): string | null {
  const at = cue.indexOf(':');
  if (at <= 0) return `"${cue}" has no namespace — use one of ${CUE_NAMESPACES.join(', ')} (e.g. activity:port)`;
  const ns = cue.slice(0, at);
  const value = cue.slice(at + 1);
  if (ns === 'proj')
    return 'proj: is derived by eb from the working directory — a board must never emit one (EmotionalBrain ADR 0008)';
  if (!(CUE_NAMESPACES as readonly string[]).includes(ns))
    return `unknown cue namespace "${ns}:" — the set is closed: ${CUE_NAMESPACES.join(', ')}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value))
    return `"${value}" is not a cue value — lowercase letters, digits and dashes`;
  return null;
}

export interface CueSet {
  /** The cues to emit — mapped labels only, deduped, in board order. */
  cues: string[];
  /** Labels that produced no cue. Named rather than dropped, so the silence is
   *  explained somewhere it can be acted on. */
  unmapped: string[];
}

/**
 * A task's labels as cue keys — **mapped labels only**.
 *
 * The map is *advisory to the agent and binding on the board*: an unmapped label
 * emits nothing at all. It used to fall back to `activity:<label>`, which had the
 * board minting vocabulary on the agent's behalf out of its own bookkeeping —
 * `tier-1`, `epic` and `planning` are not activities, and `test`/`tests` and
 * `web`/`webui` split one concept across two keys. Cue keys are immutable in
 * `eb` (no rename, no merge — EmotionalBrain ADR 0006), so a bad cue costs
 * evidence permanently while silence costs one prompt. That asymmetry is the
 * whole argument for emitting less.
 *
 * A task with no labels still emits no cues — never a guess from the title,
 * which would be exactly the invented vocabulary this exists to stop. A label
 * mapped to a cue `eb` would reject counts as unmapped: emitting it would be a
 * command the agent cannot run, and the fix is the same one.
 */
export function cuesFor(labels: string[], map: Record<string, string> = {}): CueSet {
  const cues: string[] = [];
  const unmapped: string[] = [];
  for (const label of labels) {
    const cue = map[label];
    if (!cue || cueError(cue)) {
      if (!unmapped.includes(label)) unmapped.push(label);
      continue;
    }
    if (!cues.includes(cue)) cues.push(cue);
  }
  return { cues, unmapped };
}

/** Just the cues — the common case, where the caller has nothing to say about
 *  the labels that produced none. */
export function cuesForLabels(labels: string[], map: Record<string, string> = {}): string[] {
  return cuesFor(labels, map).cues;
}

export interface LabelUse {
  label: string;
  tasks: number;
}

/**
 * What `board affect --check` found. Four buckets, because they take four
 * different actions — and only one of them is an error.
 */
export interface AffectCheck {
  enabled: boolean;
  /** Labels that will emit a cue. */
  mapped: { label: string; cue: string; tasks: number }[];
  /** Labels that emit nothing, commonest first — the ranking is the point: it
   *  says which single mapping would buy the most evidence. */
  unmapped: LabelUse[];
  /** Map entries `eb` would reject. `--map` validates, so one of these can only
   *  arrive by hand-editing board.json — an error, not a preference. */
  invalid: { label: string; cue: string; reason: string }[];
  /** Language cues derived from linked commits — board-wide, commonest first.
   *  Listed so they are visible rather than arriving unexplained: they are the
   *  one thing here the board derives rather than being told. */
  derived: string[];
  /** Mapped, but no live task carries the label. Harmless, and worth saying:
   *  a mapping nothing uses is usually a renamed or archived label. */
  stale: { label: string; cue: string }[];
}

/**
 * Compare the configured map against the labels actually in use.
 *
 * Pure: it is handed the usage counts rather than reading them, so this module
 * stays a string-and-struct builder that touches neither a database nor a
 * process (ADR 0009, and the structural test that enforces it).
 */
export function checkAffect(
  cfg: AffectConfig,
  usage: LabelUse[],
  langs: { lang: string; commits: number }[] = [],
): AffectCheck {
  const map = cfg.map ?? {};
  const check: AffectCheck = {
    enabled: cfg.enabled,
    mapped: [],
    unmapped: [],
    invalid: [],
    stale: [],
    derived: langCues(langs, Number.MAX_SAFE_INTEGER),
  };
  const used = new Set(usage.map((u) => u.label));

  for (const { label, tasks } of usage) {
    const cue = map[label];
    if (!cue) {
      check.unmapped.push({ label, tasks });
      continue;
    }
    const reason = cueError(cue);
    if (reason) check.invalid.push({ label, cue, reason });
    else check.mapped.push({ label, cue, tasks });
  }

  for (const [label, cue] of Object.entries(map)) {
    if (used.has(label)) continue;
    const reason = cueError(cue);
    if (reason) check.invalid.push({ label, cue, reason });
    else check.stale.push({ label, cue });
  }
  check.stale.sort((a, b) => a.label.localeCompare(b.label));
  check.invalid.sort((a, b) => a.label.localeCompare(b.label));
  return check;
}

/** How many derived language cues one task may contribute. A task spanning more
 *  is a sweep, and a sweep is not evidence about any one language. */
export const MAX_TASK_LANGS = 3;

/**
 * A task's linked commits as `lang:` cues.
 *
 * This is derivation, which T-109 withdrew for labels — and it is allowed here
 * for the one reason that does not generalise: the extension -> language table is
 * closed and canonical, so the board applies a convention the world already
 * agreed rather than inventing a name for something. An extension outside the
 * table contributes nothing, exactly as an unmapped label does.
 */
export function langCues(usage: { lang: string; commits: number }[], cap = MAX_TASK_LANGS): string[] {
  return usage.slice(0, cap).map((u) => `lang:${u.lang}`).filter((c) => !cueError(c));
}

/**
 * Why a completion was worth a feeling. Each maps to a row in EmotionalBrain`s
 * recordable-moment table (08 §3) that the board can actually see.
 */
export type DoneSalience = 'kickback' | 'slow' | 'clean';

/** The facts a salience judgement needs. Supplied by stats.ts — this module
 *  computes nothing and reads nothing. */
export interface DoneFacts {
  /** First In Progress -> Done, or null when the task never went In Progress. */
  cycleMs: number | null;
  /** Review -> In Progress moves. One is a wall hit; two is the archetype. */
  kickbacks: number;
  /** The board`s own completed-cycle distribution, and how many it rests on. */
  p10: number;
  p90: number;
  n: number;
}

/** Completions the distribution must rest on before its tails mean anything.
 *  Mirrors pace.ts`s MIN_COMPLETIONS: below it, only the kickback trigger fires. */
export const MIN_SALIENCE_COMPLETIONS = 5;

/**
 * Was this completion an outlier worth recording? `null` = an ordinary done, which
 * is most of them and must stay silent (ADR 0010 rule 2: salience, not frequency —
 * a prompted agent writes *something*, so firing on every done would manufacture
 * exactly the padding EmotionalBrain says is worse than an empty store).
 *
 * **Symmetric on purpose.** A trigger that only fired on kickbacks and slow work
 * would teach the brain that work is mostly frustrating — a sampling bias baked
 * into the trigger rather than earned from experience. The clean-fast tail carries
 * EmotionalBrain`s own "worked first try, or fell out cleanly" row, and it is what
 * keeps the record honest in both directions.
 *
 * Both tails are deciles, so each is rare by construction rather than by a
 * threshold somebody picked.
 */
export function doneSalience(f: DoneFacts): DoneSalience | null {
  if (f.kickbacks > 0) return 'kickback';
  // Below the floor the distribution is noise, and a tail of noise is not an
  // outlier. The kickback trigger above needs no distribution, so it still fires.
  if (f.cycleMs === null || f.n < MIN_SALIENCE_COMPLETIONS) return null;
  if (f.p90 > 0 && f.cycleMs >= f.p90) return 'slow';
  if (f.p10 > 0 && f.cycleMs <= f.p10) return 'clean';
  return null;
}

/**
 * The write hint. Placeholders, never values — ADR 0010 rule 1, which is the rule
 * the whole feature stands on: EmotionalBrain lists "what you expect to feel" among
 * the things never to record, and calls it *the one failure mode the server cannot
 * detect*. A board that named the label would manufacture precisely that, every
 * time it fired, where the store has no defence of its own.
 */
export function feelCommand(cues: string[]): string {
  const head = `eb feel <label> "<felt sense>"`;
  return cues.length ? `${head} --about ${cues.join(',')}` : head;
}

/** Strip what would break the command's own quoting, and keep it short. */
function clean(s: string, max = 48): string {
  const one = s.replace(/["`\\]/g, '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * The candidate-set consult: a stance per candidate, in the order given, never
 * ranked — which is the right shape, because a stance is one input rather than
 * the answer. `--options` cannot be combined with `--about` or a query (a
 * candidate set and a prospective action are different questions), so this
 * emits neither.
 *
 * Returns null below two candidates: one candidate is not a choice.
 */
export function consultOptionsCommand(titles: string[]): string | null {
  const opts = titles.map((t) => clean(t).replace(/,/g, ' ')).filter(Boolean).slice(0, MAX_CONSULT_OPTIONS);
  if (opts.length < 2) return null;
  return `eb consult --options "${opts.join(',')}"`;
}

/** The prospective-action consult, seeded with the task's own cues. */
export function consultAboutCommand(what: string, cues: string[]): string {
  const head = `eb consult "${clean(what, 72)}"`;
  return cues.length ? `${head} --about ${cues.join(',')}` : head;
}

/** `affect: <command>` — always its own labelled line (ADR 0009). */
export function affectLine(command: string | null): string | null {
  return command ? `${AFFECT_PREFIX} ${command}` : null;
}
