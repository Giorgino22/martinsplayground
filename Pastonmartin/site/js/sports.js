// Ansicht "Mehr Sport": Value-Finder für jede Sportart (Tennis, Eishockey, Basketball, …).
//
// Hier gibt es kein eigenes Modell und keinen Backtest: Die faire Quote kommt direkt aus
// den scharfen Marktquoten (Pinnacle, sonst Betfair), die Marge wird herausgerechnet.
// Das ist genau der Value-Finder, der im Fussball-Backtest am besten abgeschnitten hat.
import { parseOdds, esc, formatDay, formatTime, store } from './util.js';
import { devig } from './fair.js';
import { addBet } from './journal.js';
import { cellHtml, panelHtml, resultHtml, marginText } from './bet.js';
import { stakeFor, addToSlip } from './slip.js';
import { fetchOdds } from './tips.js';

const view = document.getElementById('view-sports');
let params = null;               // Einstellungen aus dem Backtest (Margen-Methode, Schwellen)
let events = [];                 // Spiele der gewählten Sportart, mit ihren Wetten
let active = null;               // die angetippte Wette: { id, key }

export function initSports(tips) {
  params = tips?.params || null;
  view.innerHTML = `
    <div class="card note small">Für jede Sportart, ganz ohne eigenes Modell: Die App holt die scharfen
      Marktquoten (Pinnacle, sonst Betfair), rechnet die Marge heraus und zeigt die <b>Mindestquote</b>.
      Jede Sportart kostet 2 der 500 Gratis-Abfragen pro Monat (5 Minuten zwischengespeichert).</div>
    <div class="toolbar">
      <select id="sport-select" aria-label="Sportart"><option value="">Sportart wählen …</option></select>
      <button class="ghost" id="sports-load">Sportarten holen</button>
    </div>
    <p class="small muted" id="sports-status"></p>
    <div id="sports-list"></div>`;
  view.querySelector('#sports-load').addEventListener('click', loadSportsList);
  view.querySelector('#sport-select').addEventListener('change', e => loadSport(e.target.value));
  view.addEventListener('click', onClick);
  view.addEventListener('input', e => { if (e.target.id === 'odds-input') onOddsInput(e.target); });
  document.addEventListener('bankroll-changed', refreshPanel);
  const cached = store.get('sportsList', null);
  if (cached) fillSelect(cached);
}

const status = text => { view.querySelector('#sports-status').textContent = text; };

async function loadSportsList() {
  status('Hole Sportarten …');
  try {
    const body = await fetchOdds('list=1');
    store.set('sportsList', body.sports);
    fillSelect(body.sports);
    status(`${body.sports.length} Sportarten verfügbar.`);
  } catch (error) {
    status(error.message);
  }
}

function fillSelect(sports) {
  const select = view.querySelector('#sport-select');
  const groups = {};
  for (const sport of sports) (groups[sport.group] ||= []).push(sport);
  select.innerHTML = '<option value="">Sportart wählen …</option>' + Object.entries(groups).map(([group, list]) =>
    `<optgroup label="${esc(group)}">${list.map(s => `<option value="${esc(s.key)}">${esc(s.title)}</option>`).join('')}</optgroup>`).join('');
  select.value = store.get('sport', '');
}

async function loadSport(sport) {
  store.set('sport', sport);
  active = null;
  if (!sport) { events = []; render(); return; }
  if (!params) { status('Erst wenn der Fussball-Backtest gelaufen ist, gibt es Einstellungen.'); return; }
  status('Hole Quoten …');
  try {
    const body = await fetchOdds(`sport=${encodeURIComponent(sport)}`);
    events = body.events
      .filter(ev => new Date(ev.kickoff) > Date.now())
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
      .map(ev => ({ ...ev, id: `${sport}|${ev.home}|${ev.away}|${ev.kickoff}`, bets: betsFor(ev) }));
    status(`${events.length} Spiele · Stand ${formatTime(body.fetched)}${body.remaining ? ` · noch ${body.remaining} Abfragen diesen Monat` : ''}`);
  } catch (error) {
    events = [];
    status(error.message);
  }
  render();
}

// Faire Chancen aus den Marktquoten -> Wetten mit Mindestquote
function betsFor(event) {
  const make = (key, short, name, p, market) => {
    const edge = params.edge[market];
    return { key, short, name, p, fair: 1 / p, min_odds: (1 + edge) / p, edge, max_odds: params.max_odds[market], market };
  };
  const rows = [];
  const win = devig(event.h2h, params.devig);
  if (win) {
    const names = event.h2h.length === 3
      ? [['H', '1', `Sieg ${event.home}`], ['D', 'X', 'Unentschieden'], ['A', '2', `Sieg ${event.away}`]]
      : [['H', '1', `Sieg ${event.home}`], ['A', '2', `Sieg ${event.away}`]];
    rows.push({ name: 'Sieger', bets: names.map(([key, short, name], i) => make(key, short, name, win[i], '1X2')) });
  }
  const line = (event.totals || [])[0];
  const total = line && devig([line.over, line.under], params.devig);
  if (total) {
    rows.push({ name: `Total ${line.point}`, bets: [
      make('O', `Ü${line.point}`, `Über ${line.point}`, total[0], 'OU'),
      make('U', `U${line.point}`, `Unter ${line.point}`, total[1], 'OU'),
    ] });
  }
  return rows;
}

const inputs = () => store.get('sportInputs', {});
const enteredOdds = (id, key) => parseOdds(inputs()[`${id}|${key}`]);
const eventById = id => events.find(ev => ev.id === id);
const findBet = (event, key) => event.bets.flatMap(row => row.bets).find(b => b.key === key);

function render() {
  const box = view.querySelector('#sports-list');
  if (!events.length) { box.innerHTML = ''; return; }
  let html = '', lastDay = '';
  for (const event of events) {
    const day = event.kickoff.slice(0, 10);
    if (day !== lastDay) { html += `<div class="day">${esc(formatDay(day))}</div>`; lastDay = day; }
    html += `<div class="card match">
      <div class="match-head"><span>${esc(formatTime(event.kickoff))}</span><span class="badge">Markt: ${esc(event.source)}</span></div>
      <div class="match-title">${esc(event.home)} – ${esc(event.away)}</div>
      ${event.bets.map(row => `<div class="mrow"><div class="mname">${esc(row.name)}</div><div class="cells">${row.bets.map(b =>
        cellHtml(event.id, b, enteredOdds(event.id, b.key), active && active.id === event.id && active.key === b.key)).join('')}</div></div>`).join('')}
      ${active && active.id === event.id ? '<div class="panel" id="sports-panel"></div>' : ''}
    </div>`;
  }
  box.innerHTML = html;
  refreshPanel();
}

function refreshPanel() {
  const box = view.querySelector('#sports-panel');
  if (!box || !active) return;
  const event = eventById(active.id);
  const bet = findBet(event, active.key);
  box.innerHTML = panelHtml(bet, inputs()[`${active.id}|${active.key}`] || '', 'faire Quote aus dem Markt');
  updateResult(event, bet);
}

function updateResult(event, bet) {
  view.querySelector('#panel-result').innerHTML = resultHtml(bet, enteredOdds(event.id, bet.key));
  const row = event.bets.find(r => r.bets.includes(bet));
  view.querySelector('#margin-hint').textContent =
    marginText(`${event.id}|${row.name}`, row.bets.map(b => enteredOdds(event.id, b.key)));
}

function onOddsInput(input) {
  const values = inputs();
  const key = `${active.id}|${active.key}`;
  if (input.value) values[key] = input.value; else delete values[key];
  for (const k of Object.keys(values)) {           // Einträge vergangener Spiele löschen
    const kickoff = k.split('|')[3];
    if (kickoff && new Date(kickoff) < Date.now() - 86400e3) delete values[k];
  }
  store.set('sportInputs', values);
  const event = eventById(active.id);
  const bet = findBet(event, active.key);
  updateResult(event, bet);
  const cell = view.querySelector(`.cell[data-id="${CSS.escape(event.id)}"][data-key="${CSS.escape(bet.key)}"]`);
  if (cell) cell.outerHTML = cellHtml(event.id, bet, enteredOdds(event.id, bet.key), true);
}

async function onClick(event) {
  const target = event.target.closest('button');
  if (!target || !view.querySelector('#sports-list').contains(target)) return;
  if (target.matches('.cell')) {
    const same = active && active.id === target.dataset.id && active.key === target.dataset.key;
    active = same ? null : { id: target.dataset.id, key: target.dataset.key };
    render();
    view.querySelector('#odds-input')?.focus({ preventScroll: true });
    return;
  }
  if (target.dataset.close !== undefined) { active = null; render(); return; }
  const ev = eventById(active.id);
  const bet = findBet(ev, active.key);
  const odds = enteredOdds(ev.id, bet.key);
  const description = { match: `${ev.home} – ${ev.away}`, label: `${bet.short} ${bet.name}`, kickoff: ev.kickoff };
  if (target.dataset.slip !== undefined) {
    addToSlip({ id: ev.id, match_id: null, key: bet.key, odds, p: bet.p, ...description });
    target.textContent = '✓ In der Kombi';
  } else if (target.dataset.add !== undefined) {
    target.disabled = true;
    try {
      await addBet({ ...description, match_id: null, market: bet.market, selection: bet.key, odds,
        stake: Math.max(1, Math.round(stakeFor(bet.p, odds))), p: bet.p, fair: bet.fair });
      target.textContent = '✓ Gemerkt';
    } catch (error) {
      target.disabled = false;
      target.textContent = 'Fehler, nochmals';
    }
  }
}
