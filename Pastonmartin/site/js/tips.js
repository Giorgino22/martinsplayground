// Ansicht "Fussball": kommende Spiele mit Mindestquoten für viele Wettarten.
//
// Am Automaten: Wette antippen, Sporttip-Quote eintragen. Grün = Value.
// "Live-Quoten" holt frische Marktquoten und rechnet alles neu (mit fair.js).
import { num, parseOdds, esc, formatDay, formatTime, store, signedPct } from './util.js';
import { matchProbabilities, fromGoals } from './fair.js';
import { addBet } from './journal.js';
import { cellHtml, panelHtml, resultHtml, marginText, isValue } from './bet.js';
import { stakeFor, stakeText, addToSlip } from './slip.js';
import { sameMatch } from './teams.js';
import { pathsFor, oddsByMarket, matchEvents, fetchSporttip } from './sporttip.js';

const GROUPS = [
  { id: 'win', name: 'Sieger', markets: ['1X2'] },
  { id: 'dc', name: 'Doppelte Chance', markets: ['DC'] },
  { id: 'goals', name: 'Tore', markets: ['OU15', 'OU', 'OU35'] },
  { id: 'btts', name: 'Beide treffen', markets: ['BTTS'] },
];
const list = document.getElementById('tips-list');
const liveStatus = document.getElementById('live-status');
const scanStatus = document.getElementById('scan-status');
const valueList = document.getElementById('value-list');
let tips = null;
let active = null;               // die angetippte Wette: { id, key }
const live = {};                 // Spiel-ID -> { markets, reference, fetched }

export function initTips(data) {
  tips = data;
  if (!tips || tips.version !== 2) {
    list.innerHTML = `<div class="empty">Noch keine Tipps vorhanden.<br><span class="small">Der GitHub-Roboter erzeugt sie beim nächsten Lauf.</span></div>`;
    return;
  }

  // Budget: gilt für alle Einsätze (Fussball, Sport, Kombi)
  const bankroll = document.getElementById('bankroll');
  bankroll.value = store.get('bankroll', 500);
  bankroll.addEventListener('input', () => {
    store.set('bankroll', parseFloat(bankroll.value) || 0);
    document.dispatchEvent(new Event('bankroll-changed'));
  });

  // Filter: Wettarten und Ligen (gemerkt im Browser)
  const groupFilter = document.getElementById('group-filter');
  groupFilter.innerHTML = GROUPS.map(g => chip('hiddenGroups', g.id, g.name)).join('');
  const leagues = [...new Set(tips.matches.map(m => m.league))];
  const leagueFilter = document.getElementById('league-filter');
  leagueFilter.innerHTML = leagues.map(code => chip('hiddenLeagues', code, tips.leagues[code] || code)).join('');
  for (const box of [groupFilter, leagueFilter]) {
    box.addEventListener('click', e => {
      const button = e.target.closest('[data-filter]');
      if (!button) return;
      const hidden = new Set(store.get(button.dataset.filter, []));
      hidden.has(button.dataset.value) ? hidden.delete(button.dataset.value) : hidden.add(button.dataset.value);
      store.set(button.dataset.filter, [...hidden]);
      button.setAttribute('aria-pressed', String(!hidden.has(button.dataset.value)));
      render();
    });
  }

  document.getElementById('live-button').addEventListener('click', loadLiveOdds);
  document.getElementById('scan-button').addEventListener('click', scanSporttip);
  valueList.addEventListener('click', onValueClick);
  initPathFields();
  document.addEventListener('bankroll-changed', refreshPanel);
  list.addEventListener('click', onListClick);
  list.addEventListener('input', e => { if (e.target.id === 'odds-input') onOddsInput(e.target); });
  render();
}

function chip(storeKey, value, label) {
  const hidden = store.get(storeKey, []);
  return `<button class="chip" data-filter="${storeKey}" data-value="${esc(value)}" aria-pressed="${!hidden.includes(value)}">${esc(label)}</button>`;
}

// --- Daten eines Spiels ------------------------------------------------------------
const matchById = id => tips.matches.find(m => m.id === id);
const entriesOf = match => (live[match.id] ? live[match.id].markets : match.markets);

// Wette als ein Objekt (mit Mindest-Value und Höchstquote ihres Marktes), siehe bet.js
function findBet(match, key) {
  for (const [market, info] of Object.entries(entriesOf(match))) {
    const selection = info.selections.find(s => s.key === key);
    if (selection) return { ...selection, market, edge: info.edge, max_odds: info.max_odds, derived: info.derived };
  }
  return null;
}

const inputs = () => store.get('inputs', {});
const enteredOdds = (id, key) => parseOdds(inputs()[`${id}|${key}`]);

// --- Anzeige -----------------------------------------------------------------------
// begonnene Spiele ausblenden (da kann man nicht mehr wetten), ausgeblendete Ligen auch
function visibleMatches() {
  const hiddenLeagues = store.get('hiddenLeagues', []);
  const now = Date.now();
  return tips.matches.filter(m => !hiddenLeagues.includes(m.league) && (!m.kickoff || new Date(m.kickoff) > now));
}

function render() {
  const hiddenGroups = store.get('hiddenGroups', []);
  const matches = visibleMatches();

  renderValueList();
  if (!matches.length) {
    list.innerHTML = `<div class="empty">Keine kommenden Spiele in den Daten.<br><span class="small">Vielleicht Länderspielpause, oder die Ligen sind ausgeblendet.</span></div>`;
    return;
  }
  let html = '', lastDay = '';
  for (const match of matches) {
    if (match.date !== lastDay) {
      html += `<div class="day">${esc(formatDay(match.date))}</div>`;
      lastDay = match.date;
    }
    html += matchCard(match, hiddenGroups);
  }
  list.innerHTML = html;
  refreshPanel();
}

function matchCard(match, hiddenGroups) {
  const entries = entriesOf(match);
  const liveInfo = live[match.id];
  const reference = liveInfo ? `${liveInfo.reference} live ${formatTime(liveInfo.fetched)}` : match.reference;
  const xg = match.expected_goals ? `Erwartete Tore ${num(match.expected_goals[0], 1)} : ${num(match.expected_goals[1], 1)}` : '';
  let html = `<div class="card match">
    <div class="match-head"><span>${esc(tips.leagues[match.league] || match.league)} · ${esc(formatTime(match.kickoff))}</span>
      ${reference ? `<span class="badge${liveInfo ? ' live' : ''}">Markt: ${esc(reference)}</span>` : ''}</div>
    <div class="match-title">${esc(match.home)} – ${esc(match.away)}</div>
    ${xg ? `<div class="sel-sub">${xg}</div>` : ''}`;

  if (!Object.keys(entries).length) {
    return html + `<p class="small"><span class="badge warn">keine Marktquote: nicht wetten</span></p></div>`;
  }
  for (const group of GROUPS) {
    if (hiddenGroups.includes(group.id)) continue;
    const cells = group.markets.filter(m => entries[m]).flatMap(m => entries[m].selections.map(s => {
      const bet = findBet(match, s.key);
      const isActive = active && active.id === match.id && active.key === s.key;
      return cellHtml(match.id, bet, enteredOdds(match.id, s.key), isActive);
    })).join('');
    if (cells) html += `<div class="mrow"><div class="mname">${group.name}</div><div class="cells">${cells}</div></div>`;
  }
  if (active && active.id === match.id) html += '<div class="panel" id="panel"></div>';
  return html + '</div>';
}

// Eingabefeld unter dem Spiel für die angetippte Wette
function refreshPanel() {
  const box = document.getElementById('panel');
  if (!box || !active) return;
  const match = matchById(active.id);
  const bet = match && findBet(match, active.key);
  if (!bet) { box.remove(); return; }
  box.innerHTML = panelHtml(bet, inputs()[`${active.id}|${active.key}`] || '',
    bet.derived ? 'berechnet aus Sieger- und Torquoten' : '');
  updateResult(match, bet);
}

function updateResult(match, bet) {
  document.getElementById('panel-result').innerHTML = resultHtml(bet, enteredOdds(match.id, bet.key));
  const siblings = entriesOf(match)[bet.market].selections.map(s => enteredOdds(match.id, s.key));
  document.getElementById('margin-hint').textContent =
    bet.market === 'DC' ? '' : marginText(`${match.id}|${bet.market}`, siblings);
}

// Alle Wetten mit eingetragener Quote, die Value haben (gescannt oder von Hand), beste zuerst
function renderValueList() {
  const found = [];
  for (const match of visibleMatches()) {
    for (const info of Object.values(entriesOf(match))) {
      for (const s of info.selections) {
        const odds = enteredOdds(match.id, s.key);
        const bet = odds && findBet(match, s.key);
        if (bet && isValue(bet, odds)) found.push({ match, bet, odds, edge: bet.p * odds - 1 });
      }
    }
  }
  if (!found.length) {
    valueList.innerHTML = store.get('scanned', null)
      ? '<div class="card small muted">Im Moment keine Value-Wette bei Sporttip. Das ist normal: Value ist selten.</div>' : '';
    return;
  }
  found.sort((a, b) => b.edge - a.edge);
  valueList.innerHTML = `<div class="card"><b>Value bei Sporttip (${found.length})</b>
    ${found.map(({ match, bet, odds, edge }) => `
      <button class="value-row" data-id="${esc(match.id)}" data-key="${esc(bet.key)}">
        <span>${esc(match.home)} – ${esc(match.away)}<br><span class="small muted">${esc(formatTime(match.kickoff))} · ${esc(bet.name)} @ ${num(odds)}</span></span>
        <span class="value-edge">${signedPct(edge)}<br><span class="small">${stakeText(stakeFor(bet.p, odds))}</span></span>
      </button>`).join('')}</div>`;
}

// Antippen in der Value-Liste öffnet die Wette im Spiel darunter
function onValueClick(event) {
  const row = event.target.closest('.value-row');
  if (!row) return;
  active = { id: row.dataset.id, key: row.dataset.key };
  render();
  document.getElementById('panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onOddsInput(input) {
  const values = inputs();
  const key = `${active.id}|${active.key}`;
  if (input.value) values[key] = input.value; else delete values[key];
  // alte Spiele aufräumen, damit der Speicher nicht wächst
  const ids = new Set(tips.matches.map(m => m.id));
  for (const k of Object.keys(values)) if (!ids.has(k.split('|')[0])) delete values[k];
  store.set('inputs', values);

  const match = matchById(active.id);
  const bet = findBet(match, active.key);
  updateResult(match, bet);
  // die Zelle im Raster neu einfärben, ohne alles neu zu zeichnen (sonst springt der Cursor)
  const cell = list.querySelector(`.cell[data-id="${CSS.escape(match.id)}"][data-key="${CSS.escape(bet.key)}"]`);
  if (cell) cell.outerHTML = cellHtml(match.id, bet, enteredOdds(match.id, bet.key), true);
  renderValueList();
}

async function onListClick(event) {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.matches('.cell')) {
    const same = active && active.id === target.dataset.id && active.key === target.dataset.key;
    active = same ? null : { id: target.dataset.id, key: target.dataset.key };
    render();
    document.getElementById('odds-input')?.focus({ preventScroll: true });
    return;
  }
  if (target.dataset.close !== undefined) {
    active = null;
    render();
    return;
  }
  const match = matchById(active.id);
  const bet = findBet(match, active.key);
  const odds = enteredOdds(match.id, bet.key);
  const description = { match: `${match.home} – ${match.away}`, label: `${bet.short} ${bet.name}`, kickoff: match.kickoff };
  if (target.dataset.slip !== undefined) {
    addToSlip({ id: match.id, match_id: match.id, key: bet.key, odds, p: bet.p, ...description });
    target.textContent = '✓ In der Kombi';
  } else if (target.dataset.add !== undefined) {
    target.disabled = true;
    try {
      await addBet({ ...description, match_id: match.id, league: match.league, market: bet.market,
        selection: bet.key, odds, stake: Math.max(1, Math.round(stakeFor(bet.p, odds))), p: bet.p, fair: bet.fair });
      target.textContent = '✓ Gemerkt';
    } catch (error) {
      target.disabled = false;
      target.textContent = 'Fehler, nochmals';
      console.error(error);
    }
  }
}

// --- Live-Quoten -----------------------------------------------------------------------
async function loadLiveOdds() {
  const button = document.getElementById('live-button');
  const hiddenLeagues = store.get('hiddenLeagues', []);
  const leagues = [...new Set(tips.matches.map(m => m.league))]
    .filter(code => !hiddenLeagues.includes(code) && tips.odds_api_sports[code]);
  button.disabled = true;
  liveStatus.textContent = 'Hole Live-Quoten …';
  let updated = 0, remaining = null, problem = null;
  await Promise.all(leagues.map(async code => {
    try {
      const body = await fetchOdds(`sport=${tips.odds_api_sports[code]}`);
      remaining = body.remaining;
      for (const match of tips.matches.filter(m => m.league === code)) {
        const event = body.events.find(ev => ev.h2h.length === 3 && sameMatch(ev, match, tips.team_aliases));
        if (!event) continue;
        const line = (event.totals || []).find(t => t.point === 2.5);
        const refOdds = { '1X2': event.h2h, OU: line ? [line.over, line.under] : match.ref_odds.OU };
        const probs = matchProbabilities(tips.params, refOdds, match.model);
        live[match.id] = { markets: buildEntries(probs, match), reference: event.source, fetched: body.fetched };
        updated++;
      }
    } catch (error) {
      problem = error.message;
    }
  }));
  button.disabled = false;
  liveStatus.textContent = problem && !updated ? problem
    : `${updated} Spiele mit Live-Quoten aktualisiert${remaining ? ` · noch ${remaining} Abfragen diesen Monat` : ''}${problem ? ` · ${problem}` : ''}`;
  render();
}

// --- Sporttip scannen ---------------------------------------------------------------------
// Holt die echten Sporttip-Quoten und trägt sie ein, wie wenn du sie getippt hättest.
// Nebenbei misst es die Sporttip-Marge jedes Marktes (fürs Tagebuch).
async function scanSporttip() {
  const button = document.getElementById('scan-button');
  const hiddenLeagues = store.get('hiddenLeagues', []);
  const paths = pathsFor();
  const leagues = [...new Set(tips.matches.map(m => m.league))].filter(code => !hiddenLeagues.includes(code) && paths[code]);
  if (!leagues.length) { scanStatus.textContent = 'Keine Liga ausgewählt.'; return; }
  button.disabled = true;
  scanStatus.textContent = 'Frage Sporttip … (bis 20 Sekunden)';
  try {
    const pages = await fetchSporttip(leagues.map(code => paths[code]));
    const values = inputs();
    let found = 0;
    const missing = [];
    for (const code of leagues) {
      const page = pages[paths[code]];
      if (!page || !page.found || !page.events.length) { missing.push(tips.leagues[code] || code); continue; }
      const pairs = matchEvents(page.events, tips.matches.filter(m => m.league === code), tips.team_aliases);
      for (const [id, event] of pairs) {
        found++;
        for (const [market, odds] of Object.entries(oddsByMarket(event))) {
          for (const [key, value] of Object.entries(odds)) values[`${id}|${key}`] = String(value);
          marginText(`${id}|${market}`, Object.values(odds));       // Marge merken
        }
      }
    }
    store.set('inputs', values);
    store.set('scanned', new Date().toISOString());
    scanStatus.textContent = `${found} Spiele mit Sporttip-Quoten (${formatTime(new Date().toISOString())})`
      + (missing.length ? ` · nicht gefunden: ${missing.join(', ')} (Pfad unten prüfen)` : '');
  } catch (error) {
    scanStatus.textContent = error.message;
  }
  button.disabled = false;
  render();
}

// Eingabefelder für die Liga-Pfade (falls ein geratener Pfad nicht stimmt)
function initPathFields() {
  const box = document.getElementById('scan-path-fields');
  const paths = pathsFor();
  box.innerHTML = Object.keys(tips.leagues).map(code => `
    <label class="field">${esc(tips.leagues[code])}
      <input data-league="${esc(code)}" value="${esc(paths[code] || '')}" autocomplete="off" spellcheck="false"></label>`).join('');
  box.addEventListener('change', e => {
    const code = e.target.dataset.league;
    if (!code) return;
    const own = store.get('sporttipPaths', {});
    own[code] = e.target.value.trim().replace(/\/$/, '');
    store.set('sporttipPaths', own);
  });
}

// Holt Live-Quoten über unsere Cloudflare-Function (functions/api/odds.js)
export async function fetchOdds(query) {
  let response;
  try {
    response = await fetch(`/api/odds?${query}`, { headers: { 'x-journal-key': store.get('journalKey', '') } });
  } catch {
    throw new Error('Keine Verbindung.');
  }
  if (!(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('Live-Quoten gibt es nur auf der echten Website (Cloudflare).');
  }
  const body = await response.json();
  if (response.status === 401) throw new Error('Schlüssel nötig: im Tagebuch eingeben.');
  if (!response.ok) throw new Error(body.error || `Fehler ${response.status}`);
  return body;
}

// Gleiche Struktur wie engine/tips.py (market_entries)
function buildEntries(probs, match) {
  const params = tips.params;
  const own = match.expected_goals ? fromGoals(...match.expected_goals, params.model.rho) : null;
  const entries = {};
  for (const [market, def] of Object.entries(tips.market_defs)) {
    const edge = params.edge[def.base] + (def.derived ? params.derived_extra_edge : 0);
    const selections = def.selections.map(([key, short, name]) => {
      const p = probs.final[key];
      if (p == null || Number.isNaN(p)) return null;
      return { key, short, name, p, p_market: probs.market[key] ?? null, p_model: own ? own[key] : null,
        fair: 1 / p, min_odds: (1 + edge) / p };
    });
    if (selections.every(Boolean)) {
      entries[market] = { edge, max_odds: params.max_odds[def.base], derived: def.derived, selections };
    }
  }
  return entries;
}
