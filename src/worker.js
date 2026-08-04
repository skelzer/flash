import { Hono } from 'hono';
import { schedule, predictions } from './scheduler.js';

const app = new Hono();
const DAY = 86_400_000;
const SESSION_DAYS = 180;
// upload sanity limits — protect the shared free-tier D1 daily budget from one
// runaway import; not announced in the UI, only enforced
const MAX_IMPORT_CARDS = 1000;    // per import request
const MAX_FIELD_LEN = 10_000;     // chars per card field
const MAX_CARDS_PER_USER = 50_000;
const TOO_MUCH = "Whoa, that's too much.";
// PBKDF2 iterations sized for the Workers free plan's 10ms CPU budget;
// raise if the account ever moves to the paid plan.
const PBKDF2_ITERATIONS = 25_000;

// ---- crypto helpers ----

const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
const randomHex = (n) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS },
    key, 256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function createSession(db, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now, now + SESSION_DAYS * DAY).run();
  return token;
}

// ---- auth routes ----

app.post('/api/register', async (c) => {
  const { username, password, invite } = await c.req.json();
  if (!c.env.APP_PASSPHRASE) return c.json({ error: 'Server invite code not configured' }, 500);
  if (invite !== c.env.APP_PASSPHRASE) return c.json({ error: 'Wrong invite code' }, 403);
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username || '')) {
    return c.json({ error: 'Username: 3–24 letters, digits, . _ -' }, 400);
  }
  if ((password || '').length < 8) return c.json({ error: 'Password needs at least 8 characters' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return c.json({ error: 'Username already taken' }, 409);

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const before = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const res = await c.env.DB.prepare(
    'INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)'
  ).bind(username, hash, salt, Date.now()).run();
  const userId = res.meta.last_row_id;

  // the very first account claims all pre-IAM decks
  if ((before?.n || 0) === 0) {
    await c.env.DB.prepare('UPDATE decks SET user_id = ? WHERE user_id IS NULL').bind(userId).run();
  }

  const token = await createSession(c.env.DB, userId);
  return c.json({ token, username });
});

app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username || '').first();
  // hash regardless so wrong-username and wrong-password take the same time
  const hash = await hashPassword(password || '', user?.salt || randomHex(16));
  if (!user || hash !== user.pass_hash) return c.json({ error: 'Wrong username or password' }, 401);
  const token = await createSession(c.env.DB, user.id);
  return c.json({ token, username: user.username });
});

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (path === '/api/login' || path === '/api/register') return next();
  const token = (c.req.header('authorization') || '').replace(/^Bearer /, '');
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const session = await c.env.DB.prepare(
    'SELECT s.token, s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
  if (!session || session.expires_at < Date.now()) {
    if (session) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('uid', session.user_id);
  c.set('token', token);
  return next();
});

app.post('/api/logout', async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(c.get('token')).run();
  return c.json({ ok: true });
});

// deck ownership guard: returns the deck row only if it belongs to the caller
async function ownDeck(c, deckId) {
  return c.env.DB.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?')
    .bind(deckId, c.get('uid')).first();
}

async function userCardCount(c) {
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM cards ca JOIN decks d ON d.id = ca.deck_id WHERE d.user_id = ?'
  ).bind(c.get('uid')).first();
  return row?.n || 0;
}

const fieldTooLong = (...fields) => fields.some((f) => (f || '').length > MAX_FIELD_LEN);

// card ownership guard via its deck
async function ownCard(c, cardId) {
  return c.env.DB.prepare(
    'SELECT ca.* FROM cards ca JOIN decks d ON d.id = ca.deck_id WHERE ca.id = ? AND d.user_id = ?'
  ).bind(cardId, c.get('uid')).first();
}

// ---- decks ----

app.get('/api/decks', async (c) => {
  const now = Date.now();
  const dayStart = Number(c.req.query('dayStart') || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.front_lang, d.back_lang,
       COUNT(c.id) AS total,
       SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END) AS newCount,
       SUM(CASE WHEN c.state != 'new' AND c.due <= ?1 THEN 1 ELSE 0 END) AS dueCount,
       SUM(CASE WHEN c.introduced_at >= ?2 THEN 1 ELSE 0 END) AS introducedToday
     FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
     WHERE d.user_id = ?3
     GROUP BY d.id ORDER BY d.name`
  ).bind(now, dayStart, c.get('uid')).all();
  return c.json({ decks: results });
});

app.post('/api/decks', async (c) => {
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: 'Name required' }, 400);
  const res = await c.env.DB.prepare('INSERT INTO decks (name, created_at, user_id) VALUES (?, ?, ?)')
    .bind(name.trim(), Date.now(), c.get('uid')).run();
  return c.json({ id: res.meta.last_row_id, name: name.trim() });
});

app.patch('/api/decks/:id', async (c) => {
  const body = await c.req.json();
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  const name = (body.name ?? deck.name).trim();
  const frontLang = body.front_lang ?? deck.front_lang;
  const backLang = body.back_lang ?? deck.back_lang;
  if (!name) return c.json({ error: 'Name required' }, 400);
  await c.env.DB.prepare('UPDATE decks SET name = ?, front_lang = ?, back_lang = ? WHERE id = ?')
    .bind(name, frontLang, backLang, deck.id).run();
  return c.json({ ok: true });
});

app.delete('/api/decks/:id', async (c) => {
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reviews WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?)').bind(deck.id),
    c.env.DB.prepare('DELETE FROM cards WHERE deck_id = ?').bind(deck.id),
    c.env.DB.prepare('DELETE FROM decks WHERE id = ?').bind(deck.id),
  ]);
  return c.json({ ok: true });
});

// ---- cards (browse / edit) ----

app.get('/api/decks/:id/cards', async (c) => {
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  const q = c.req.query('q') || '';
  const limit = Math.min(200, Number(c.req.query('limit') || 50));
  const offset = Number(c.req.query('offset') || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, front, back, tags, state, due, interval, reps, lapses FROM cards
     WHERE deck_id = ?1 AND (?2 = '' OR front LIKE ?3 OR back LIKE ?3 OR tags LIKE ?3)
     ORDER BY id DESC LIMIT ?4 OFFSET ?5`
  ).bind(deck.id, q, `%${q}%`, limit, offset).all();
  return c.json({ cards: results });
});

// full card list for the collocation map (no pagination, light columns)
app.get('/api/decks/:id/allcards', async (c) => {
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  const { results } = await c.env.DB.prepare(
    'SELECT id, front, back FROM cards WHERE deck_id = ? ORDER BY id'
  ).bind(deck.id).all();
  return c.json({ cards: results });
});

app.post('/api/decks/:id/cards', async (c) => {
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  const { front, back, tags = '' } = await c.req.json();
  if (!front?.trim() || !back?.trim()) return c.json({ error: 'Front and back required' }, 400);
  if (fieldTooLong(front, back, tags)) return c.json({ error: TOO_MUCH }, 413);
  if ((await userCardCount(c)) >= MAX_CARDS_PER_USER) return c.json({ error: TOO_MUCH }, 413);
  const res = await c.env.DB.prepare(
    'INSERT INTO cards (deck_id, front, back, tags, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(deck.id, front.trim(), back.trim(), tags.trim(), Date.now()).run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch('/api/cards/:id', async (c) => {
  const card = await ownCard(c, c.req.param('id'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  const { front, back, tags = '' } = await c.req.json();
  if (fieldTooLong(front, back, tags)) return c.json({ error: TOO_MUCH }, 413);
  await c.env.DB.prepare('UPDATE cards SET front = ?, back = ?, tags = ? WHERE id = ?')
    .bind(front.trim(), back.trim(), tags.trim(), card.id).run();
  return c.json({ ok: true });
});

app.delete('/api/cards/:id', async (c) => {
  const card = await ownCard(c, c.req.param('id'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reviews WHERE card_id = ?').bind(card.id),
    c.env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(card.id),
  ]);
  return c.json({ ok: true });
});

// ---- bulk import ----
// Body: { decks: [{ name, front_lang, back_lang, cards: [{ front, back, tags }] }] }
// Deck names are merged per user; duplicate fronts within a deck are skipped.

app.post('/api/import', async (c) => {
  const { decks } = await c.req.json();
  const uid = c.get('uid');
  const now = Date.now();
  const incoming = (decks || []).reduce((n, d) => n + (d.cards?.length || 0), 0);
  if (incoming > MAX_IMPORT_CARDS) return c.json({ error: TOO_MUCH }, 413);
  if ((await userCardCount(c)) + incoming > MAX_CARDS_PER_USER) return c.json({ error: TOO_MUCH }, 413);
  let imported = 0, skipped = 0;
  for (const deck of decks || []) {
    if (!deck.name?.trim() || !deck.cards?.length) continue;
    let row = await c.env.DB.prepare('SELECT id FROM decks WHERE name = ? AND user_id = ?')
      .bind(deck.name.trim(), uid).first();
    let deckId = row?.id;
    if (!deckId) {
      const res = await c.env.DB.prepare(
        'INSERT INTO decks (name, created_at, front_lang, back_lang, user_id) VALUES (?, ?, ?, ?, ?)'
      ).bind(deck.name.trim(), now, deck.front_lang || 'de-DE', deck.back_lang || '', uid).run();
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
      if (!front || !back || seen.has(front) || fieldTooLong(front, back, card.tags)) { skipped++; continue; }
      seen.add(front);
      batch.push(stmt.bind(deckId, front, back, (card.tags || '').trim(), now));
    }
    for (let i = 0; i < batch.length; i += 100) {
      await c.env.DB.batch(batch.slice(i, i + 100));
    }
    imported += batch.length;
  }
  return c.json({ imported, skipped });
});

// ---- study ----

app.get('/api/decks/:id/study', async (c) => {
  const deck = await ownDeck(c, c.req.param('id'));
  if (!deck) return c.json({ error: 'Deck not found' }, 404);
  const deckId = deck.id;
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
  const card = await ownCard(c, c.req.param('id'));
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

// ---- stats (all scoped to the caller's decks) ----

app.get('/api/stats', async (c) => {
  const uid = c.get('uid');
  const dayStart = Number(c.req.query('dayStart') || 0);
  const weekStart = dayStart - 6 * DAY;
  const scope = `FROM reviews r JOIN cards ca ON ca.id = r.card_id JOIN decks d ON d.id = ca.deck_id WHERE d.user_id = ?1`;
  const today = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${scope} AND r.reviewed_at >= ?2`).bind(uid, dayStart).first();
  const week = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${scope} AND r.reviewed_at >= ?2`).bind(uid, weekStart).first();
  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM cards ca JOIN decks d ON d.id = ca.deck_id WHERE d.user_id = ?'
  ).bind(uid).first();
  return c.json({ reviewsToday: today?.n || 0, reviewsWeek: week?.n || 0, totalCards: total?.n || 0 });
});

app.get('/api/stats/full', async (c) => {
  const uid = c.get('uid');
  const dayStart = Number(c.req.query('dayStart') || Date.now());
  const start30 = dayStart - 29 * DAY;
  const anchor = dayStart - 365 * DAY;
  const rScope = `FROM reviews r JOIN cards ca ON ca.id = r.card_id JOIN decks d ON d.id = ca.deck_id WHERE d.user_id = ?1`;
  const cScope = `FROM cards ca JOIN decks d ON d.id = ca.deck_id WHERE d.user_id = ?1`;

  const [perDayRows, forecastRows, stateRows, ratingRows, activeDayRows, cardTotal, reviewTotal] = await Promise.all([
    c.env.DB.prepare(
      `SELECT CAST((r.reviewed_at - ?2) / ${DAY} AS INTEGER) AS dy, COUNT(*) AS n
       ${rScope} AND r.reviewed_at >= ?2 GROUP BY dy`
    ).bind(uid, start30).all(),
    c.env.DB.prepare(
      `SELECT CAST(MAX(ca.due - ?2, 0) / ${DAY} AS INTEGER) AS dy, COUNT(*) AS n
       ${cScope} AND ca.state != 'new' AND ca.due < ?3 GROUP BY dy`
    ).bind(uid, dayStart, dayStart + 14 * DAY).all(),
    c.env.DB.prepare(`SELECT ca.state, COUNT(*) AS n ${cScope} GROUP BY ca.state`).bind(uid).all(),
    c.env.DB.prepare(
      `SELECT r.rating, COUNT(*) AS n ${rScope} AND r.reviewed_at >= ?2 GROUP BY r.rating`
    ).bind(uid, start30).all(),
    c.env.DB.prepare(
      `SELECT DISTINCT CAST((r.reviewed_at - ?2) / ${DAY} AS INTEGER) AS dy ${rScope} AND r.reviewed_at >= ?2`
    ).bind(uid, anchor).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${cScope}`).bind(uid).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${rScope}`).bind(uid).first(),
  ]);

  const perDay = Array(30).fill(0);
  for (const r of perDayRows.results) if (r.dy >= 0 && r.dy < 30) perDay[r.dy] = r.n;

  const forecast = Array(14).fill(0);
  for (const r of forecastRows.results) if (r.dy >= 0 && r.dy < 14) forecast[r.dy] = r.n;

  const states = { new: 0, learning: 0, review: 0, relearning: 0 };
  for (const r of stateRows.results) states[r.state] = r.n;

  const ratings = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of ratingRows.results) ratings[r.rating] = r.n;

  const active = new Set(activeDayRows.results.map((r) => r.dy));
  let streak = 0;
  const startDay = active.has(365) ? 365 : 364;
  while (active.has(startDay - streak)) streak++;

  return c.json({
    perDay, forecast, states, ratings, streak,
    totalCards: cardTotal?.n || 0, totalReviews: reviewTotal?.n || 0,
  });
});

// The app is served both at the workers.dev root and under luquematte.com/flash.
// Requests carrying the /flash prefix are rewritten to root paths, then either
// handled by the API or forwarded to the static assets.
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/flash') {
      url.pathname = '/flash/';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/flash/')) {
      url.pathname = url.pathname.slice('/flash'.length);
      request = new Request(url.toString(), request);
    }
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
