#!/usr/bin/env node
/**
 * Install the kanban skill into the Claude Code config dir, and detect drift.
 *
 * The skill has one source of truth — `skill/` plus `docs/` in this repo. The
 * installed copy under `<CLAUDE_CONFIG_DIR>/skills/kanban/` is a *derived*
 * artifact. Before this script existed the two diverged silently: edits made to
 * the installed SKILL.md (2026-08-19) lived nowhere else and were only found a
 * month later, when an install would have destroyed them.
 *
 *   npm run install-skill            # sync skill/ + docs/ -> <config>/skills/kanban/
 *   npm run install-skill -- --check # report drift, exit 2 if any, 0 if clean
 *
 * `--check` is the point: drift becomes a thing you can notice on purpose
 * (a CI step, a release checklist) instead of a thing you discover by losing work.
 * Because the installed tree is wholly owned by this script, a sync also removes
 * files that are no longer in source — every removal is printed, never silent.
 *
 * CLAUDE_CONFIG_DIR overrides the destination root (default `~/.claude`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const configDir = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude');
const DEST = path.join(configDir, 'skills', 'kanban');

/** What gets installed, and where it lands inside DEST. */
const TREES = [
  { from: path.join(ROOT, 'skill'), to: '' }, // skill/SKILL.md -> <dest>/SKILL.md
  { from: path.join(ROOT, 'docs'), to: 'docs' }, // docs/**       -> <dest>/docs/**
];

const checkOnly = process.argv.slice(2).includes('--check');

/** Relative paths of every file under `dir`, POSIX-separated, sorted. */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

// Desired state: relative-path-in-DEST -> absolute source path.
const desired = new Map();
for (const tree of TREES) {
  for (const rel of walk(tree.from)) {
    desired.set(tree.to ? `${tree.to}/${rel}` : rel, path.join(tree.from, rel));
  }
}
const present = new Set(walk(DEST));

const same = (a, b) => fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

const missing = [];
const changed = [];
for (const [rel, src] of desired) {
  const dst = path.join(DEST, rel);
  if (!present.has(rel)) missing.push(rel);
  else if (!same(src, dst)) changed.push(rel);
}
const extra = [...present].filter((rel) => !desired.has(rel)).sort();

if (checkOnly) {
  const drift = missing.length + changed.length + extra.length;
  if (!drift) {
    console.log(`[install-skill] clean — ${desired.size} files match ${DEST}`);
    process.exit(0);
  }
  console.error(`[install-skill] drift vs ${DEST}:`);
  for (const rel of missing) console.error(`  missing   ${rel}`);
  for (const rel of changed) console.error(`  differs   ${rel}`);
  for (const rel of extra) console.error(`  extra     ${rel}`);
  console.error(
    `  ${drift} file(s) out of sync.\n` +
      `  A "differs" file may hold edits that exist ONLY in the installed copy — diff it\n` +
      `  before syncing, because \`npm run install-skill\` overwrites it from source.`,
  );
  process.exit(2);
}

for (const rel of [...missing, ...changed]) {
  const dst = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(desired.get(rel), dst);
}
for (const rel of extra) fs.rmSync(path.join(DEST, rel));

const unchanged = desired.size - missing.length - changed.length;
console.log(
  `[install-skill] ${DEST}\n` +
    `  ${missing.length} added, ${changed.length} updated, ${extra.length} removed, ${unchanged} unchanged`,
);
for (const rel of extra) console.log(`  removed ${rel}`);
