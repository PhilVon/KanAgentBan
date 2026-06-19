#!/usr/bin/env node
/**
 * Vendor the self-hosted Font Awesome assets into web/vendor/fontawesome so the
 * static web UI can serve them offline (no kit/CDN at runtime). Copies
 * css/all.min.css and the webfonts/ woff2 files, preserving the css -> ../webfonts
 * relative path the stylesheet expects.
 *
 * Prefers Font Awesome Pro when it's installed (a Pro account + token); otherwise
 * falls back to the public Font Awesome Free package — both share the same css +
 * webfonts layout and the UI only uses Free-available icons, so the swap is
 * transparent. Runs on `postinstall` and as part of `npm run build`.
 *
 * If NEITHER package is installed, it warns and exits 0 so the build still
 * succeeds — the UI degrades gracefully (labels/counts render, icons just don't).
 */
const fs = require('node:fs');
const path = require('node:path');

const DEST = path.resolve(__dirname, '..', 'web', 'vendor', 'fontawesome');

// Pro first (richer set), then the public Free fallback.
const SOURCES = [
  { pkg: '@fortawesome/fontawesome-pro', label: 'Pro' },
  { pkg: '@fortawesome/fontawesome-free', label: 'Free' },
];

let chosen = null;
for (const s of SOURCES) {
  try {
    const dir = path.dirname(require.resolve(`${s.pkg}/package.json`));
    chosen = { ...s, dir };
    break;
  } catch {
    /* not installed — try the next source */
  }
}

if (!chosen) {
  console.warn(
    '[copy-web-assets] no Font Awesome package found — skipping FA vendor copy.\n' +
      '  `npm install` pulls @fortawesome/fontawesome-free (public, no account needed);\n' +
      '  for the Pro set see .npmrc.pro.example. The UI still works — icons just won’t render.',
  );
  process.exit(0);
}

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// Clean-vendor: wipe any prior copy so the result matches exactly the chosen
// source (e.g. switching Pro -> Free must not leave Pro-only webfonts behind).
fs.rmSync(DEST, { recursive: true, force: true });

// 1) Stylesheet (all.min.css covers Classic Solid + Classic Regular and friends).
copyFile(path.join(chosen.dir, 'css', 'all.min.css'), path.join(DEST, 'css', 'all.min.css'));

// 2) Webfonts (woff2 only — the modern format all.min.css references).
const fontsSrc = path.join(chosen.dir, 'webfonts');
const fonts = fs.readdirSync(fontsSrc).filter((f) => f.endsWith('.woff2'));
for (const f of fonts) copyFile(path.join(fontsSrc, f), path.join(DEST, 'webfonts', f));

const version = require(`${chosen.pkg}/package.json`).version;
console.log(
  `[copy-web-assets] vendored FA ${chosen.label} ${version}: all.min.css + ${fonts.length} woff2 -> web/vendor/fontawesome`,
);
