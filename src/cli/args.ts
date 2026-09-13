// Commander option helpers. Kept out of kanban.ts, which parses argv at
// import time and therefore can't be imported from tests.
import * as fs from 'node:fs';

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

/** The free text a command stores, taken from its positional argument or from
 *  `--file`. A file never passes through shell quoting, which is the point: from
 *  Windows PowerShell 5.1 an embedded double quote ends a native argument early,
 *  so long text passed positionally can arrive cut short. Exactly one of the two
 *  is required. From a file, a leading byte-order mark and one trailing newline
 *  are dropped - PowerShell's Out-File writes both, and neither is the text. */
export function textArg(
  positional: string | undefined,
  file: string | undefined,
  what: string,
  read: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string {
  if (positional !== undefined && file !== undefined) throw new Error(`give the ${what} or --file, not both`);
  if (file === undefined) {
    if (positional === undefined) throw new Error(`missing ${what} (or --file <path>)`);
    return positional;
  }
  const text = read(file).replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  if (text.trim() === '') throw new Error(`the ${what} in ${file} is empty`);
  return text;
}

/** `textArg` for a field that may be left out, such as a task description given as
 *  `--description` or `--description-file`: undefined when neither is given. */
export function optionalText(
  inline: string | undefined,
  file: string | undefined,
  what: string,
  read?: (path: string) => string,
): string | undefined {
  if (inline === undefined && file === undefined) return undefined;
  if (inline !== undefined && file !== undefined) throw new Error(`give --${what} or --${what}-file, not both`);
  return textArg(inline, file, what, read);
}
