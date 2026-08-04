// Browser-side .apkg parser. Bundled by esbuild into public/importer.js
// and exposed as window.ApkgImporter.
//
// An .apkg is a zip containing an SQLite database:
//   collection.anki2   (old format)
//   collection.anki21  (Anki 2.1 standard)
//   collection.anki21b (Anki 2.1.50+, zstd-compressed)
// Notes store their fields in `flds` separated by \x1f. Deck names/ids live
// either in the col.decks JSON blob (legacy) or in a `decks` table (new schema).

import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { decompress } from 'fzstd';

const FIELD_SEP = '\x1f';

function cleanField(html) {
  let out = html
    .replace(/\[sound:[^\]]*\]/g, '')      // audio refs (media not imported)
    .replace(/<img[^>]*>/gi, '')           // images (media not imported)
    .replace(/\{\{c(\d+)::(.*?)(::.*?)?\}\}/g, '[$2]'); // flatten cloze markers
  // strip the empty <div> nesting Anki's editor leaves behind
  let prev;
  do { prev = out; out = out.replace(/<div>\s*<\/div>/gi, ''); } while (out !== prev);
  // unwrap if the whole field is a single <div> wrapper
  const m = out.trim().match(/^<div>([\s\S]*)<\/div>$/i);
  if (m && !m[1].includes('<div')) out = m[1];
  return out.trim();
}

export async function parseApkg(file) {
  const zip = await JSZip.loadAsync(file);

  let dbBytes;
  if (zip.file('collection.anki21b')) {
    dbBytes = decompress(await zip.file('collection.anki21b').async('uint8array'));
  } else if (zip.file('collection.anki21')) {
    dbBytes = await zip.file('collection.anki21').async('uint8array');
  } else if (zip.file('collection.anki2')) {
    dbBytes = await zip.file('collection.anki2').async('uint8array');
  } else {
    throw new Error('No Anki collection found in this file — is it a .apkg export?');
  }

  // in the browser the wasm lives next to the page (root or /flash/); under
  // Node (tests) sql.js finds it in node_modules on its own
  const SQL = typeof window === 'undefined'
    ? await initSqlJs()
    : await initSqlJs({ locateFile: (f) => new URL(f, window.location.href).toString() });
  const db = new SQL.Database(dbBytes);
  try {
    return extract(db);
  } finally {
    db.close();
  }
}

function queryAll(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i], v])));
}

function tableExists(db, name) {
  return queryAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;
}

function deckNames(db) {
  const names = new Map(); // deck id -> name
  // New schema (anki21b): decks table, hierarchy separated by \x1f
  if (tableExists(db, 'decks')) {
    for (const row of queryAll(db, 'SELECT id, name FROM decks')) {
      names.set(String(row.id), String(row.name).split(FIELD_SEP).join('::'));
    }
    if (names.size) return names;
  }
  // Legacy: JSON blob in col.decks
  const col = queryAll(db, 'SELECT decks FROM col')[0];
  if (col?.decks) {
    try {
      const parsed = JSON.parse(col.decks);
      for (const [id, deck] of Object.entries(parsed)) names.set(String(id), deck.name);
    } catch { /* fall through */ }
  }
  return names;
}

function extract(db) {
  const names = deckNames(db);

  // Map note -> deck via its first card
  const noteDeck = new Map();
  for (const row of queryAll(db, 'SELECT nid, MIN(did) AS did FROM cards GROUP BY nid')) {
    noteDeck.set(String(row.nid), String(row.did));
  }

  const decks = new Map(); // name -> cards[]
  for (const note of queryAll(db, 'SELECT id, flds, tags FROM notes')) {
    const fields = String(note.flds).split(FIELD_SEP).map(cleanField);
    const front = fields[0];
    const back = fields.slice(1).filter(Boolean).join('<hr>');
    if (!front || !back) continue;

    const deckName = names.get(noteDeck.get(String(note.id))) || 'Imported';
    if (!decks.has(deckName)) decks.set(deckName, []);
    decks.get(deckName).push({ front, back, tags: String(note.tags || '').trim() });
  }

  return [...decks.entries()]
    .map(([name, cards]) => ({ name, cards }))
    .filter((d) => d.cards.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}
