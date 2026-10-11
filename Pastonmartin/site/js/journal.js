// Ansicht "Tagebuch": jede Wette festhalten und ehrlich auswerten.
//
// Gespeichert wird in Cloudflare D1 (über /api/bets), damit Handy und Computer
// dasselbe Tagebuch sehen. Ist D1 nicht eingerichtet, landet alles im Browser
// (localStorage) und ist dann nur auf diesem Gerät.
import { signedPct, num, chf, parseOdds, esc, store } from './util.js';

const view = document.getElementById('view-journal');
let mode = null;          // 'cloud' | 'local' | 'locked'
let bets = [];
let results = {};         // match_id -> Resultat (aus results.json)

export async function initJournal(resultsData) {
  for (const r of resultsData?.results || []) results[r.id] = r;
  view.addEventListener('click', onClick);
  view.addEventListener('submit', onSubmit);
  await loadBets();
  await settleFinished();
  render();
}

// --- Speichern & Laden -------------------------------------------------------
function request(method, body, query = '') {
  return fetch('/api/bets' + query, {
    method,
    headers: { 'content-type': 'application/json', 'x-journal-key': store.get('journalKey', '') },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function loadBets() {
  try {
    const response = await request('GET');
    const isJson = (response.headers.get('content-type') || '').includes('json');
    if (response.status === 401) { mode = 'locked'; bets = []; return; }
    if (response.ok && isJson) { mode = 'cloud'; bets = (await response.json()).bets; return; }
  } catch { /* keine Verbindung oder keine Function -> lokal */ }
  mode = 'local';
  bets = store.get('bets', []);
}

async function save(bet) {
  if (mode === 'cloud') {
    const response = await request('PUT', bet);
    if (!response.ok) throw new Error(`Speichern fehlgeschlagen (${response.status})`);
  }
  bets = [bet, ...bets.filter(b => b.id !== bet.id)];
  if (mode === 'local') store.set('bets', bets);
}

async function remove(id) {
  if (mode === 'cloud') {
    const response = await request('DELETE', null, `?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Löschen fehlgeschlagen (${response.status})`);
  }
  bets = bets.filter(b => b.id !== id);
  if (mode === 'local') store.set('bets', bets);
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// Wird von der Tipps-Ansicht aufgerufen
export async function addBet(bet) {
  if (!mode) await loadBets();
  if (mode === 'locked') throw new Error('Tagebuch ist gesperrt, zuerst Schlüssel eingeben');
  await save({ id: newId(), created: new Date().toISOString(), status: 'open', ...bet });
  render();
}

// --- Abrechnen -----------------------------------------------------------------
function didWin(selection, r) {
  const goals = r.hg + r.ag;
  return { H: r.hg > r.ag, D: r.hg === r.ag, A: r.hg < r.ag, O: goals >= 3, U: goals <= 2 }[selection];
}

// Offene Wetten, deren Spiel in results.json steht, automatisch abrechnen und speichern.
async function settleFinished() {
  for (const bet of bets.filter(b => b.status === 'open' && results[b.match_id])) {
    const r = results[bet.match_id];
    const settled = { ...bet, status: didWin(bet.selection, r) ? 'won' : 'lost', score: `${r.hg}:${r.ag}` };
    const fairClose = r.closing_fair?.[bet.selection];
    // CLV: Quote, die du bekommen hast, gegen die faire Schlussquote des Marktes
    if (fairClose) settled.clv = bet.odds * fairClose - 1;
    try { await save(settled); } catch (error) { console.error(error); }
  }
}

function profitOf(bet) {
  if (bet.status === 'won') return bet.stake * (bet.odds - 1);
  if (bet.status === 'lost') return -bet.stake;
  return 0;
}

// --- Anzeige -------------------------------------------------------------------
function render() {
  if (mode === 'locked') {
    view.innerHTML = `<div class="card">
      <p>Das Tagebuch ist mit einem Schlüssel geschützt.</p>
      <form id="key-form" class="toolbar"><input name="key" type="password" placeholder="Schlüssel" autocomplete="current-password">
      <button class="primary">Öffnen</button></form></div>`;
    return;
  }

  const done = bets.filter(b => b.status === 'won' || b.status === 'lost');
  const staked = done.reduce((s, b) => s + b.stake, 0);
  const profit = done.reduce((s, b) => s + profitOf(b), 0);
  const withClv = bets.filter(b => b.clv != null);
  const withFair = bets.filter(b => b.fair);
  const avg = (list, f) => list.length ? list.reduce((s, b) => s + f(b), 0) / list.length : null;
  const openCount = bets.length - done.length;

  const tiles = [
    ['Wetten', `${done.length}${openCount ? ` <span class="small muted">+${openCount} offen</span>` : ''}`],
    ['Einsatz', chf(staked)],
    ['Gewinn', `<span class="${profit >= 0 ? 'status-won' : 'status-lost'}">${profit >= 0 ? '+' : '−'}${chf(Math.abs(profit))}</span>`],
    ['Rendite', staked ? signedPct(profit / staked) : '–'],
    ['Ø CLV', withClv.length ? signedPct(avg(withClv, b => b.clv)) : '–'],
    ['Ø erwarteter Value', withFair.length ? signedPct(avg(withFair, b => b.odds / b.fair - 1)) : '–'],
  ];

  view.innerHTML = `
    <p class="small muted">${mode === 'cloud'
      ? 'Gespeichert in der Cloud: auf allen Geräten gleich.'
      : 'Gespeichert nur in diesem Browser (Cloudflare D1 ist noch nicht eingerichtet).'}</p>
    <div class="tiles">${tiles.map(([label, value]) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('')}</div>
    <div class="card note small">
      <b>CLV</b> (Closing Line Value) vergleicht deine Quote mit der fairen Marktquote kurz vor Anpfiff.
      Ist er über viele Wetten positiv, hast du wahrscheinlich echten Vorsprung, auch wenn der Gewinn gerade schwankt.
      ${done.length < 300 ? `Aussagekräftig wird es ab etwa 300 Wetten (bisher ${done.length}).` : ''}
    </div>
    <details class="card">
      <summary>Wette von Hand erfassen</summary>
      <form id="manual-form" class="grid" style="margin-top:10px">
        <label class="full">Spiel<input name="match" required placeholder="Basel – Zürich"></label>
        <label class="full">Tipp<input name="label" required placeholder="1 Heimsieg"></label>
        <label>Quote<input name="odds" required inputmode="decimal" placeholder="2.15"></label>
        <label>Einsatz CHF<input name="stake" required inputmode="decimal" placeholder="10"></label>
        <label class="full">Faire Quote (optional)<input name="fair" inputmode="decimal" placeholder="aus den Tipps"></label>
        <button class="primary full">Speichern</button>
      </form>
    </details>
    <div class="card">${bets.length ? bets.map(betRow).join('') : '<div class="empty">Noch keine Wetten. Bei einem Tipp mit Value auf „Ins Tagebuch“ tippen.</div>'}</div>`;
}

function betRow(bet) {
  const statusText = { open: 'offen', won: 'gewonnen', lost: 'verloren', void: 'storniert' }[bet.status];
  const date = new Date(bet.kickoff || bet.created).toLocaleDateString('de-CH', { day: 'numeric', month: 'short', timeZone: 'Europe/Zurich' });
  const p = profitOf(bet);
  // Von Hand abrechnen geht nur bei Wetten ohne automatisches Resultat
  const manual = bet.status === 'open' && !results[bet.match_id]
    ? `<button data-status="won" data-id="${esc(bet.id)}">✓ gewonnen</button><button data-status="lost" data-id="${esc(bet.id)}">✗ verloren</button><button data-status="void" data-id="${esc(bet.id)}">storniert</button>`
    : '';
  return `<div class="bet">
    <div><b>${esc(bet.match)}</b>${bet.score ? ` <span class="muted">${esc(bet.score)}</span>` : ''}<br>
      <span class="small">${esc(bet.label)} @ ${num(bet.odds)} · ${chf(bet.stake)} · ${date}</span>
      ${bet.clv != null ? `<br><span class="small muted">CLV ${signedPct(bet.clv)}</span>` : ''}</div>
    <div style="text-align:right"><span class="status-${bet.status === 'void' ? 'open' : bet.status}">${statusText}</span>
      ${bet.status === 'won' || bet.status === 'lost' ? `<br><span class="small">${p >= 0 ? '+' : '−'}${chf(Math.abs(p))}</span>` : ''}</div>
    <div class="bet-actions" style="grid-column:1/-1">${manual}<button data-delete="${esc(bet.id)}">Löschen</button></div>
  </div>`;
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.delete) {
      if (!confirm('Diese Wette löschen?')) return;
      await remove(button.dataset.delete);
    } else if (button.dataset.status) {
      const bet = bets.find(b => b.id === button.dataset.id);
      await save({ ...bet, status: button.dataset.status });
    } else {
      return;
    }
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  if (event.target.id === 'key-form') {
    store.set('journalKey', form.get('key'));
    await loadBets();
    await settleFinished();
    render();
    return;
  }
  const odds = parseOdds(form.get('odds'));
  const stake = parseFloat(String(form.get('stake')).replace(',', '.'));
  if (!odds || !(stake > 0)) { alert('Quote und Einsatz prüfen.'); return; }
  try {
    await addBet({
      match_id: null, match: form.get('match'), label: form.get('label'),
      odds, stake, fair: parseOdds(form.get('fair')),
    });
  } catch (error) {
    alert(error.message);
  }
}
