// Commander option helpers. Kept out of kanban.ts, which parses argv at
// import time and therefore can't be imported from tests.

/** Accumulator for list-valued options: repeated flags append, and each
 *  occurrence may itself be comma-separated (`--label a,b --label c` -> [a,b,c]). */
export function collectList(value: string, previous?: string[]): string[] {
  return (previous ?? []).concat(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
