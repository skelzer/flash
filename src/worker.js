import { Hono } from 'hono';
import { schedule, predictions } from './scheduler.js';

const app = new Hono();

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- auth ----

app.post('/api/login', async (c) => {
  const { passphrase } = await c.req.json();
  if (!c.env.APP_PASSPHRASE) return c.json({ error: 'Server passphrase not configured' }, 500);
  if (passphrase !== c.env.APP_PASSPHRASE) return c.json({ error: 'Wrong passphrase' }, 401);
  return c.json({ token: await sha256hex(passphrase) });
});

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();
  const token = (c.req.header('authorization') || '').replace(/^Bearer /, '');
  if (!c.env.APP_PASSPHRASE || token !== (await sha256hex(c.env.APP_PASSPHRASE))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

// ---- decks ----

app.get('/api/decks', async (c) => {
  const now = Date.now();
  const dayStart = Number(c.req.query('dayStart') || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name,
       COUNT(c.id) AS total,
       SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END) AS newCount,
       SUM(CASE WHEN c.state != 'new' AND c.due <= ?1 THEN 1 ELSE 0 END) AS dueCount,
       SUM(CASE WHEN c.introduced_at >= ?2 THEN 1 ELSE 0 END) AS introducedToday
     FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
     GROUP BY d.id ORDER BY d.name`
  ).bind(now, dayStart).all();
  return c.json({ decks: results });
});

app.post('/api/decks', async (c) => {
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: 'Name required' }, 400);
  const res = await c.env.DB.prepare('INSERT INTO decks (name, created_at) VALUES (?, ?)')
    .bind(name.trim(), Date.now()).run();
  return c.json({ id: res.meta.last_row_id, name: name.trim() });
});

app.patch('/api/decks/:id', async (c) => {
  const { name } = await c.req.json();
  await c.env.DB.prepare('UPDATE decks SET name = ? WHERE id = ?')
    .bind(name.trim(), c.req.param('id')).run();
  return c.json({ ok: true });
});

app.delete('/api/decks/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reviews WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?)').bind(id),
    c.env.DB.prepare('DELETE FROM cards WHERE deck_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM decks WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- cards (browse / edit) ----

app.get('/api/decks/:id/cards', async (c) => {
  const q = c.req.query('q') || '';
  const limit = Math.min(200, Number(c.req.query('limit') || 50));
  const offset = Number(c.req.query('offset') || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, front, back, tags, state, due, interval, reps, lapses FROM cards
     WHERE deck_id = ?1 AND (?2 = '' OR front LIKE ?3 OR back LIKE ?3 OR tags LIKE ?3)
     ORDER BY id DESC LIMIT ?4 OFFSET ?5`
  ).bind(c.req.param('id'), q, `%${q}%`, limit, offset).all();
  return c.json({ cards: results });
});

app.post('/api/decks/:id/cards', async (c) => {
  const { front, back, tags = '' } = await c.req.json();
  if (!front?.trim() || !back?.trim()) return c.json({ error: 'Front and back required' }, 400);
  const res = await c.env.DB.prepare(
    'INSERT INTO cards (deck_id, front, back, tags, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(c.req.param('id'), front.trim(), back.trim(), tags.trim(), Date.now()).run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch('/api/cards/:id', async (c) => {
  const { front, back, tags = '' } = await c.req.json();
  await c.env.DB.prepare('UPDATE cards SET front = ?, back = ?, tags = ? WHERE id = ?')
    .bind(front.trim(), back.trim(), tags.trim(), c.req.param('id')).run();
  return c.json({ ok: true });
});

app.delete('/api/cards/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reviews WHERE card_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- bulk import ----
// Body: { decks: [{ name, cards: [{ front, back, tags }] }] }
// Deck names are merged by exact name; duplicate fronts within a deck are skipped.

app.post('/api/import', async (c) => {
  const { decks } = await c.req.json();
  const now = Date.now();
  let imported = 0, skipped = 0;
  for (const deck of decks || []) {
    if (!deck.name?.trim() || !deck.cards?.length) continue;
    let row = await c.env.DB.prepare('SELECT id FROM decks WHERE name = ?').bind(deck.name.trim()).first();
    let deckId = row?.id;
    if (!deckId) {
      const res = await c.env.DB.prepare('INSERT INTO decks (name, created_at) VALUES (?, ?)')
        .bind(deck.name.trim(), now).run();
      deckId = res.meta.last_row_id;
    }
    const { results: existing } = await c.env.DB.prepare('SELECT front FROM cards WHERE deck_id = ?')
      .bind(deckId).all();
    const seen = new Set(existing.map((r) => r.front));
    const stmt = c.env.DB.prepare(
      'INSERT INTO cards (deck_id, front, back, tags, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const batch = [];
    for (const card of deck.cards) {
      const front = (card.front || '').trim();
      const back = (card.back || '').trim();
      if (!front || !back || seen.has(front)) { skipped++; continue; }
      seen.add(front);
      batch.push(stmt.bind(deckId, front, back, (card.tags || '').trim(), now));
    }
    // D1 batch limit safety: chunk at 100 statements
    for (let i = 0; i < batch.length; i += 100) {
      await c.env.DB.batch(batch.slice(i, i + 100));
    }
    imported += batch.length;
  }
  return c.json({ imported, skipped });
});

// ---- study ----

app.get('/api/decks/:id/study', async (c) => {
  const deckId = c.req.param('id');
  const now = Date.now();
  const dayStart = Number(c.req.query('dayStart') || 0);
  const newLimit = Math.max(0, Math.min(200, Number(c.req.query('newLimit') ?? 20)));

  const { results: dueCards } = await c.env.DB.prepare(
    `SELECT * FROM cards WHERE deck_id = ? AND state != 'new' AND due <= ?
     ORDER BY due LIMIT 200`
  ).bind(deckId, now).all();

  const introduced = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM cards WHERE deck_id = ? AND introduced_at >= ?'
  ).bind(deckId, dayStart).first();
  const remainingNew = Math.max(0, newLimit - (introduced?.n || 0));

  let newCards = [];
  if (remainingNew > 0) {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM cards WHERE deck_id = ? AND state = 'new' ORDER BY id LIMIT ?`
    ).bind(deckId, remainingNew).all();
    newCards = results;
  }

  // learning cards first, then reviews and new interleaved
  const learning = dueCards.filter((x) => x.state === 'learning' || x.state === 'relearning');
  const review = dueCards.filter((x) => x.state === 'review');
  const rest = [];
  const ratio = newCards.length ? Math.max(1, Math.floor(review.length / newCards.length)) : 0;
  let ni = 0;
  for (let i = 0; i < review.length; i++) {
    rest.push(review[i]);
    if (ratio && (i + 1) % ratio === 0 && ni < newCards.length) rest.push(newCards[ni++]);
  }
  while (ni < newCards.length) rest.push(newCards[ni++]);

  const cards = [...learning, ...rest].map((card) => ({ ...card, predictions: predictions(card, now) }));
  return c.json({ cards, counts: { learning: learning.length, review: review.length, new: newCards.length } });
});

app.post('/api/cards/:id/review', async (c) => {
  const { rating } = await c.req.json();
  if (![1, 2, 3, 4].includes(rating)) return c.json({ error: 'Invalid rating' }, 400);
  const card = await c.env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(c.req.param('id')).first();
  if (!card) return c.json({ error: 'Card not found' }, 404);

  const now = Date.now();
  const next = schedule(card, rating, now);
  const introducedAt = card.introduced_at ?? now;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE cards SET state = ?, due = ?, interval = ?, ease = ?, reps = ?, lapses = ?, step = ?, introduced_at = ?
       WHERE id = ?`
    ).bind(next.state, next.due, next.interval, next.ease, next.reps, next.lapses, next.step, introducedAt, card.id),
    c.env.DB.prepare('INSERT INTO reviews (card_id, rating, reviewed_at, interval) VALUES (?, ?, ?, ?)')
      .bind(card.id, rating, now, next.interval),
  ]);

  const updated = { ...card, ...next, introduced_at: introducedAt };
  return c.json({ card: { ...updated, predictions: predictions(updated, now) } });
});

// ---- stats ----

app.get('/api/stats', async (c) => {
  const dayStart = Number(c.req.query('dayStart') || 0);
  const weekStart = dayStart - 6 * 86_400_000;
  const today = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE reviewed_at >= ?')
    .bind(dayStart).first();
  const week = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE reviewed_at >= ?')
    .bind(weekStart).first();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM cards').first();
  return c.json({ reviewsToday: today?.n || 0, reviewsWeek: week?.n || 0, totalCards: total?.n || 0 });
});

export default app;
