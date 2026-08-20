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
}

export const AFFECT_OFF: AffectConfig = { enabled: false, map: {} };

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
