// Builds a minimal .apkg from a TSV file (front<TAB>back[<TAB>tags] per line,
// lines starting with # ignored). The output is meant for Flash's importer —
// it uses the legacy collection layout, not the full schema real Anki expects.
//
// usage: node scripts/make-apkg.mjs cards.tsv "Deck Name" out.apkg
import initSqlJs from 'sql.js';
import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'node:fs';

const [tsvPath, deckName = 'Imported', outPath = 'deck.apkg'] = process.argv.slice(2);
if (!tsvPath) {
  console.error('usage: node scripts/make-apkg.mjs cards.tsv "Deck Name" out.apkg');
  process.exit(1);
}

const SEP = '\x1f';
const rows = readFileSync(tsvPath, 'utf-8').split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t'))
  .filter(([front, back]) => front?.trim() && back?.trim());

const SQL = await initSqlJs();
const db = new SQL.Database();
db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, decks TEXT, models TEXT);
        CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, tags TEXT);
        CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);`);
db.run('INSERT INTO col (id, decks, models) VALUES (1, ?, ?)',
  [JSON.stringify({ 100: { name: deckName } }), '{}']);
rows.forEach(([front, back, tags = ''], i) => {
  db.run('INSERT INTO notes (id, mid, flds, tags) VALUES (?, 1, ?, ?)',
    [i + 1, `${front.trim()}${SEP}${back.trim()}`, tags.trim()]);
  db.run('INSERT INTO cards (id, nid, did) VALUES (?, ?, 100)', [i + 1, i + 1]);
});

const zip = new JSZip();
zip.file('collection.anki2', db.export());
zip.file('media', '{}');
writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }));
console.log(`${outPath}: ${rows.length} cards in "${deckName}"`);
