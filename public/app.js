const $app = document.getElementById('app');

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
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localStorage.getItem('token') || ''}`,
      ...opts.headers,
    },
  });
  if (res.status === 401) {
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

function speak(html) {
  const text = stripHtml(html);
  if (!text || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('de'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices(); // warm up voice list

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
  $app.innerHTML = `
    <div class="login">
      <div class="logo">🃏</div>
      <h1>Flash</h1>
      <p class="notice">Enter your passphrase to unlock</p>
      <input id="pass" type="password" placeholder="Passphrase" autocomplete="current-password">
      <div id="err" class="error"></div>
      <button class="primary show-btn" id="go">Unlock</button>
    </div>`;
  const submit = async () => {
    try {
      const { token } = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ passphrase: document.getElementById('pass').value }),
      });
      localStorage.setItem('token', token);
      location.hash = '#decks';
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
  document.getElementById('go').onclick = submit;
  document.getElementById('pass').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  document.getElementById('pass').focus();
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
    ${topbar('Flash', { back: null, right: `<button class="iconbtn" id="import-btn" title="Import .apkg">⬆</button>` })}
    ${decks.length ? rows : '<p class="notice" style="text-align:center;margin-top:60px">No decks yet.<br>Import an .apkg file or create a deck below.</p>'}
    <div class="actions">
      <button id="new-deck">＋ New deck</button>
      <button id="import-btn2">Import .apkg</button>
    </div>
    <p class="statline">${stats.reviewsToday} reviews today · ${stats.reviewsWeek} this week · ${stats.totalCards} cards ·
      new/day <input id="nl" type="number" min="0" max="200" value="${newLimit()}" style="width:58px;padding:2px 6px;display:inline-block"></p>`;

  $app.querySelectorAll('.deck-row').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.deck-menu')) return;
      location.hash = `#study/${el.dataset.id}`;
    };
  });
  $app.querySelectorAll('.deck-menu').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      deckMenu(el.dataset.id, el.dataset.name);
    };
  });
  document.getElementById('new-deck').onclick = async () => {
    const name = prompt('Deck name');
    if (!name?.trim()) return;
    await api('/decks', { method: 'POST', body: JSON.stringify({ name }) });
    render();
  };
  document.getElementById('import-btn').onclick = () => { location.hash = '#import'; };
  document.getElementById('import-btn2').onclick = () => { location.hash = '#import'; };
  document.getElementById('nl').onchange = (e) => {
    localStorage.setItem('newLimit', e.target.value);
    render();
  };
}

async function deckMenu(id, name) {
  const choice = prompt(`Deck: ${name}\n\n1 = Browse cards\n2 = Add card\n3 = Rename\n4 = Delete deck\n\nEnter a number:`);
  if (choice === '1') location.hash = `#browse/${id}`;
  else if (choice === '2') location.hash = `#add/${id}`;
  else if (choice === '3') {
    const newName = prompt('New name', name);
    if (newName?.trim()) {
      await api(`/decks/${id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
      render();
    }
  } else if (choice === '4') {
    if (confirm(`Delete "${name}" and all its cards? This cannot be undone.`)) {
      await api(`/decks/${id}`, { method: 'DELETE' });
      render();
    }
  }
}

// ---------- study ----------

async function viewStudy(deckId) {
  $app.innerHTML = `${topbar('Study')}<p class="notice" style="text-align:center">Loading…</p>`;
  const [{ decks }, { cards }] = await Promise.all([
    api(`/decks?dayStart=${dayStart()}`),
    api(`/decks/${deckId}/study?dayStart=${dayStart()}&newLimit=${newLimit()}`),
  ]);
  const deckName = decks.find((d) => String(d.id) === String(deckId))?.name || 'Study';

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
          ${showingBack ? `<hr class="divider"><div class="card-back">${current.back}</div>` : ''}
          <button class="speak" id="speak" title="Pronounce">🔊</button>
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

    document.getElementById('speak').onclick = (e) => { e.stopPropagation(); speak(current.front); };
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

// ---------- import ----------

function loadImporter() {
  if (window.ApkgImporter) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/importer.js';
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
        <div class="actions"><button class="primary" id="doimport">Import selected</button></div>
        <div id="prog"></div>`;
      document.getElementById('doimport').onclick = async () => {
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
              body: JSON.stringify({ decks: [{ name: deck.name, cards: chunk }] }),
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
