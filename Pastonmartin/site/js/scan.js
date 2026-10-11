// "Alle Sportarten scannen": die Sporttip-Quoten aller Sportarten mit den scharfen Quoten
// (Pinnacle, über The Odds API) vergleichen und nur die Value-Wetten auflisten.
//
// Ablauf:
//   1. Sporttip: alle Spiele der eingestellten Seiten holen (z.B. "/tennis")
//   2. The Odds API: Welche Ligen laufen, und welche Spiele gibt es dort? (kostet nichts)
//   3. Jedes Sporttip-Spiel dem gleichen Spiel bei The Odds API zuordnen (Zeit + Namen)
//   4. Nur für Ligen mit zugeordneten Spielen die Quoten holen (kostet 2 Abfragen pro Liga)
//   5. Faire Chance ausrechnen, mit der Sporttip-Quote vergleichen, Value-Wetten anzeigen
// Nebenbei misst der Scan die Sporttip-Marge jeder Sportart.

import { num, pct, signedPct, esc, store, formatTime } from './util.js';
import { devig, impliedGoals, scoreGrid, overProbability, bothScore } from './fair.js';
import { isValue } from './bet.js';
import { stakeFor, stakeText, addToSlip } from './slip.js';
import { addBet } from './journal.js';
import { fetchOdds } from './api.js';
import { summarize } from './feed.js';
import { DEFAULT_SPORT_PATHS, MARKET_TYPES, SWAP, plausible, matchApiEvent, fetchSporttip } from './sporttip.js';

// Sporttip-Seite (erster Teil des Pfads) -> Sportart bei The Odds API
const SPORT_GROUPS = {
  fussball: 'Soccer', tennis: 'Tennis', eishockey: 'Ice Hockey', basketball: 'Basketball',
  'american-football': 'American Football', baseball: 'Baseball', handball: 'Handball',
  rugby: 'Rugby Union', cricket: 'Cricket', boxen: 'Boxing', mma: 'Mixed Martial Arts',
};
// Verrät der Pfad nichts: Sporttip-Sportnummer (Sportradar-Format) -> Sportart
const SPORT_NUMBERS = { 1: 'Soccer', 2: 'Basketball', 3: 'Baseball', 4: 'Ice Hockey', 5: 'Tennis', 6: 'Handball', 16: 'American Football' };
const GROUP_NAMES = { Soccer: 'Fussball', Tennis: 'Tennis', 'Ice Hockey': 'Eishockey', Basketball: 'Basketball',
  'American Football': 'American Football', Baseball: 'Baseball', Handball: 'Handball', 'Rugby Union': 'Rugby',
  Cricket: 'Cricket', Boxing: 'Boxen', 'Mixed Martial Arts': 'MMA' };

// Für die anderen Sportarten gibt es keinen eigenen Backtest, darum etwas vorsichtiger als im Fussball
const OTHER_SPORTS = { edge: 0.02, maxOdds: 5 };
const DAYS = 3;                    // nur Spiele der nächsten 3 Tage
const DEFAULT_BUDGET = 20;         // höchstens so viele Odds-API-Abfragen pro Scan (2 pro Liga)
const PATH = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;

let params = null;                 // Einstellungen aus dem Fussball-Backtest (Margen-Methode, Schwellen)
let root = null;
let result = null;                 // Resultat des letzten Scans

const groupOf = (path, sport) => SPORT_GROUPS[path.split('/')[1]] || SPORT_NUMBERS[sport] || `Sportart ${sport}`;
const groupName = group => GROUP_NAMES[group] || group;
const sportPaths = () => store.get('scanSportPaths', DEFAULT_SPORT_PATHS);

export function initScan(tips, box) {
  params = tips?.params || null;
  root = box;
  box.innerHTML = `
    <div class="card note small">Holt die Quoten <b>aller Sportarten</b> bei Sporttip, sucht dasselbe Spiel bei
      Pinnacle und zeigt nur die Wetten mit Value. Das Suchen kostet nichts, die Pinnacle-Quoten kosten
      2 Odds-API-Abfragen pro Liga (5 Minuten zwischengespeichert).</div>
    <div class="toolbar"><button class="primary" id="all-scan-button">Alle Sportarten scannen</button></div>
    <p class="small muted" id="all-scan-status"></p>
    <div id="all-scan-result"></div>
    <details class="card small">
      <summary>Einstellungen und Pfad testen</summary>
      <label class="stack">Sporttip-Seiten, eine pro Zeile
        <textarea id="scan-paths" rows="7" spellcheck="false" autocomplete="off"></textarea></label>
      <label class="field">Höchstens <input id="scan-budget" type="number" inputmode="numeric" min="2" step="2" style="width:70px">
        Odds-API-Abfragen pro Scan</label>
      <p class="muted">Pfad testen: die Seite auf swisslos.ch öffnen und den Teil der Adresse nach
        <code>/sportwetten</code> eintragen, z.B. <code>/tennis</code>.</p>
      <div class="toolbar"><input id="probe-path" placeholder="/tennis" spellcheck="false" autocomplete="off">
        <button class="ghost" id="probe-button">Pfad testen</button></div>
      <div id="probe-result"></div>
    </details>`;

  const pathsInput = box.querySelector('#scan-paths');
  pathsInput.value = sportPaths().join('\n');
  pathsInput.addEventListener('change', () => {
    const paths = pathsInput.value.split('\n').map(p => p.trim().replace(/\/$/, '')).filter(p => PATH.test(p));
    store.set('scanSportPaths', paths.length ? paths : DEFAULT_SPORT_PATHS);
  });
  const budget = box.querySelector('#scan-budget');
  budget.value = store.get('scanBudget', DEFAULT_BUDGET);
  budget.addEventListener('change', () => store.set('scanBudget', Math.max(2, parseInt(budget.value, 10) || DEFAULT_BUDGET)));

  box.querySelector('#all-scan-button').addEventListener('click', runScan);
  box.querySelector('#probe-button').addEventListener('click', probe);
  box.addEventListener('click', onClick);
  document.addEventListener('bankroll-changed', render);
}

const status = text => { root.querySelector('#all-scan-status').textContent = text; };

async function runScan() {
  const button = root.querySelector('#all-scan-button');
  button.disabled = true;
  try {
    if (!params) throw new Error('Erst wenn der Fussball-Backtest gelaufen ist, gibt es Einstellungen.');
    result = await scan(status, params);
    render();
  } catch (error) {
    status(error.message);
  }
  button.disabled = false;
}

// --- Der Scan ---------------------------------------------------------------------------------
// settings = Einstellungen aus tips.json (params). report(text) meldet den Fortschritt.
export async function scan(report, settings) {
  params = settings;
  // 1. Sporttip: Spiele der nächsten Tage, die noch nicht begonnen haben
  const pages = await fetchSporttip(sportPaths(), {}, (done, total) => report(`Sporttip: ${done} von ${total} Seiten …`));
  const now = Date.now();
  const byUrn = new Map();
  for (const page of pages) {
    for (const event of page.events) {
      const start = new Date(event.kickoff).getTime();
      if (start > now && start < now + DAYS * 86400e3 && !byUrn.has(event.urn)) {
        byUrn.set(event.urn, { ...event, group: groupOf(page.path, event.sport) });
      }
    }
  }
  const events = [...byUrn.values()];
  const out = { fetched: new Date().toISOString(), events: events.length, pairs: 0, compared: 0, rejected: 0,
    values: [], margins: sporttipMargins(events), unmatched: {}, emptyPages: pages.filter(p => !p.events.length).map(p => p.path),
    skippedLeagues: 0, remaining: null, oddsError: null };

  // 2.-4. The Odds API (ohne Schlüssel bleibt es bei den Sporttip-Margen)
  let pairs = [], odds = {};
  try {
    ({ pairs, odds } = await sharpOdds(events, report, out));
  } catch (error) {
    out.oddsError = error.message;
    return out;
  }

  // 5. Vergleichen
  for (const pair of pairs) {
    const api = odds[pair.league.key]?.find(e => e.id === pair.api.id);
    const soccer = pair.event.group === 'Soccer';
    const fair = api && fairOf(api, soccer);
    if (!fair) continue;
    for (const market of pair.event.markets) compare(pair, api, market, fair, soccer, out);
  }
  out.values.sort((a, b) => b.edge - a.edge);
  return out;
}

async function sharpOdds(events, report, out) {
  report(`Sporttip: ${events.length} Spiele. Suche dieselben Spiele bei The Odds API …`);
  const groups = new Set(events.map(e => e.group));
  const leagues = (await sportsList()).filter(s => groups.has(s.group));
  const apiEvents = {};
  await inBatches(leagues, 6, async league => {
    try { apiEvents[league.key] = (await fetchOdds(`events=${league.key}`)).events; } catch { apiEvents[league.key] = []; }
  });

  // Jedes Sporttip-Spiel: das ähnlichste Spiel derselben Sportart, über alle Ligen
  const pairs = [];
  for (const event of events) {
    let best = null;
    for (const league of leagues.filter(l => l.group === event.group)) {
      const found = matchApiEvent(event, apiEvents[league.key] || []);
      if (found && (!best || found.score > best.score)) best = { ...found, league };
    }
    if (best) pairs.push({ event, ...best });
    else out.unmatched[event.group] = (out.unmatched[event.group] || 0) + 1;
  }

  // Quoten nur für die Ligen mit den meisten zugeordneten Spielen, bis das Budget aufgebraucht ist
  const perLeague = {};
  for (const pair of pairs) perLeague[pair.league.key] = (perLeague[pair.league.key] || 0) + 1;
  const budget = Math.max(2, store.get('scanBudget', DEFAULT_BUDGET));
  const ranked = Object.keys(perLeague).sort((a, b) => perLeague[b] - perLeague[a]);
  const chosen = ranked.slice(0, Math.floor(budget / 2));
  out.skippedLeagues = ranked.length - chosen.length;
  report(`${pairs.length} Spiele gefunden. Hole Pinnacle-Quoten für ${chosen.length} Ligen …`);
  const odds = {};
  await inBatches(chosen, 4, async key => {
    try {
      const body = await fetchOdds(`sport=${key}`);
      odds[key] = body.events;
      out.remaining = body.remaining ?? out.remaining;
    } catch { odds[key] = null; }
  });
  out.pairs = pairs.filter(p => odds[p.league.key]).length;
  return { pairs, odds };
}

async function sportsList() {
  const cached = store.get('sportsListAll', null);
  if (cached && Date.now() - cached.time < 12 * 3600e3) return cached.sports;
  const body = await fetchOdds('list=1');
  store.set('sportsListAll', { time: Date.now(), sports: body.sports });
  return body.sports;
}

async function inBatches(list, size, task) {
  for (let i = 0; i < list.length; i += size) await Promise.all(list.slice(i, i + size).map(task));
}

// --- Faire Chancen ------------------------------------------------------------------------------
// Aus den Pinnacle-Quoten, Marge herausgerechnet (gleiche Methode wie im Fussball-Backtest)
function fairOf(api, soccer) {
  const win = devig(api.h2h, params.devig);
  if (!win) return null;
  const totals = {};
  for (const line of api.totals || []) {
    const p = devig([line.over, line.under], params.devig);
    if (p) totals[line.point] = { O: p[0], U: p[1] };
  }
  const fair = { win: win.length === 3 ? { H: win[0], D: win[1], A: win[2] } : { H: win[0], A: win[1] }, totals, grid: null };
  if (soccer && win.length === 3) {
    // Wie bei den Fussball-Tipps: erwartete Tore aus Sieger- und Torquoten, daraus "Beide treffen" und alle Torlinien
    const main = (api.totals || []).find(line => line.point % 1 === 0.5 && totals[line.point]);
    const rho = params.derived_rho || 0;
    const goals = impliedGoals(win[0], win[1], win[2], main ? totals[main.point].O : null, rho, main ? main.point : 2.5);
    fair.grid = scoreGrid(goals[0], goals[1], rho);
  }
  return fair;
}

// Faire Chance jedes Tipps einer Sporttip-Wettart. derived = über die erwarteten Tore berechnet
function chancesFor(def, market, fair, swapped) {
  const team = key => fair.win[swapped ? SWAP[key] : key];      // Heim oder Gast, falls nötig vertauscht
  const draw = fair.win.D;
  switch (def.kind) {
    case 'win3': return draw == null ? null : { p: { H: team('H'), D: draw, A: team('A') } };
    case 'win2': return draw != null ? null : { p: { H: team('H'), A: team('A') } };
    case 'dnb': {
      if (draw == null) return null;
      const home = team('H'), away = team('A');
      return { p: { H: home / (home + away), A: away / (home + away) } };
    }
    case 'dc': return draw == null ? null : { p: { '1X': team('H') + draw, 12: team('H') + team('A'), X2: draw + team('A') } };
    case 'btts': {
      if (!fair.grid) return null;
      const both = bothScore(fair.grid);
      return { p: { BY: both, BN: 1 - both }, derived: true };
    }
    case 'total': {
      if (fair.totals[market.line]) return { p: fair.totals[market.line] };
      if (!fair.grid || market.line % 1 !== 0.5) return null;
      const over = overProbability(fair.grid, market.line);
      return { p: { O: over, U: 1 - over }, derived: true };
    }
    default: return null;
  }
}

// Verlangter Mindest-Value und Höchstquote (Fussball: wie vom Backtest gewählt)
function rulesFor(kind, derived, soccer) {
  const base = kind === 'total' || kind === 'btts' ? 'OU' : '1X2';
  if (!soccer) return { edge: Math.max(params.edge[base], OTHER_SPORTS.edge), maxOdds: OTHER_SPORTS.maxOdds };
  return { edge: params.edge[base] + (derived ? params.derived_extra_edge : 0), maxOdds: params.max_odds[base] };
}

function compare(pair, api, market, fair, soccer, out) {
  const def = MARKET_TYPES[market.type];
  if (market.live || !def || Boolean(def.soccer) !== soccer) return;
  const outcomes = Object.entries(def.outcomes);              // [[Sporttip-Nummer, unser Kürzel], …]
  if (!outcomes.every(([id]) => market.odds[id])) return;      // nur vollständige Wettarten
  const chances = chancesFor(def, market, fair, pair.swapped);
  if (!chances) return;
  const odds = outcomes.map(([id]) => market.odds[id]);
  const p = outcomes.map(([, key]) => chances.p[key]);
  if (!p.every(x => x > 0 && x < 1)) return;
  out.compared++;
  if (!plausible(p, odds)) { out.rejected++; return; }
  const rules = rulesFor(def.kind, chances.derived, soccer);
  outcomes.forEach(([, key], i) => {
    if (!isValue({ p: p[i], edge: rules.edge, max_odds: rules.maxOdds }, odds[i])) return;
    out.values.push({ id: `${pair.event.urn}|${market.type}|${market.line ?? ''}|${key}`, event: pair.event,
      league: pair.league.title, kind: def.kind, key, label: labelFor(def.kind, key, market.line, pair.event),
      odds: odds[i], p: p[i], edge: p[i] * odds[i] - 1, source: api.source });
  });
}

function labelFor(kind, key, line, event) {
  const team = key === 'H' ? event.home : event.away;
  if (kind === 'win3' || kind === 'win2') return key === 'D' ? 'Unentschieden' : `Sieg ${team}`;
  if (kind === 'dnb') return `Sieg ${team}, bei Unentschieden Geld zurück`;
  if (kind === 'dc') return `Doppelte Chance ${key}`;
  if (kind === 'btts') return key === 'BY' ? 'Beide treffen: Ja' : 'Beide treffen: Nein';
  return `${key === 'O' ? 'Über' : 'Unter'} ${line}`;
}

// Sporttip-Marge pro Sportart (Sieger und Über/Unter): Summe der 1/Quote minus 1
function sporttipMargins(events) {
  const sums = {};
  for (const event of events) {
    for (const market of event.markets) {
      const def = MARKET_TYPES[market.type];
      if (market.live || !def || !['win2', 'win3', 'total'].includes(def.kind)) continue;
      const odds = Object.keys(def.outcomes).map(id => market.odds[id]);
      if (!odds.every(Boolean)) continue;
      const label = `${groupName(event.group)} · ${def.kind === 'total' ? 'Über/Unter' : 'Sieger'}`;
      const entry = (sums[label] ||= { sum: 0, n: 0 });
      entry.sum += odds.reduce((s, o) => s + 1 / o, 0) - 1;
      entry.n++;
    }
  }
  return Object.entries(sums).map(([label, e]) => ({ label, margin: e.sum / e.n, n: e.n }))
    .sort((a, b) => a.margin - b.margin);
}

// --- Anzeige ------------------------------------------------------------------------------------
function render() {
  const box = root.querySelector('#all-scan-result');
  if (!result) { box.innerHTML = ''; return; }
  const r = result;
  status(`${r.events} Sporttip-Spiele · ${r.pairs} bei Pinnacle gefunden · ${r.compared} Wettarten verglichen · `
    + `Stand ${formatTime(r.fetched)}${r.remaining ? ` · noch ${r.remaining} Odds-API-Abfragen` : ''}`);
  const notes = [];
  if (r.oddsError) notes.push(`Ohne Pinnacle-Quoten kein Vergleich: ${r.oddsError}`);
  if (r.rejected) notes.push(`${r.rejected} Wettarten passten nicht zur fairen Quote und wurden ignoriert (Sicherheitsprüfung).`);
  if (r.skippedLeagues) notes.push(`${r.skippedLeagues} weitere Ligen übersprungen (Budget in den Einstellungen).`);
  const unmatched = Object.entries(r.unmatched).map(([g, n]) => `${groupName(g)} ${n}`).join(', ');
  if (unmatched) notes.push(`Ohne Vergleichsquote: ${unmatched}`);
  if (r.emptyPages.length) notes.push(`Keine Spiele auf ${r.emptyPages.join(', ')} (Pfad prüfen).`);

  const values = r.values.length
    ? `<div class="card"><b>Value bei Sporttip (${r.values.length})</b>${r.values.map(valueRow).join('')}</div>`
    : `<div class="card small muted">Gerade keine Value-Wette. Später nochmals scannen: Quoten ändern sich laufend.</div>`;
  const margins = r.margins.length ? `<div class="card small"><b>Gemessene Sporttip-Marge</b>
    <div class="table-wrap"><table><tr><th>Sportart</th><th>Marge</th><th>Märkte</th></tr>
    ${r.margins.map(m => `<tr><td>${esc(m.label)}</td><td>${pct(m.margin)}</td><td>${m.n}</td></tr>`).join('')}</table></div>
    <p class="muted">Je kleiner die Marge, desto öfter gibt es Value.</p></div>` : '';
  box.innerHTML = values + margins + (notes.length ? `<div class="card small muted">${notes.map(esc).join('<br>')}</div>` : '');
}

const whenText = iso => new Date(iso).toLocaleString('de-CH',
  { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });

function valueRow(v, i) {
  const when = whenText(v.event.kickoff);
  return `<div class="value-row static">
    <span>${esc(v.event.home)} – ${esc(v.event.away)}
      <br><span class="small muted">${esc(groupName(v.event.group))} · ${esc(v.league)} · ${esc(when)}</span>
      <br><span class="small">${esc(v.label)} @ <b>${num(v.odds)}</b> · faire Quote ${num(1 / v.p)}</span></span>
    <span class="value-edge">${signedPct(v.edge)}<br><span class="small">${stakeText(stakeFor(v.p, v.odds))}</span>
      <span class="value-actions"><button class="primary" data-add="${i}">Tagebuch</button>
      <button class="ghost" data-slip="${i}">+ Kombi</button></span></span>
  </div>`;
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.addpath) {
    const input = root.querySelector('#scan-paths');
    if (!input.value.split('\n').includes(button.dataset.addpath)) input.value = `${input.value.trim()}\n${button.dataset.addpath}`;
    input.dispatchEvent(new Event('change'));
    button.textContent = '✓';
    return;
  }
  if (button.dataset.copy !== undefined) {
    const text = root.querySelector('#probe-json');
    try { await navigator.clipboard.writeText(text.value); button.textContent = '✓ Kopiert'; } catch { text.select(); }
    return;
  }
  const v = result?.values[Number(button.dataset.add ?? button.dataset.slip)];
  if (!v) return;
  const description = { match: `${v.event.home} – ${v.event.away}`, label: v.label, kickoff: v.event.kickoff };
  if (button.dataset.slip !== undefined) {
    addToSlip({ id: v.event.urn, match_id: null, key: v.key, odds: v.odds, p: v.p, ...description });
    button.textContent = '✓ In der Kombi';
    return;
  }
  button.disabled = true;
  try {
    await addBet({ ...description, match_id: null, market: v.kind, selection: v.key, odds: v.odds,
      stake: Math.max(1, Math.round(stakeFor(v.p, v.odds))), p: v.p, fair: 1 / v.p });
    button.textContent = '✓ Gemerkt';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Fehler, nochmals';
  }
}

// --- Pfad testen ----------------------------------------------------------------------------------
// Zeigt, was Sporttip auf einer Seite schickt. Die Zusammenfassung kann man Claude schicken,
// falls eine Sportart oder Wettart noch nicht erkannt wird.
async function probe() {
  const box = root.querySelector('#probe-result');
  const path = root.querySelector('#probe-path').value.trim().replace(/\/$/, '');
  if (!PATH.test(path)) { box.textContent = 'Pfad wie /tennis eingeben (Kleinbuchstaben, Zahlen, - und /).'; return; }
  box.innerHTML = '<p class="muted">Frage Sporttip …</p>';
  try {
    const [page] = await fetchSporttip([path], { tree: true });
    const s = summarize(page);
    const types = Object.entries(s.marketTypes).map(([type, t]) =>
      `<tr><td>${esc(type)}</td><td>${esc(MARKET_TYPES[type]?.kind || '–')}</td><td>${t.count}</td><td>${esc(t.outcomes.join(', '))}</td></tr>`).join('');
    box.innerHTML = `
      <p><b>${s.events} Spiele</b>${s.found ? '' : ' · Sporttip hat nicht geantwortet'}${s.redirect ? ` · leitet weiter auf ${esc(s.redirect)}` : ''}</p>
      ${s.sample.length ? `<p class="muted">${s.sample.map(esc).join('<br>')}</p>` : ''}
      ${types ? `<div class="table-wrap"><table><tr><th>Wettart</th><th>erkannt</th><th>Anzahl</th><th>Tipps</th></tr>${types}</table></div>` : ''}
      ${s.links.length ? `<p>Gefundene Unterseiten:</p>${s.links.map(l =>
        `<div class="link-row"><span>${esc(l.path)} <span class="muted">${esc(l.name)}</span></span>
         <button class="ghost" data-addpath="${esc(l.path)}">+ zum Scan</button></div>`).join('')}` : ''}
      <p class="muted">Zusammenfassung für Claude (falls etwas nicht erkannt wird):</p>
      <textarea id="probe-json" rows="4" readonly>${esc(JSON.stringify(s))}</textarea>
      <button class="ghost" data-copy>Kopieren</button>`;
  } catch (error) {
    box.textContent = error.message;
  }
}
