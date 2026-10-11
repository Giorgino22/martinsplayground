// Ansicht "Tagebuch": jede Wette festhalten und ehrlich auswerten.
//
// Gespeichert wird in Cloudflare D1 (über /api/bets), damit Handy und Computer
// dasselbe Tagebuch sehen. Ist D1 nicht eingerichtet, landet alles im Browser
// (localStorage) und ist dann nur auf diesem Gerät.
import { pct, signedPct, num, chf, parseOdds, esc, store } from './util.js';

const view = document.getElementById('view-journal');
let mode = null;          // 'cloud' | 'local' | 'locked'
let bets = [];
const results = {};       // match_id -> Resultat (aus results.json)
let benchmarks = null;    // Durchschnittsmargen aus dem Backtest (zum Vergleich mit Sporttip)

export async function initJournal(resultsData, backtest) {
  for (const r of resultsData?.results || []) results[r.id] = r;
  benchmarks = backtest?.margins?.['1X2'] || null;
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

// Wird von den Tipps, "Mehr Sport" und dem Kombi-Schein aufgerufen
export async function addBet(bet) {
  if (!mode) await loadBets();
  if (mode === 'locked') throw new Error('Tagebuch ist gesperrt, zuerst Schlüssel eingeben');
  await save({ id: newId(), created: new Date().toISOString(), status: 'open', ...bet });
  render();
}

// --- Abrechnen -----------------------------------------------------------------
// Hat diese Wette mit diesem Resultat gewonnen?
function didWin(selection, r) {
  const goals = r.hg + r.ag;
  return {
    H: r.hg > r.ag, D: r.hg === r.ag, A: r.hg < r.ag,
    '1X': r.hg >= r.ag, '12': r.hg !== r.ag, X2: r.hg <= r.ag,
    O15: goals >= 2, U15: goals <= 1, O: goals >= 3, U: goals <= 2, O35: goals >= 4, U35: goals <= 3,
    BY: r.hg > 0 && r.ag > 0, BN: r.hg === 0 || r.ag === 0,
  }[selection];
}

// Status und CLV einer Wette, sobald die Resultate bekannt sind (oder null)
function settlement(bet) {
  const legs = bet.legs || [{ match_id: bet.match_id, selection: bet.selection, odds: bet.odds }];
  const known = legs.map(leg => results[leg.match_id]);
  const outcomes = legs.map((leg, i) => (known[i] ? didWin(leg.selection, known[i]) : null));
  if (outcomes.includes(false)) return { status: 'lost' };               // ein Fehler reicht
  if (outcomes.some(o => o === null)) return null;                          // noch offen
  const settled = { status: 'won' };
  if (!bet.legs) settled.score = `${known[0].hg}:${known[0].ag}`;
  // CLV: deine Quote(n) gegen die faire Schlussquote des Marktes
  const fair = legs.map((leg, i) => known[i].closing_fair?.[leg.selection]);
  if (fair.every(Boolean)) settled.clv = legs.reduce((x, leg, i) => x * leg.odds * fair[i], 1) - 1;
  return settled;
}

// Offene Wetten abrechnen, deren Spiele in results.json stehen, und speichern
async function settleFinished() {
  for (const bet of bets.filter(b => b.status === 'open')) {
    const result = settlement(bet);
    if (!result) continue;
    if (result.status === 'lost' && !bet.legs) {
      // auch bei Verlust den CLV festhalten
      const r = results[bet.match_id];
      result.score = `${r.hg}:${r.ag}`;
      const fair = r.closing_fair?.[bet.selection];
      if (fair) result.clv = bet.odds * fair - 1;
    }
    try { await save({ ...bet, ...result }); } catch (error) { console.error(error); }
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
      <p>Das Tagebuch ist mit einem Schlüssel geschützt (derselbe Schlüssel öffnet die Live-Quoten).</p>
      <form id="key-form" class="toolbar"><input name="key" type="password" placeholder="Schlüssel" autocomplete="current-password">
      <button class="primary">Öffnen</button></form></div>`;
    return;
  }

  const done = bets.filter(b => b.status === 'won' || b.status === 'lost');
  const staked = done.reduce((s, b) => s + b.stake, 0);
  const profit = done.reduce((s, b) => s + profitOf(b), 0);
  const withClv = bets.filter(b => b.clv != null);
  const withFair = bets.filter(b => b.fair);
  const avg = (list, f) => (list.length ? list.reduce((s, b) => s + f(b), 0) / list.length : null);
  const openCount = bets.length - done.length;
  const margins = Object.values(store.get('sporttipMargins', {})).map(m => m.margin);

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
    ${marginCard(margins)}
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
    <details class="card">
      <summary>Schlüssel für Tagebuch und Live-Quoten</summary>
      <form id="key-form" class="toolbar" style="margin-top:10px"><input name="key" type="password" placeholder="Schlüssel" autocomplete="current-password" value="${esc(store.get('journalKey', ''))}">
        <button class="primary">Speichern</button></form>
      <p class="small muted">Nur nötig, wenn in Cloudflare die Variable JOURNAL_KEY gesetzt ist.</p>
    </details>
    <div class="card">${bets.length ? bets.map(betRow).join('') : '<div class="empty">Noch keine Wetten. Bei einem Tipp mit Value auf „Ins Tagebuch“ tippen.</div>'}</div>`;
}

// Die wichtigste Zahl: Wie viel Marge nimmt Sporttip wirklich?
function marginCard(margins) {
  const average = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
  const compare = benchmarks
    ? `Zum Vergleich (Sieger-Wetten): Pinnacle/Betfair Ø ${pct(benchmarks.reference)}, Bet365 Ø ${pct(benchmarks.bet365)}, Sporttip-Schätzung im Backtest Ø ${pct(benchmarks.sporttip)}.`
    : '';
  let verdict = 'Trag bei ein paar Spielen alle Sporttip-Quoten eines Marktes ein (z.B. 1, X und 2). Dann misst die App die echte Sporttip-Marge.';
  if (average != null && benchmarks) {
    verdict = average <= benchmarks.bet365 + 0.01
      ? 'Sporttip liegt etwa auf Bet365-Niveau: Im Backtest gab es dort kleinen, echten Value.'
      : average <= benchmarks.sporttip + 0.01
        ? 'Sporttip liegt zwischen Bet365 und unserer Schätzung: Value ist selten. Nur klare Fälle wetten.'
        : 'Sporttip ist teurer als unsere Schätzung: Value wird sehr selten sein.';
  }
  return `<div class="card small">
    <b>Gemessene Sporttip-Marge:</b> ${average != null ? `<b>${pct(average)}</b> (aus ${margins.length} Märkten)` : 'noch keine Messung'}<br>
    ${esc(verdict)}<br><span class="muted">${compare}</span></div>`;
}

function betRow(bet) {
  const statusText = { open: 'offen', won: 'gewonnen', lost: 'verloren', void: 'storniert' }[bet.status];
  const date = new Date(bet.kickoff || bet.created).toLocaleDateString('de-CH', { day: 'numeric', month: 'short', timeZone: 'Europe/Zurich' });
  const p = profitOf(bet);
  // Von Hand abrechnen, solange die Resultate nicht automatisch kommen
  const manual = bet.status === 'open'
    ? `<button data-status="won" data-id="${esc(bet.id)}">✓ gewonnen</button><button data-status="lost" data-id="${esc(bet.id)}">✗ verloren</button><button data-status="void" data-id="${esc(bet.id)}">storniert</button>`
    : '';
  const legs = bet.legs
    ? `<ul class="legs small">${bet.legs.map(leg => {
      const r = results[leg.match_id];
      const state = r ? (didWin(leg.selection, r) ? '✓' : '✗') : '·';
      return `<li>${state} ${esc(leg.match)}: ${esc(leg.label)} @ ${num(leg.odds)}${r ? ` <span class="muted">(${r.hg}:${r.ag})</span>` : ''}</li>`;
    }).join('')}</ul>` : '';
  return `<div class="bet">
    <div><b>${esc(bet.match)}</b>${bet.score ? ` <span class="muted">${esc(bet.score)}</span>` : ''}<br>
      <span class="small">${bet.legs ? 'Gesamtquote' : esc(bet.label)} @ ${num(bet.odds)} · ${chf(bet.stake)} · ${date}</span>
      ${bet.clv != null ? `<br><span class="small muted">CLV ${signedPct(bet.clv)}</span>` : ''}${legs}</div>
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
