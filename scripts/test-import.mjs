// Builds a synthetic legacy-format .apkg (and a new-schema variant) in memory,
// runs it through the importer, and checks the output. Also writes the legacy
// file to the scratch path given as argv[2] (optional) for browser testing.
import initSqlJs from 'sql.js';
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { parseApkg } from '../src/importer.js';

const SQL = await initSqlJs();
const SEP = '\x1f';

function legacyCollection() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, decks TEXT, models TEXT);
          CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, tags TEXT);
          CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);`);
  const decks = JSON.stringify({
    1: { name: 'Default' },
    100: { name: 'Deutsch::B1 Wortschatz' },
  });
  db.run('INSERT INTO col (id, decks, models) VALUES (1, ?, ?)', [decks, '{}']);
  const notes = [
    [1, `der Löffel${SEP}the spoon [sound:spoon.mp3]`, 'küche'],
    [2, `die Übung<img src="x.jpg">${SEP}the exercise${SEP}extra field`, ''],
    [3, `{{c1::häufig}} kommt vor${SEP}occurs often`, 'cloze'],
    [4, `nur-vorne${SEP}`, ''], // empty back -> skipped
  ];
  for (const [id, flds, tags] of notes) {
    db.run('INSERT INTO notes (id, mid, flds, tags) VALUES (?, 1, ?, ?)', [id, flds, tags]);
    db.run('INSERT INTO cards (id, nid, did) VALUES (?, ?, 100)', [id * 10, id]);
    db.run('INSERT INTO cards (id, nid, did) VALUES (?, ?, 100)', [id * 10 + 1, id]); // 2nd template
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

function newSchemaCollection() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, decks TEXT, models TEXT);
          CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT, tags TEXT);
          CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);`);
  db.run('INSERT INTO col (id, decks, models) VALUES (1, ?, ?)', ['', '']);
  db.run('INSERT INTO decks (id, name) VALUES (7, ?)', [`Deutsch${SEP}Verben`]);
  db.run('INSERT INTO notes (id, mid, flds, tags) VALUES (1, 1, ?, ?)', [`laufen${SEP}to run`, '']);
  db.run('INSERT INTO cards (id, nid, did) VALUES (1, 1, 7)');
  const bytes = db.export();
  db.close();
  return bytes;
}

async function zipAs(entryName, bytes) {
  const zip = new JSZip();
  zip.file(entryName, bytes);
  zip.file('media', '{}');
  return zip.generateAsync({ type: 'uint8array' });
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// legacy format
const legacyZip = await zipAs('collection.anki2', legacyCollection());
const legacy = await parseApkg(legacyZip);
check('legacy: one deck', legacy.length, 1);
check('legacy: deck name', legacy[0].name, 'Deutsch::B1 Wortschatz');
check('legacy: 3 cards (empty-back note skipped, note dupes collapsed)', legacy[0].cards.length, 3);
check('legacy: sound tag stripped', legacy[0].cards[0], { front: 'der Löffel', back: 'the spoon', tags: 'küche' });
check('legacy: img stripped, extra field joined', legacy[0].cards[1],
  { front: 'die Übung', back: 'the exercise<hr>extra field', tags: '' });
check('legacy: cloze flattened', legacy[0].cards[2].front, '[häufig] kommt vor');

// new schema (as inside collection.anki21b, minus the zstd layer)
const newZip = await zipAs('collection.anki21', newSchemaCollection());
const modern = await parseApkg(newZip);
check('new schema: deck name from decks table', modern[0].name, 'Deutsch::Verben');
check('new schema: card', modern[0].cards[0], { front: 'laufen', back: 'to run', tags: '' });

if (process.argv[2]) {
  writeFileSync(process.argv[2], legacyZip);
  console.log(`wrote ${process.argv[2]}`);
}

process.exit(failures ? 1 : 0);
