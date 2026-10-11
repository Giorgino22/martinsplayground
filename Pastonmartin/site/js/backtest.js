// Ansicht "Backtest": was das System in alten Saisons gemacht hätte.
import { pct, signedPct, num, esc, formatStamp } from './util.js';

const view = document.getElementById('view-backtest');
const MARKET_NAMES = { '1X2': '1X2', OU: 'Tore' };
const COLORS = { value: 'var(--series-1)', model: 'var(--series-2)', combo: 'var(--series-3)' };
let data = null;
let scenario = 'sporttip';
let period = 'test';

export function initBacktest(backtest) {
  data = backtest;
  if (!data) {
    view.innerHTML = `<div class="empty">Noch kein Backtest vorhanden.<br><span class="small">Er läuft automatisch, sobald der GitHub-Roboter das erste Mal startet.</span></div>`;
    return;
  }
  view.addEventListener('click', e => {
    const chip = e.target.closest('[data-scenario],[data-period]');
    if (!chip) return;
    if (chip.dataset.scenario) scenario = chip.dataset.scenario;
    if (chip.dataset.period) period = chip.dataset.period;
    render();
  });
  render();
}

const cls = x => x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '';
const luck = p => p == null ? '–' : p < 0.01 ? '< 1 %' : pct(p, 0);

// Ein Satz, der das wichtigste Resultat ehrlich zusammenfasst
function verdict(total) {
  if (!total || !total.bets) {
    return ['bad', 'Im Test hätte die Kombination keine einzige Wette gefunden.',
      'Die Sporttip-Schätzung ist zu weit von den fairen Quoten weg. Echte Sporttip-Quoten im Tagebuch zeigen, ob es in Wirklichkeit besser aussieht.'];
  }
  const head = `${total.bets} Test-Wetten, Rendite ${signedPct(total.roi)}, Ø CLV ${signedPct(total.clv)}.`;
  if (total.roi > 0 && total.p_luck < 0.05) {
    return ['good', `Vielversprechend: ${head}`, 'Das Resultat ist kaum mit purem Glück zu erklären. Trotzdem klein anfangen und im Tagebuch mitzählen.'];
  }
  if (total.roi > 0) {
    return ['good', `Im Plus, aber noch nicht bewiesen: ${head}`,
      `Mit ${luck(total.p_luck)} Wahrscheinlichkeit wäre so ein Plus auch reines Glück. Der CLV ist der ehrlichere Hinweis.`];
  }
  return ['bad', `Im Test kein Gewinn: ${head}`,
    'Mit diesen Einstellungen schlägt das System die Sporttip-Schätzung nicht. Das ist ein wichtiges, ehrliches Resultat, kein Fehler.'];
}

function render() {
  const combo = data.strategies.find(s => s.key === 'combo');
  const [tone, title, text] = verdict(combo.test_total);
  const p = data.params;

  view.innerHTML = `
    <p class="small muted">Stand ${esc(formatStamp(data.generated))} · Anpassen: ${esc(data.seasons.tune)} · Test: ${esc(data.seasons.test)}</p>
    <div class="card verdict-${tone}"><b>${esc(title)}</b><br><span class="small">${esc(text)}</span></div>

    <div class="card small">
      <b>Vom Backtest gewählt:</b> Eigenes Modell zählt bei 1X2 <b>${pct(p.w_1x2, 0)}</b>, bei Toren <b>${pct(p.w_ou, 0)}</b>
      (der Rest ist Pinnacle). Gewettet wird ab <b>${signedPct(p.edge_1x2, 0)}</b> (1X2) bzw. <b>${signedPct(p.edge_ou, 0)}</b> (Tore) Value.
      Ein Spiel zählt nach ${Math.round(Math.log(2) / p.decay / 30)} Monaten nur noch halb so viel.
      <br><span class="muted">Sporttip-Schätzung = Bet365-Quote minus ${pct(p.haircut, 0)}.</span>
    </div>

    <h2>Strategien im Vergleich</h2>
    <div class="toolbar">
      ${Object.entries(data.scenarios).map(([key, name]) => `<button class="chip" data-scenario="${key}" aria-pressed="${key === scenario}">${esc(name)}</button>`).join('')}
    </div>
    <div class="toolbar">
      <button class="chip" data-period="test" aria-pressed="${period === 'test'}">Test (ehrlich)</button>
      <button class="chip" data-period="tune" aria-pressed="${period === 'tune'}">Anpassung (geschönt)</button>
    </div>
    <div class="card">${strategyTable()}</div>
    <p class="small muted">ROI = Gewinn pro gesetztem Franken. „Glück?“ = Wahrscheinlichkeit, so ein Resultat (oder besser) ganz ohne echten Vorteil zu erzielen. Tief ist gut.</p>

    <h2>Gewinnverlauf im Test</h2>
    <div class="card">${chartHtml()}</div>
    <p class="small muted">Einsatz 1 Einheit pro Wette, Sporttip-Schätzung. Hover oder tippen zeigt die Werte.</p>

    <h2>Wie gut sind die Wahrscheinlichkeiten?</h2>
    <div class="card">${logLossTable()}</div>
    <p class="small muted">Log-Loss: tiefer = bessere Vorhersage. Ist „Kombination“ tiefer als „Pinnacle“, bringt das eigene Modell echte Zusatzinformation.</p>

    <h2>Kombination nach Liga (Test)</h2>
    <div class="card">${breakdownTable(data.by_league, 'name', 'Liga')}</div>
    <h2>Kombination nach Saison (Test)</h2>
    <div class="card">${breakdownTable(data.by_season, 'season', 'Saison')}</div>

    <h2>Mindest-Value anpassen</h2>
    <div class="card">${tuningTable()}</div>
    <p class="small muted">So hätte die Kombination im Anpassungs-Zeitraum mit verschiedenen Mindest-Values abgeschnitten.
      Wenn die Zahlen hier stark springen, ist viel Zufall dabei.</p>

    <details class="card small"><summary>Datenabdeckung</summary>${coverageTable()}</details>`;

  attachChart();
}

function strategyTable() {
  let rows = '';
  for (const s of data.strategies) {
    rows += `<tr class="group"><td colspan="5">${esc(s.name)}</td></tr>`;
    for (const market of Object.keys(MARKET_NAMES)) {
      const r = s.results[scenario]?.[period]?.[market];
      if (!r) continue;
      rows += `<tr><td>${MARKET_NAMES[market]} <span class="small muted">ab ${signedPct(s.edges[market], 0)}</span></td>
        <td>${r.bets}</td>
        <td class="${cls(r.roi)}">${r.bets ? signedPct(r.roi) : '–'}</td>
        <td class="${cls(r.clv)}">${signedPct(r.clv)}</td><td>${luck(r.p_luck)}</td></tr>`;
    }
  }
  return `<div class="table-wrap"><table><thead><tr><th>Markt</th><th>Wetten</th><th>ROI</th><th>CLV</th><th>Glück?</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function logLossTable() {
  let rows = '';
  for (const [market, periods] of Object.entries(data.log_loss)) {
    for (const [name, key] of [['Anpassung', 'tune'], ['Test', 'test']]) {
      const r = periods[key];
      if (!r || !r.games) continue;
      const best = Math.min(r.model, r.market, r.blend);
      const cell = v => `<td${v === best ? ' style="font-weight:700"' : ''}>${num(v, 4)}</td>`;
      rows += `<tr><td>${MARKET_NAMES[market]} · ${name}</td>${cell(r.model)}${cell(r.market)}${cell(r.blend)}</tr>`;
    }
  }
  return `<div class="table-wrap"><table><thead><tr><th></th><th>Modell</th><th>Pinnacle</th><th>Kombi</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function breakdownTable(list, key, label) {
  if (!list?.length) return '<div class="empty small">Keine Wetten.</div>';
  const rows = list.map(r => `<tr><td>${esc(r[key])}</td><td>${r.bets}</td>
    <td class="${cls(r.roi)}">${signedPct(r.roi)}</td><td class="${cls(r.clv)}">${signedPct(r.clv)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>${label}</th><th>Wetten</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function tuningTable() {
  let rows = '';
  for (const [market, grid] of Object.entries(data.tuning_grid)) {
    const chosen = data.params[market === '1X2' ? 'edge_1x2' : 'edge_ou'];
    for (const g of grid) {
      const mark = g.edge === chosen ? ' ← gewählt' : '';
      rows += `<tr><td>${MARKET_NAMES[market]} ab ${signedPct(g.edge, 0)}${mark}</td><td>${g.bets}</td>
        <td class="${cls(g.roi)}">${g.bets ? signedPct(g.roi) : '–'}</td></tr>`;
    }
  }
  return `<div class="table-wrap"><table><thead><tr><th>Einstellung</th><th>Wetten</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function coverageTable() {
  const rows = (data.coverage || []).map(c => `<tr><td>${esc(c.league)} ${c.season}</td><td>${c.games}</td>
    <td>${pct(c.pinnacle, 0)}</td><td>${pct(c.bet365, 0)}</td><td>${pct(c.pinnacle_ou, 0)}</td><td>${pct(c.closing, 0)}</td></tr>`).join('');
  return `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Liga</th><th>Spiele</th><th>Pinnacle</th><th>Bet365</th><th>Pin. Tore</th><th>Schluss</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- Liniendiagramm (selbst gezeichnet als SVG) --------------------------------
// Breite passend zum Bildschirm, damit die Schrift auf dem Handy nicht winzig wird.
let W = 640, H = 260;
const PAD = { left: 40, right: 44, top: 12, bottom: 24 };

function chartHtml() {
  const series = data.strategies.filter(s => data.curves[s.key]?.length);
  if (!series.length) return '<div class="empty small">Keine Wetten im Test.</div>';
  W = Math.round(Math.min(640, Math.max(300, window.innerWidth - 62)));
  H = Math.round(W * 0.55);

  // Alle Kurven teilen sich eine Zeitachse und eine y-Achse
  const all = series.flatMap(s => data.curves[s.key]);
  const times = all.map(([d]) => Date.parse(d));
  const values = all.map(([, v]) => v).concat(0);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const v0 = Math.min(...values), v1 = Math.max(...values);
  const x = t => PAD.left + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = v => PAD.top + (v1 === v0 ? 0.5 : (v1 - v) / (v1 - v0)) * (H - PAD.top - PAD.bottom);

  const ticks = niceTicks(v0, v1, 4);
  let svg = ticks.map(t => `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="axis" x="${PAD.left - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  const years = [];
  for (let year = new Date(t0).getUTCFullYear() + 1; year <= new Date(t1).getUTCFullYear(); year++) years.push(year);
  svg += years.map(year => `<text class="axis" x="${x(Date.UTC(year, 0, 1))}" y="${H - 6}" text-anchor="middle">${year}</text>`).join('');

  for (const s of series) {
    const points = data.curves[s.key];
    const d = points.map(([date, v], i) => `${i ? 'L' : 'M'}${x(Date.parse(date)).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const [lastDate, lastValue] = points[points.length - 1];
    svg += `<path class="series" d="${d}" stroke="${COLORS[s.key]}"/>`;
    svg += `<text class="end-label" x="${x(Date.parse(lastDate)) + 6}" y="${y(lastValue) + 4}">${lastValue > 0 ? '+' : ''}${num(lastValue, 1)}</text>`;
  }
  svg += `<line class="cursor hidden" y1="${PAD.top}" y2="${H - PAD.bottom}"/>`;

  const legend = series.map(s => `<span><i style="background:${COLORS[s.key]}"></i>${esc(s.name)}</span>`).join('');
  chartGeometry = { series, x, t0, t1 };
  return `<div class="legend">${legend}</div><div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewinnverlauf der drei Strategien im Test">${svg}</svg><div class="tooltip hidden"></div></div>`;
}

let chartGeometry = null;

// Fadenkreuz + Tooltip: zeigt beim Darüberfahren den Stand jeder Kurve an diesem Datum
function attachChart() {
  const chart = view.querySelector('.chart');
  if (!chart || !chartGeometry) return;
  const svg = chart.querySelector('svg'), cursor = svg.querySelector('.cursor'), tip = chart.querySelector('.tooltip');
  const { series, x, t0, t1 } = chartGeometry;

  function show(event) {
    const box = svg.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width * W;
    const t = t0 + (px - PAD.left) / (W - PAD.left - PAD.right) * (t1 - t0);
    if (t < t0 || t > t1) { hide(); return; }
    const lines = series.map(s => {
      // letzter Punkt der Kurve vor dem Datum t
      const points = data.curves[s.key];
      let value = 0;
      for (const [date, v] of points) { if (Date.parse(date) <= t) value = v; else break; }
      return `<div><span style="color:${COLORS[s.key]}">●</span> ${esc(s.name)}: <b>${value > 0 ? '+' : ''}${num(value, 1)}</b></div>`;
    });
    cursor.setAttribute('x1', x(t)); cursor.setAttribute('x2', x(t));
    cursor.classList.remove('hidden');
    tip.innerHTML = `<div class="muted">${new Date(t).toLocaleDateString('de-CH', { month: 'short', year: 'numeric' })}</div>${lines.join('')}`;
    tip.classList.remove('hidden');
    const left = (x(t) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth)}px`;
    tip.style.top = '-8px';
  }
  function hide() { cursor.classList.add('hidden'); tip.classList.add('hidden'); }
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

// Schöne runde Achsenwerte (z.B. -20, 0, 20, 40)
function niceTicks(min, max, count) {
  const span = max - min || 1;
  const raw = span / count;
  const step = [1, 2, 5, 10].map(m => m * 10 ** Math.floor(Math.log10(raw))).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  return ticks;
}
