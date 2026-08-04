const $app = document.getElementById('app');

// Directory the app is served from: '/' on workers.dev, '/flash/' on the custom domain
const BASE = location.pathname.replace(/[^/]*$/, '');

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const stripHtml = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d.textContent || ''; };

// Anki-style day boundary at 4am local time
function dayStart() {
  const d = new Date();
  d.setHours(4, 0, 0, 0);
  if (Date.now() < d.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

const newLimit = () => Number(localStorage.getItem('newLimit') || 20);

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localStorage.getItem('token') || ''}`,
      ...opts.headers,
    },
  });
  if (res.status === 401 && path !== '/login' && path !== '/register') {
    localStorage.removeItem('token');
    location.hash = '#login';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const LANGS = [
  ['de-DE', 'German'], ['en-US', 'English'], ['es-ES', 'Spanish'], ['fr-FR', 'French'],
  ['it-IT', 'Italian'], ['pt-PT', 'Portuguese'], ['nl-NL', 'Dutch'], ['pl-PL', 'Polish'],
  ['ru-RU', 'Russian'], ['tr-TR', 'Turkish'], ['sv-SE', 'Swedish'], ['ja-JP', 'Japanese'],
  ['zh-CN', 'Chinese'], ['ko-KR', 'Korean'], ['', 'No speech'],
];

let voicesPromise;
function getVoicesAsync() {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  if (!voicesPromise) {
    voicesPromise = new Promise((resolve) => {
      speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
      setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    });
  }
  return voicesPromise;
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function speak(html, lang) {
  const text = stripHtml(html);
  if (!text || !lang || !('speechSynthesis' in window)) return;
  const voices = await getVoicesAsync();
  const target = lang.toLowerCase();
  const prefix = target.split('-')[0];
  const norm = (v) => v.lang.replace('_', '-').toLowerCase();
  // exact region match first, then any voice of that language
  const voice = voices.find((v) => norm(v) === target) || voices.find((v) => norm(v).startsWith(prefix));
  if (!voice) {
    // better silent than mispronounced by whatever the system default is
    const label = LANGS.find(([code]) => code === lang)?.[1] || lang;
    toast(`No ${label} voice installed on this device`);
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) getVoicesAsync(); // warm up voice list

function langSelect(id, selected) {
  return `<select id="${id}">
    ${LANGS.map(([code, label]) =>
      `<option value="${code}"${code === (selected || '') ? ' selected' : ''}>${label}</option>`).join('')}
  </select>`;
}

function topbar(title, { back = '#decks', right = '' } = {}) {
  return `<div class="topbar">
    ${back ? `<button class="iconbtn" onclick="location.hash='${back}'">←</button>` : ''}
    <h1>${esc(title)}</h1>${right}
  </div>`;
}

// ---------- router ----------

const routes = {
  login: viewLogin,
  decks: viewDecks,
  study: viewStudy,
  browse: viewBrowse,
  add: viewAdd,
  import: viewImport,
  deckset: viewDeckSettings,
  stats: viewStats,
  map: viewMap,
};

async function render() {
  const [name, ...args] = (location.hash.slice(1) || 'decks').split('/');
  if (name !== 'login' && !localStorage.getItem('token')) { location.hash = '#login'; return; }
  const view = routes[name] || viewDecks;
  try {
    await view(...args);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      $app.innerHTML = `${topbar('Flash')}<p class="error">${esc(err.message)}</p>
        <div class="actions"><button onclick="location.reload()">Reload</button></div>`;
    }
  }
}
window.addEventListener('hashchange', render);

// ---------- login ----------

function viewLogin() {
  let mode = 'login';
  const draw = () => {
    const registering = mode === 'register';
    $app.innerHTML = `
      <div class="login">
        <img class="logo" src="./wizard.gif" alt="Flash wizard" width="88" height="88">
        <h1>Flash</h1>
        <p class="notice">${registering ? 'Create your account' : 'Sign in to study'}</p>
        <input id="user" placeholder="Username" autocomplete="username" autocapitalize="none">
        <input id="pass" type="password" placeholder="Password"
          autocomplete="${registering ? 'new-password' : 'current-password'}">
        ${registering ? `<input id="invite" placeholder="Invite code">` : ''}
        <div id="err" class="error"></div>
        <button class="primary show-btn" id="go">${registering ? 'Create account' : 'Sign in'}</button>
        <button id="switch" style="background:none;color:var(--accent);font-weight:600">
          ${registering ? 'I already have an account' : 'New here? Create an account'}
        </button>
      </div>`;

    const submit = async () => {
      try {
        const body = {
          username: document.getElementById('user').value.trim(),
          password: document.getElementById('pass').value,
        };
        if (registering) body.invite = document.getElementById('invite').value.trim();
        const { token, username } = await api(registering ? '/register' : '/login', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        localStorage.setItem('token', token);
        localStorage.setItem('username', username);
        location.hash = '#decks';
      } catch (err) {
        document.getElementById('err').textContent = err.message;
      }
    };
    document.getElementById('go').onclick = submit;
    document.getElementById('switch').onclick = () => { mode = registering ? 'login' : 'register'; draw(); };
    $app.querySelectorAll('input').forEach((el) => {
      el.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
    document.getElementById('user').focus();
  };
  draw();
}

// ---------- decks ----------

async function viewDecks() {
  $app.innerHTML = `${topbar('Flash', { back: null })}<p class="notice" style="text-align:center">Loading…</p>`;
  const [{ decks }, stats] = await Promise.all([
    api(`/decks?dayStart=${dayStart()}`),
    api(`/stats?dayStart=${dayStart()}`),
  ]);

  const rows = decks.map((d) => {
    const newRemaining = Math.min(d.newCount || 0, Math.max(0, newLimit() - (d.introducedToday || 0)));
    const due = d.dueCount || 0;
    return `<button class="deck-row" data-id="${d.id}" data-name="${esc(d.name)}">
      <span class="name">${esc(d.name)}</span>
      <span class="counts">
        <span class="${newRemaining ? 'count-new' : 'count-zero'}">${newRemaining}</span>
        <span class="${due ? 'count-due' : 'count-zero'}">${due}</span>
      </span>
      <span class="iconbtn deck-menu" data-id="${d.id}" data-name="${esc(d.name)}">⋯</span>
    </button>`;
  }).join('');

  $app.innerHTML = `
    ${topbar('Flash', { back: null, right: `<button class="iconbtn" id="stats-btn" title="Statistics">📊</button>
      <button class="iconbtn" id="import-btn" title="Import .apkg">⬆</button>` })}
    ${decks.length ? rows : '<p class="notice" style="text-align:center;margin-top:60px">No decks yet.<br>Import an .apkg file or create a deck below.</p>'}
    <div class="actions">
      <button id="new-deck">＋ New deck</button>
      <button id="import-btn2">Import .apkg</button>
    </div>
    <p class="statline">${stats.reviewsToday} reviews today · ${stats.reviewsWeek} this week · ${stats.totalCards} cards ·
      new/day <input id="nl" type="number" min="0" max="200" value="${newLimit()}" style="width:58px;padding:2px 6px;display:inline-block"></p>
    <p class="statline">${esc(localStorage.getItem('username') || '')} ·
      <button id="signout" style="background:none;color:var(--muted);text-decoration:underline;font-size:13.5px;padding:0">Sign out</button></p>`;

  $app.querySelectorAll('.deck-row').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.deck-menu')) return;
      location.hash = `#study/${el.dataset.id}`;
    };
  });
  $app.querySelectorAll('.deck-menu').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      location.hash = `#deckset/${el.dataset.id}`;
    };
  });
  document.getElementById('new-deck').onclick = async () => {
    const name = prompt('Deck name');
    if (!name?.trim()) return;
    await api('/decks', { method: 'POST', body: JSON.stringify({ name }) });
    render();
  };
  document.getElementById('stats-btn').onclick = () => { location.hash = '#stats'; };
  document.getElementById('import-btn').onclick = () => { location.hash = '#import'; };
  document.getElementById('import-btn2').onclick = () => { location.hash = '#import'; };
  document.getElementById('nl').onchange = (e) => {
    localStorage.setItem('newLimit', e.target.value);
    render();
  };
  document.getElementById('signout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    location.hash = '#login';
  };
}

async function viewDeckSettings(deckId) {
  $app.innerHTML = `${topbar('Deck settings')}<p class="notice" style="text-align:center">Loading…</p>`;
  const { decks } = await api(`/decks?dayStart=${dayStart()}`);
  const deck = decks.find((d) => String(d.id) === String(deckId));
  if (!deck) { location.hash = '#decks'; return; }

  $app.innerHTML = `
    ${topbar('Deck settings')}
    <div class="form">
      <label>Name</label><input id="name" value="${esc(deck.name)}">
      <label>Front language (speech)</label>${langSelect('fl', deck.front_lang)}
      <label>Back language (speech)</label>${langSelect('bl', deck.back_lang)}
      <div class="actions"><button class="primary" id="save">Save</button></div>
      <div class="actions">
        <button onclick="location.hash='#browse/${deck.id}'">Browse cards</button>
        <button onclick="location.hash='#add/${deck.id}'">Add card</button>
      </div>
      <div class="actions"><button onclick="location.hash='#map/${deck.id}'">🕸 Collocation map</button></div>
      <div class="actions"><button id="del" style="color:var(--again)">Delete deck</button></div>
      <div id="err" class="error"></div>
    </div>`;

  document.getElementById('save').onclick = async () => {
    try {
      await api(`/decks/${deck.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('name').value,
          front_lang: document.getElementById('fl').value,
          back_lang: document.getElementById('bl').value,
        }),
      });
      location.hash = '#decks';
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm(`Delete "${deck.name}" and all its cards? This cannot be undone.`)) return;
    await api(`/decks/${deck.id}`, { method: 'DELETE' });
    location.hash = '#decks';
  };
}

// ---------- study ----------

async function viewStudy(deckId) {
  $app.innerHTML = `${topbar('Study')}<p class="notice" style="text-align:center">Loading…</p>`;
  const [{ decks }, { cards }] = await Promise.all([
    api(`/decks?dayStart=${dayStart()}`),
    api(`/decks/${deckId}/study?dayStart=${dayStart()}&newLimit=${newLimit()}`),
  ]);
  const deck = decks.find((d) => String(d.id) === String(deckId)) || {};
  const deckName = deck.name || 'Study';

  const queue = cards;
  let reviewed = 0;
  let current = null;
  let showingBack = false;

  const counts = () => {
    const learn = queue.filter((x) => x.state === 'learning' || x.state === 'relearning').length;
    const rev = queue.filter((x) => x.state === 'review').length;
    const nw = queue.filter((x) => x.state === 'new').length;
    return `<span class="pill-learn${learn ? '' : ' empty'}">${learn}</span>
            <span class="pill-due${rev ? '' : ' empty'}">${rev}</span>
            <span class="pill-new${nw ? '' : ' empty'}">${nw}</span>`;
  };

  function next() {
    showingBack = false;
    if (!queue.length) {
      $app.innerHTML = `${topbar(deckName)}
        <div class="done">
          <div class="big">🎉</div>
          <h2>Fertig!</h2>
          <p class="notice">${reviewed} card${reviewed === 1 ? '' : 's'} reviewed this session.</p>
          <div class="actions"><button class="primary" onclick="location.hash='#decks'">Back to decks</button></div>
        </div>`;
      return;
    }
    current = queue.shift();
    draw();
  }

  function draw() {
    const p = current.predictions || {};
    $app.innerHTML = `
      ${topbar(deckName, { right: counts() })}
      <div class="study">
        <div class="card-area${showingBack ? '' : ' clickable'}" id="card">
          <div class="card-front">${current.front}</div>
          ${deck.front_lang ? `<button class="speak" id="speak-f" title="Pronounce">🔊</button>` : ''}
          ${showingBack ? `<hr class="divider"><div class="card-back">${current.back}</div>
            ${deck.back_lang ? `<button class="speak" id="speak-b" title="Pronounce">🔊</button>` : ''}` : ''}
        </div>
        ${showingBack
          ? `<div class="ratings">
              <button class="r1" data-r="1">Again<small>${p[1] || ''}</small></button>
              <button class="r2" data-r="2">Hard<small>${p[2] || ''}</small></button>
              <button class="r3" data-r="3">Good<small>${p[3] || ''}</small></button>
              <button class="r4" data-r="4">Easy<small>${p[4] || ''}</small></button>
            </div>`
          : `<button class="show-btn primary" id="show">Show answer</button>`}
      </div>`;

    const speakF = document.getElementById('speak-f');
    if (speakF) speakF.onclick = (e) => { e.stopPropagation(); speak(current.front, deck.front_lang); };
    const speakB = document.getElementById('speak-b');
    if (speakB) speakB.onclick = (e) => { e.stopPropagation(); speak(current.back, deck.back_lang); };
    if (showingBack) {
      $app.querySelectorAll('.ratings button').forEach((b) => { b.onclick = () => rate(Number(b.dataset.r)); });
    } else {
      document.getElementById('show').onclick = reveal;
      document.getElementById('card').onclick = reveal;
    }
  }

  function reveal() {
    showingBack = true;
    draw();
  }

  async function rate(rating) {
    reviewed++;
    const id = current.id;
    showingBack = false;
    try {
      const { card } = await api(`/cards/${id}/review`, { method: 'POST', body: JSON.stringify({ rating }) });
      // re-queue cards that come back within this session (learning steps)
      if (card.due <= Date.now() + 20 * 60 * 1000) {
        queue.splice(Math.min(queue.length, 3), 0, card);
      }
    } catch (err) {
      alert(`Failed to save review: ${err.message}`);
      queue.unshift(current);
    }
    next();
  }

  const keyHandler = (e) => {
    if (!location.hash.startsWith('#study')) { window.removeEventListener('keydown', keyHandler); return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!showingBack && current) reveal(); }
    if (showingBack && ['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key));
  };
  window.addEventListener('keydown', keyHandler);

  next();
}

// ---------- browse ----------

async function viewBrowse(deckId) {
  let q = '';
  async function load() {
    const { cards } = await api(`/decks/${deckId}/cards?q=${encodeURIComponent(q)}&limit=100`);
    document.getElementById('list').innerHTML = cards.map((c) => `
      <button class="card-item" data-id="${c.id}">
        <div class="f">${c.front}</div>
        <div class="b">${esc(stripHtml(c.back))}</div>
        <div class="meta">${c.state} · ${c.reps} reps${c.lapses ? ` · ${c.lapses} lapses` : ''}</div>
      </button>`).join('') || '<p class="notice" style="text-align:center">No cards found.</p>';
    document.querySelectorAll('.card-item').forEach((el) => {
      el.onclick = () => {
        const card = cards.find((x) => String(x.id) === el.dataset.id);
        editCard(card);
      };
    });
  }
  $app.innerHTML = `
    ${topbar('Browse', { right: `<button class="iconbtn" onclick="location.hash='#add/${esc(deckId)}'">＋</button>` })}
    <input id="search" type="search" placeholder="Search cards…" style="margin-bottom:10px">
    <div id="list"><p class="notice" style="text-align:center">Loading…</p></div>`;
  document.getElementById('search').oninput = (e) => {
    q = e.target.value;
    clearTimeout(viewBrowse._t);
    viewBrowse._t = setTimeout(load, 250);
  };
  await load();
}

function editCard(card) {
  $app.innerHTML = `
    ${topbar('Edit card', { back: null })}
    <div class="form">
      <label>Front</label><textarea id="f">${esc(card.front)}</textarea>
      <label>Back</label><textarea id="b">${esc(card.back)}</textarea>
      <label>Tags</label><input id="t" value="${esc(card.tags)}">
      <div class="actions">
        <button id="cancel">Cancel</button>
        <button id="del" style="color:var(--again)">Delete</button>
        <button class="primary" id="save">Save</button>
      </div>
    </div>`;
  // the hash is still #browse/:id, so re-rendering returns to the browse list
  document.getElementById('cancel').onclick = () => render();
  document.getElementById('save').onclick = async () => {
    await api(`/cards/${card.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        front: document.getElementById('f').value,
        back: document.getElementById('b').value,
        tags: document.getElementById('t').value,
      }),
    });
    render();
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('Delete this card?')) return;
    await api(`/cards/${card.id}`, { method: 'DELETE' });
    render();
  };
}

// ---------- add card ----------

async function viewAdd(deckId) {
  $app.innerHTML = `
    ${topbar('Add card', { back: `#browse/${esc(deckId)}` })}
    <div class="form">
      <label>Front (German)</label><textarea id="f" placeholder="das Fahrrad"></textarea>
      <label>Back</label><textarea id="b" placeholder="the bicycle"></textarea>
      <label>Tags (optional)</label><input id="t">
      <div id="err" class="error"></div>
      <div class="actions"><button class="primary" id="save">Add card</button></div>
    </div>`;
  document.getElementById('f').focus();
  document.getElementById('save').onclick = async () => {
    try {
      await api(`/decks/${deckId}/cards`, {
        method: 'POST',
        body: JSON.stringify({
          front: document.getElementById('f').value,
          back: document.getElementById('b').value,
          tags: document.getElementById('t').value,
        }),
      });
      document.getElementById('f').value = '';
      document.getElementById('b').value = '';
      document.getElementById('err').textContent = '';
      document.getElementById('f').focus();
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
}

// ---------- stats ----------

// Rounded-top bar chart as inline SVG; single hue, tooltip per bar.
function barChartSVG(values, { tipLabel }) {
  const W = 340, H = 110, PAD_TOP = 14, PAD_BOT = 16;
  const plotH = H - PAD_TOP - PAD_BOT;
  const max = Math.max(1, ...values);
  const n = values.length;
  const gap = 2;
  const bw = (W - gap * (n - 1)) / n;
  const r = Math.min(3, bw / 2);

  const bars = values.map((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (v / max) * plotH);
    const x = i * (bw + gap);
    const y = PAD_TOP + plotH - h;
    if (!h) return `<g data-i="${i}"><rect class="hit" x="${x}" y="${PAD_TOP}" width="${bw}" height="${plotH}" fill="transparent"/></g>`;
    // rounded top corners only, anchored to the baseline
    const path = `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${y + h} Z`;
    return `<g data-i="${i}">
      <path d="${path}" fill="var(--accent)"/>
      <rect class="hit" x="${x}" y="${PAD_TOP}" width="${bw}" height="${plotH}" fill="transparent"/>
    </g>`;
  }).join('');

  const mid = PAD_TOP + plotH / 2;
  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" data-tip="${esc(tipLabel)}">
      <line x1="0" y1="${PAD_TOP}" x2="${W}" y2="${PAD_TOP}" class="grid"/>
      <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" class="grid"/>
      <line x1="0" y1="${PAD_TOP + plotH}" x2="${W}" y2="${PAD_TOP + plotH}" class="grid strong"/>
      <text x="${W}" y="${PAD_TOP - 4}" class="axis" text-anchor="end">${max}</text>
      ${bars}
    </svg>
    <div class="charttip" hidden></div>
  </div>`;
}

function attachBarTips(container, values, labelFor) {
  container.querySelectorAll('.chart-wrap').forEach((wrap, w) => {
    const tip = wrap.querySelector('.charttip');
    const svg = wrap.querySelector('svg');
    const show = (g) => {
      const i = Number(g.dataset.i);
      tip.textContent = labelFor(w, i, values[w][i]);
      tip.hidden = false;
      const gRect = g.getBoundingClientRect();
      const wRect = wrap.getBoundingClientRect();
      const x = Math.min(Math.max(gRect.x - wRect.x + gRect.width / 2, 44), wRect.width - 44);
      tip.style.left = `${x}px`;
    };
    svg.addEventListener('pointerover', (e) => { const g = e.target.closest('g[data-i]'); if (g) show(g); });
    svg.addEventListener('pointerdown', (e) => { const g = e.target.closest('g[data-i]'); if (g) show(g); });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

async function viewStats() {
  $app.innerHTML = `${topbar('Statistics')}<p class="notice" style="text-align:center">Loading…</p>`;
  const s = await api(`/stats/full?dayStart=${dayStart()}`);

  const ratingTotal = s.ratings[1] + s.ratings[2] + s.ratings[3] + s.ratings[4];
  const correctPct = ratingTotal ? Math.round(((ratingTotal - s.ratings[1]) / ratingTotal) * 100) : null;

  const tiles = `
    <div class="tiles">
      <div class="tile"><div class="tile-n">${s.streak}<span class="tile-unit">d</span></div><div class="tile-l">🔥 Streak</div></div>
      <div class="tile"><div class="tile-n">${s.perDay[29]}</div><div class="tile-l">Reviews today</div></div>
      <div class="tile"><div class="tile-n">${correctPct === null ? '–' : correctPct + '%'}</div><div class="tile-l">Correct · 30d</div></div>
      <div class="tile"><div class="tile-n">${s.totalCards}</div><div class="tile-l">Cards</div></div>
    </div>`;

  const RATING_META = [
    [1, 'Again', 'var(--again)'], [2, 'Hard', 'var(--hard)'],
    [3, 'Good', 'var(--good)'], [4, 'Easy', 'var(--easy)'],
  ];
  const maxRating = Math.max(1, ...RATING_META.map(([k]) => s.ratings[k]));
  const ratingRows = RATING_META.map(([k, label, color]) => `
    <div class="rrow">
      <span class="rlabel">${label}</span>
      <span class="rbar-track"><span class="rbar" style="width:${(s.ratings[k] / maxRating) * 100}%;background:${color}"></span></span>
      <span class="rcount">${s.ratings[k]}</span>
    </div>`).join('');

  const learning = s.states.learning + s.states.relearning;
  const STATE_META = [
    ['New', s.states.new, 'var(--easy)'],
    ['Learning', learning, 'var(--hard)'],
    ['Review', s.states.review, 'var(--good)'],
  ];
  const stackSegs = STATE_META.filter(([, n]) => n > 0).map(([label, n, color]) =>
    `<span class="seg" style="flex:${n};background:${color}" title="${label}"></span>`).join('');
  const stateChips = STATE_META.map(([label, n, color]) =>
    `<span class="chip"><span class="dot" style="background:${color}"></span>${label} <b>${n}</b></span>`).join('');

  $app.innerHTML = `
    ${topbar('Statistics')}
    ${tiles}
    <div class="panel">
      <h3>Reviews · last 30 days</h3>
      ${s.perDay.some((v) => v) ? barChartSVG(s.perDay, { tipLabel: 'reviews' }) : '<p class="notice">No reviews yet.</p>'}
      <div class="xlabels"><span>30 days ago</span><span>today</span></div>
    </div>
    <div class="panel">
      <h3>Due cards · next 14 days</h3>
      ${s.forecast.some((v) => v) ? barChartSVG(s.forecast, { tipLabel: 'due' }) : '<p class="notice">Nothing scheduled yet.</p>'}
      <div class="xlabels"><span>today</span><span>in 14 days</span></div>
    </div>
    <div class="panel">
      <h3>Answers · last 30 days</h3>
      ${ratingTotal ? ratingRows : '<p class="notice">No reviews yet.</p>'}
    </div>
    <div class="panel">
      <h3>Card states</h3>
      ${s.totalCards ? `<div class="stack">${stackSegs}</div><div class="chips">${stateChips}</div>` : '<p class="notice">No cards yet.</p>'}
    </div>
    <p class="statline">${s.totalReviews} reviews all time</p>`;

  const dayName = (offset) => {
    const d = new Date(dayStart() + offset * 86_400_000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  attachBarTips($app, [s.perDay, s.forecast], (w, i, v) =>
    w === 0 ? `${dayName(i - 29)} · ${v} reviews` : `${dayName(i)} · ${v} due`);
}

// ---------- collocation map ----------

// Capitalized German words that are not nouns (articles, pronouns, sentence starters)
const DE_STOPWORDS = new Set([
  'Der', 'Die', 'Das', 'Den', 'Dem', 'Des', 'Ein', 'Eine', 'Einen', 'Einem', 'Einer', 'Eines',
  'Ich', 'Du', 'Er', 'Sie', 'Es', 'Wir', 'Ihr', 'Man', 'Sich', 'Mein', 'Dein', 'Sein', 'Ihre', 'Ihren',
  'Als', 'Wie', 'Wo', 'Was', 'Wer', 'Wenn', 'Dass', 'Ob', 'Und', 'Oder', 'Aber', 'Auch', 'Noch',
  'Nicht', 'Kein', 'Keine', 'Keinen', 'Etwas', 'Alles', 'Nichts', 'Jemand', 'Jemanden', 'Jemandem',
  'Zu', 'Im', 'In', 'Am', 'An', 'Auf', 'Aus', 'Bei', 'Mit', 'Nach', 'Von', 'Vor', 'Für', 'Um',
  'Über', 'Unter', 'Durch', 'Gegen', 'Ohne', 'Bis', 'Beim', 'Zum', 'Zur', 'Vom', 'Ins', 'Ans',
  'Es', 'Man', 'Hier', 'Da', 'Dort', 'Heute', 'Morgen', 'Gestern', 'Sehr', 'So', 'Nur', 'Schon',
]);

// Articles/determiners that reveal gender when they directly precede the noun.
// Ambiguous ones (ein, dem, einem, ...) are recognized for stripping but cast no vote.
const ARTICLE_GENDER = {
  der: 'm', den: 'm', einen: 'm', diesen: 'm', jeden: 'm',
  die: 'f', eine: 'f', einer: 'f', keine: 'f', diese: 'f', jede: 'f', zur: 'f',
  das: 'n', dieses: 'n', jedes: 'n',
};
const ARTICLE_AMBIGUOUS = new Set(['ein', 'dem', 'des', 'einem', 'eines', 'keinen', 'zum', 'vom', 'beim', 'im', 'ins', 'ans', 'meine', 'seinen', 'ihre', 'ihren']);

// Reliable German gender suffixes, used only when no article votes exist
function suffixGender(noun) {
  if (/(ung|heit|keit|schaft|ion|tät|enz|ei|ik|ur)$/.test(noun)) return 'f';
  if (/(chen|lein|ment|um)$/.test(noun)) return 'n';
  if (/(ling|ismus|ant|ist|or)$/.test(noun)) return 'm';
  return null;
}

const GENDER_META = { m: { article: 'der', color: 'var(--g-m)' }, f: { article: 'die', color: 'var(--g-f)' }, n: { article: 'das', color: 'var(--g-n)' } };

// Map each noun to a base form that also occurs in the deck (Ziele -> Ziel,
// Entscheidungen -> Entscheidung, Häuser -> Haus). Merging only happens when the
// base form is itself present, which keeps false merges out.
function canonicalNoun(word, allNouns) {
  const deUmlaut = (s) => s.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U');
  let current = word;
  for (let hop = 0; hop < 3; hop++) {  // resolve chains like Entscheidungen -> Entscheidung
    let next = null;
    for (const suf of ['nen', 'en', 'er', 'e', 'n', 's']) {
      if (current.length - suf.length < 3 || !current.endsWith(suf)) continue;
      const stem = current.slice(0, -suf.length);
      if (allNouns.has(stem)) { next = stem; break; }
      if ((suf === 'er' || suf === 'e') && allNouns.has(deUmlaut(stem))) { next = deUmlaut(stem); break; }
    }
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

// Group cards by shared capitalized German nouns. Returns [{noun, items}] sorted by size.
function buildNexuses(cards, germanSide, otherSide) {
  const byNoun = new Map();
  for (const card of cards) {
    const german = stripHtml(card[germanSide]).trim();
    const other = stripHtml(card[otherSide]).trim();
    if (!german) continue;
    const tokens = german.match(/[A-Za-zÄÖÜäöüß]+/g) || [];
    const nouns = new Set(tokens.filter((t) => /^[A-ZÄÖÜ]/.test(t) && t.length > 2 && !DE_STOPWORDS.has(t)));
    for (const noun of nouns) {
      if (!byNoun.has(noun)) byNoun.set(noun, []);
      // capture the word right before the noun: strip it if it's an article,
      // and remember it as a gender clue
      const m = german.match(new RegExp(`(?:\\b([A-Za-zÄÖÜäöüß]+)\\s+)?${noun}(?=$|[^A-Za-zÄÖÜäöüß])`));
      const prev = (m?.[1] || '').toLowerCase();
      const isArticle = prev in ARTICLE_GENDER || ARTICLE_AMBIGUOUS.has(prev);
      // drop the article+noun entirely at the start of the phrase ("eine
      // Entscheidung treffen" -> "treffen"); mid-phrase keep a placeholder so
      // the grammar stays readable ("sich an den Plan halten" -> "sich an ~ halten")
      const keepPrefix = isArticle ? '' : (m[1] ? m[1] + ' ' : '');
      const atStart = m.index === 0 && (!m[1] || isArticle);
      const short = german.replace(m[0], atStart ? keepPrefix : `${keepPrefix}~`)
        .replace(/\s+/g, ' ').trim() || '~';
      byNoun.get(noun).push({
        id: card.id, phrase: german, other, variant: noun, short,
        articleWord: isArticle ? prev : null,
      });
    }
  }

  // fold plural/inflected forms into their base noun when the base occurs too
  const allNouns = new Set(byNoun.keys());
  const merged = new Map();
  for (const [noun, items] of byNoun) {
    const base = canonicalNoun(noun, allNouns);
    if (!merged.has(base)) merged.set(base, []);
    merged.get(base).push(...items);
  }

  return [...merged.entries()]
    .map(([noun, items]) => {
      const seen = new Set();
      const unique = items.filter((it) => !seen.has(it.id) && seen.add(it.id));
      // majority vote over article clues; "die" only counts on the singular form
      // (before a plural it says nothing about gender)
      const votes = { m: 0, f: 0, n: 0 };
      for (const it of unique) {
        const w = it.articleWord;
        if (!w || !(w in ARTICLE_GENDER)) continue;
        if (w === 'die' && it.variant !== noun) continue;
        votes[ARTICLE_GENDER[w]]++;
      }
      const best = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      let gender = best[0][1] > 0 && best[0][1] > best[1][1] ? best[0][0] : null;
      if (!gender) gender = suffixGender(noun);
      return { noun, gender, items: unique };
    })
    .filter(({ items }) => items.length >= 2)
    .sort((a, b) => b.items.length - a.items.length || a.noun.localeCompare(b.noun));
}

function renderRadial(container, noun, items, gender) {
  const MAX_LEAVES = 18;
  const leaves = items.slice(0, MAX_LEAVES);
  const n = leaves.length;
  const height = Math.max(320, Math.min(600, 200 + n * 28));
  const meta = GENDER_META[gender];
  const nexusLabel = meta ? `${meta.article} ${noun}` : noun;
  container.innerHTML = `<div class="mindmap" style="height:${height}px">
    <svg class="mmlines"></svg>
    <div class="mmleaf mmnexus"${meta ? ` style="background:${meta.color}"` : ''}>${esc(nexusLabel)}</div>
    ${leaves.map((it, i) =>
      `<div class="mmleaf" data-i="${i}" data-de="${esc(it.short)}" data-en="${esc(it.other)}">${esc(it.short)}</div>`
    ).join('')}
  </div>
  ${items.length > n ? `<p class="notice" style="text-align:center">+${items.length - n} more not shown</p>` : ''}
  <div class="chips" style="justify-content:center;margin-top:8px">
    <span class="chip"><span class="dot" style="background:var(--g-m)"></span>der</span>
    <span class="chip"><span class="dot" style="background:var(--g-f)"></span>die</span>
    <span class="chip"><span class="dot" style="background:var(--g-n)"></span>das</span>
  </div>
  <p class="notice" style="text-align:center">Tap a phrase to see its translation.</p>`;

  const map = container.querySelector('.mindmap');
  const svg = container.querySelector('.mmlines');
  const layout = () => {
    const w = map.clientWidth, h = map.clientHeight;
    const cx = w / 2, cy = h / 2;
    const rx = Math.min(w / 2 - 78, 90 + n * 6);
    const ry = Math.min(h / 2 - 34, 70 + n * 12);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    let lines = '';
    map.querySelectorAll('.mmleaf:not(.mmnexus)').forEach((el) => {
      const i = Number(el.dataset.i);
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const x = cx + rx * Math.cos(a);
      const y = cy + ry * Math.sin(a);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      lines += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
    });
    svg.innerHTML = lines;
  };
  layout();

  map.addEventListener('click', (e) => {
    const leaf = e.target.closest('.mmleaf:not(.mmnexus)');
    if (!leaf) return;
    const flipped = leaf.classList.toggle('flipped');
    leaf.textContent = flipped ? (leaf.dataset.en || '—') : leaf.dataset.de;
  });
}

async function viewMap(deckId) {
  $app.innerHTML = `${topbar('Collocations', { back: `#deckset/${esc(deckId)}` })}<p class="notice" style="text-align:center">Loading…</p>`;
  const [{ decks }, { cards }] = await Promise.all([
    api(`/decks?dayStart=${dayStart()}`),
    api(`/decks/${deckId}/allcards`),
  ]);
  const deck = decks.find((d) => String(d.id) === String(deckId)) || {};
  const germanSide = (deck.front_lang || '').startsWith('de') ? 'front' : 'back';
  const otherSide = germanSide === 'front' ? 'back' : 'front';
  const nexuses = buildNexuses(cards, germanSide, otherSide);

  if (!nexuses.length) {
    $app.innerHTML = `${topbar('Collocations', { back: `#deckset/${esc(deckId)}` })}
      <p class="notice" style="text-align:center;margin-top:60px">
        No shared nouns found in this deck yet.<br>
        The map appears once several cards use the same noun<br>(e.g. „eine Entscheidung treffen“ / „eine Entscheidung umsetzen“).
      </p>`;
    return;
  }

  $app.innerHTML = `
    ${topbar(`Collocations · ${deck.name || ''}`, { back: `#deckset/${esc(deckId)}` })}
    <div class="chips" id="nexus-chips" style="margin-bottom:12px">
      ${nexuses.map((x, i) => {
        const meta = GENDER_META[x.gender];
        return `<button class="nexus-chip" data-i="${i}">
          ${meta ? `<span class="dot" style="background:${meta.color}"></span>` : ''}${esc(x.noun)} <b>${x.items.length}</b></button>`;
      }).join('')}
    </div>
    <div id="mapbox"></div>`;

  const chips = $app.querySelectorAll('.nexus-chip');
  const select = (i) => {
    chips.forEach((ch) => ch.classList.toggle('active', Number(ch.dataset.i) === i));
    renderRadial(document.getElementById('mapbox'), nexuses[i].noun, nexuses[i].items, nexuses[i].gender);
  };
  chips.forEach((ch) => { ch.onclick = () => select(Number(ch.dataset.i)); });
  select(0);
}

// ---------- import ----------

function loadImporter() {
  if (window.ApkgImporter) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${BASE}importer.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load importer'));
    document.head.appendChild(s);
  });
}

async function viewImport() {
  $app.innerHTML = `
    ${topbar('Import .apkg')}
    <p class="notice">Export from Anki via File → Export, format “Anki Deck Package (.apkg)”.
    Text is imported; images and audio are skipped.</p>
    <input id="file" type="file" accept=".apkg,.colpkg" hidden>
    <button class="filebtn" id="pick">Tap to choose an .apkg file</button>
    <div id="out"></div>`;
  const fileInput = document.getElementById('file');
  document.getElementById('pick').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const out = document.getElementById('out');
    out.innerHTML = '<p class="notice">Parsing… (this can take a moment for big decks)</p>';
    try {
      await loadImporter();
      const decks = await window.ApkgImporter.parseApkg(file);
      if (!decks.length) throw new Error('No usable cards found in this file.');
      out.innerHTML = `
        ${decks.map((d, i) => `
          <div class="import-deck">
            <input type="checkbox" id="dk${i}" checked>
            <span class="name">${esc(d.name)}</span>
            <span class="pill">${d.cards.length}</span>
          </div>`).join('')}
        <div class="form" style="margin-bottom:10px">
          <label>Front language (speech)</label>${langSelect('imp-fl', 'en-US')}
          <label>Back language (speech)</label>${langSelect('imp-bl', 'de-DE')}
        </div>
        <div class="actions"><button class="primary" id="doimport">Import selected</button></div>
        <div id="prog"></div>`;
      document.getElementById('doimport').onclick = async () => {
        const frontLang = document.getElementById('imp-fl').value;
        const backLang = document.getElementById('imp-bl').value;
        const chosen = decks.filter((_, i) => document.getElementById(`dk${i}`).checked);
        const totalCards = chosen.reduce((n, d) => n + d.cards.length, 0);
        const prog = document.getElementById('prog');
        let sent = 0, imported = 0, skipped = 0;
        prog.innerHTML = `<progress max="${totalCards}" value="0"></progress><p class="notice" id="pt">Importing…</p>`;
        for (const deck of chosen) {
          for (let i = 0; i < deck.cards.length; i += 500) {
            const chunk = deck.cards.slice(i, i + 500);
            const res = await api('/import', {
              method: 'POST',
              body: JSON.stringify({ decks: [{ name: deck.name, front_lang: frontLang, back_lang: backLang, cards: chunk }] }),
            });
            imported += res.imported;
            skipped += res.skipped;
            sent += chunk.length;
            prog.querySelector('progress').value = sent;
            document.getElementById('pt').textContent = `${sent}/${totalCards} processed…`;
          }
        }
        prog.innerHTML = `<p class="notice">✅ Imported ${imported} cards${skipped ? ` (${skipped} duplicates/empty skipped)` : ''}.</p>
          <div class="actions"><button class="primary" onclick="location.hash='#decks'">Go to decks</button></div>`;
      };
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  };
}

render();
