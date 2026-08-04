import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { generateIcons } from './gen-icons.mjs';

mkdirSync('public', { recursive: true });

// Bundle the browser-side .apkg importer (jszip + sql.js + fzstd)
await build({
  entryPoints: ['src/importer.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'ApkgImporter',
  outfile: 'public/importer.js',
  logLevel: 'info',
});

// sql.js loads its wasm at runtime from the site root; the bundled browser
// build requests sql-wasm-browser.wasm
copyFileSync('node_modules/sql.js/dist/sql-wasm-browser.wasm', 'public/sql-wasm-browser.wasm');

generateIcons();
