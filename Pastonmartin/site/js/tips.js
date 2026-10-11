// Ansicht "Tipps": kommende Spiele mit Mindestquoten und Sporttip-Eingabe.
import { pct, signedPct, num, chf, parseOdds, esc, formatDay, formatTime, store, kellyStake } from './util.js';
import { addBet } from './journal.js';

const MARKET_NAMES = { '1X2': 'Sieger (1X2)', OU: 'Tore über/unter 2.5' };
let tips = null;
const list = document.getElementById('tips-list');

export function initTips(data) {
  tips = data;
  if (!tips || !tips.matches) {
    list.innerHTML = `<div class="empty">Noch keine Tipps vorhanden.<br><span class="small">Der GitHub-Roboter erzeugt sie beim nächsten Lauf.</span></div>`;
    return;
  }

  // Budget
  const bankroll = document.getElementById('bankroll');
  bankroll.value = store.get('bankroll', 500);
  bankroll.addEventListener('input', () => {
    store.set('bankroll', parseFloat(bankroll.value) || 0);
    list.querySelectorAll('.sel input').forEach(updateRow);
  });

  // Markt-Filter (1X2 / Tore)
  for (const [id, market] of [['market-1x2', '1X2'], ['market-ou', 'OU']]) {
    const chip = document.getElementById(id);
    const hidden = store.get('hiddenMarkets', []);
    chip.setAttribute('aria-pressed', String(!hidden.includes(market)));
    chip.addEventListener('click', () => toggle('hiddenMarkets', market, chip));
  }

  // Liga-Filter: nur Ligen, die gerade Spiele haben
  const present = [...new Set(tips.matches.map(m => m.league))];
  const hiddenLeagues = store.get('hiddenLeagues', []);
  const filter = document.getElementById('league-filter');
  filter.innerHTML = present.map(code =>
    `<button class="chip" data-league="${esc(code)}" aria-pressed="${!hiddenLeagues.includes(code)}">${esc(tips.leagues[code] || code)}</button>`).join('');
  filter.addEventListener('click', e => {
    const chip = e.target.closest('[data-league]');
    if (chip) toggle('hiddenLeagues', chip.dataset.league, chip);
  });

  // Eingaben & Knöpfe (einmal für die ganze Liste, "event delegation")
  list.addEventListener('input', e => { if (e.target.matches('.sel input')) { saveInput(e.target); updateRow(e.target); } });
  list.addEventListener('click', e => { if (e.target.matches('[data-add]')) addToJournal(e.target); });

  render();
}

function toggle(storeKey, value, chip) {
  const hidden = new Set(store.get(storeKey, []));
  hidden.has(value) ? hidden.delete(value) : hidden.add(value);
  store.set(storeKey, [...hidden]);
  chip.setAttribute('aria-pressed', String(!hidden.has(value)));
  render();
}

function render() {
  const hiddenLeagues = store.get('hiddenLeagues', []);
  const hiddenMarkets = store.get('hiddenMarkets', []);
  const cutoff = Date.now() - 2 * 3600e3;   // begonnene Spiele ausblenden
  const matches = tips.matches.filter(m =>
    !hiddenLeagues.includes(m.league) && (!m.kickoff || new Date(m.kickoff) > cutoff));

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
    html += matchCard(match, hiddenMarkets);
  }
  list.innerHTML = html;

  // gespeicherte Sporttip-Quoten wieder einsetzen
  const inputs = store.get('inputs', {});
  list.querySelectorAll('.sel input').forEach(input => {
    const saved = inputs[inputKey(input)];
    if (saved) { input.value = saved; updateRow(input); }
  });
}

function matchCard(match, hiddenMarkets) {
  const xg = match.expected_goals ? `Erwartete Tore ${num(match.expected_goals[0], 1)} : ${num(match.expected_goals[1], 1)}` : '';
  let html = `<div class="card">
    <div class="match-head"><span>${esc(tips.leagues[match.league] || match.league)} · ${esc(formatTime(match.kickoff))}</span>
      <span>${match.odds_source === 'odds-api' ? '<span class="badge">Quoten live</span>' : ''}</span></div>
    <div class="match-title">${esc(match.home)} – ${esc(match.away)}</div>
    <div class="sel-sub">${xg}</div>`;

  for (const [market, info] of Object.entries(match.markets)) {
    if (hiddenMarkets.includes(market)) continue;
    const warn = info.source === 'nur Modell'
      ? ' <span class="badge warn">ohne Marktvergleich, vorsichtig</span>' : '';
    html += `<div class="market-title">${MARKET_NAMES[market]}${warn}</div>`;
    for (const s of info.selections) {
      const parts = [`Chance ${pct(s.p)}`];
      if (s.p_model != null && s.p_market != null) parts.push(`Modell ${pct(s.p_model, 0)} · Markt ${pct(s.p_market, 0)}`);
      html += `<div class="sel" data-match="${esc(match.id)}" data-market="${market}" data-key="${s.key}">
        <div class="sel-name"><b>${esc(s.short)}</b> ${esc(s.name)}<div class="sel-sub">${parts.join(' · ')}</div></div>
        <div class="sel-min">Mindestquote<strong>${num(s.min_odds)}</strong></div>
        <input inputmode="decimal" placeholder="Sporttip" aria-label="Sporttip-Quote ${esc(s.name)}">
        <div class="sel-result hidden"></div>
      </div>`;
    }
    html += `<div class="margin-hint" data-margin="${esc(match.id)}|${market}"></div>`;
  }
  return html + '</div>';
}

// Findet die Daten zu einer Eingabezeile
function lookup(row) {
  const match = tips.matches.find(m => m.id === row.dataset.match);
  const info = match.markets[row.dataset.market];
  const selection = info.selections.find(s => s.key === row.dataset.key);
  return { match, info, selection };
}

const inputKey = input => { const r = input.closest('.sel'); return `${r.dataset.match}|${r.dataset.market}|${r.dataset.key}`; };

function saveInput(input) {
  const inputs = store.get('inputs', {});
  if (input.value) inputs[inputKey(input)] = input.value; else delete inputs[inputKey(input)];
  // alte Spiele aufräumen, damit der Speicher nicht wächst
  const ids = new Set(tips.matches.map(m => m.id));
  for (const key of Object.keys(inputs)) if (!ids.has(key.split('|')[0])) delete inputs[key];
  store.set('inputs', inputs);
}

// Rechnet für eine eingegebene Sporttip-Quote Value und Einsatz aus.
function updateRow(input) {
  const row = input.closest('.sel');
  const result = row.querySelector('.sel-result');
  const odds = parseOdds(input.value);
  const { info, selection } = lookup(row);
  updateMarginHint(row);

  if (!odds) { result.className = 'sel-result hidden'; return; }
  const edge = selection.p * odds - 1;
  if (edge >= info.edge) {
    const bankroll = store.get('bankroll', 500);
    const stake = bankroll * kellyStake(selection.p, odds, tips.kelly_fraction, tips.max_stake);
    result.className = 'sel-result value';
    result.innerHTML = `<span><b>${signedPct(edge)} Value</b> · Einsatz ${chf(stake)}</span>
      <button class="primary" data-add data-odds="${odds}" data-stake="${Math.round(stake)}">Ins Tagebuch</button>`;
  } else if (edge > 0) {
    result.className = 'sel-result novalue';
    result.textContent = `${signedPct(edge)}: zu wenig Value (mind. ${signedPct(info.edge, 0)})`;
  } else {
    result.className = 'sel-result novalue';
    result.textContent = `Kein Value (${signedPct(edge)})`;
  }
}

// Sind alle Quoten eines Marktes eingetragen, zeigen wir die Sporttip-Marge.
function updateMarginHint(row) {
  const card = row.closest('.card');
  const rows = [...card.querySelectorAll(`.sel[data-market="${row.dataset.market}"]`)];
  const odds = rows.map(r => parseOdds(r.querySelector('input').value));
  const hint = card.querySelector(`[data-margin="${CSS.escape(row.dataset.match + '|' + row.dataset.market)}"]`);
  if (!hint) return;
  hint.textContent = odds.every(Boolean)
    ? `Sporttip-Marge auf diesem Markt: ${pct(odds.reduce((sum, o) => sum + 1 / o, 0) - 1)}`
    : '';
}

async function addToJournal(button) {
  const row = button.closest('.sel');
  const { match, selection } = lookup(row);
  button.disabled = true;
  try {
    await addBet({
      match_id: match.id,
      match: `${match.home} – ${match.away}`,
      league: match.league,
      kickoff: match.kickoff,
      market: row.dataset.market,
      selection: selection.key,
      label: `${selection.short} ${selection.name}`,
      odds: parseFloat(button.dataset.odds),
      stake: parseFloat(button.dataset.stake),
      p: selection.p,
      fair: selection.fair,
    });
    button.textContent = '✓ Gemerkt';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Fehler, nochmals';
    console.error(error);
  }
}
