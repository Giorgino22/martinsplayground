// Ansicht "Backtest": was das System in alten Saisons gemacht hätte, und was getestet wurde.
import { pct, signedPct, num, esc, formatStamp } from './util.js';

const view = document.getElementById('view-backtest');
const MARKET_NAMES = { '1X2': 'Sieger', OU: 'Tore 2.5', total: 'Alle' };
// Linien im Diagramm: gleiche Prognosen, aber Quoten von verschiedenen Orten
const LINES = [
  { key: 'combo|early|sporttip', name: 'Sporttip-Schätzung', color: 'var(--series-1)' },
  { key: 'combo|early|book', name: 'Bet365', color: 'var(--series-2)' },
  { key: 'combo|early|max', name: 'Höchstquote (Max)', color: 'var(--series-3)' },
];
let data = null;
let scenario = 'sporttip';
let timing = 'early';
let period = 'test';

export function initBacktest(backtest) {
  data = backtest;
  if (!data || data.version !== 2) {
    view.innerHTML = `<div class="empty">Noch kein Backtest vorhanden.<br><span class="small">Er läuft automatisch, sobald der GitHub-Roboter das nächste Mal startet.</span></div>`;
    return;
  }
  view.addEventListener('click', e => {
    const chip = e.target.closest('[data-scenario],[data-timing],[data-period]');
    if (!chip) return;
    if (chip.dataset.scenario) scenario = chip.dataset.scenario;
    if (chip.dataset.timing) timing = chip.dataset.timing;
    if (chip.dataset.period) period = chip.dataset.period;
    render();
  });
  render();
}

const cls = x => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const luck = p => (p == null ? '–' : p < 0.01 ? '< 1 %' : pct(p, 0));
const total = (key, t, s) => data.strategies.find(x => x.key === key).results[t][s].test.total;

// Die ehrliche Zusammenfassung oben
function verdict() {
  const s = total('combo', 'early', 'sporttip'), b = total('combo', 'early', 'book'), m = total('combo', 'early', 'max');
  const line = (name, r) => `${name}: ${r.bets || 0} Wetten, ROI ${r.bets ? signedPct(r.roi) : '–'}, CLV ${signedPct(r.clv)}`;
  const detail = [line('Sporttip-Schätzung', s), line('Bet365', b), line('Höchstquote', m)].join(' · ');
  if (s.bets && s.clv > 0 && s.p_luck < 0.05) {
    return ['good', 'Vielversprechend, sogar mit Sporttip-Quoten.', detail];
  }
  if ((b.clv || 0) > 0 || (m.clv || 0) > 0) {
    return ['neutral', 'Das System findet echten Value, aber nur, wenn die Quoten gut genug sind.',
      `${detail}. Ob Sporttip gut genug ist, zeigt die gemessene Sporttip-Marge im Tagebuch.`];
  }
  return ['bad', 'Im Test kein Vorteil.', detail];
}

function render() {
  const [tone, title, text] = verdict();
  const p = data.params;
  const months = Math.round(Math.log(2) / p.model.decay / 30.4);
  view.innerHTML = `
    <p class="small muted">Stand ${esc(formatStamp(data.generated))} · Anpassen: ${esc(data.seasons.tune)} · Test: ${esc(data.seasons.test)}</p>
    <div class="card ${tone === 'neutral' ? 'note' : `verdict-${tone}`}"><b>${esc(title)}</b><br><span class="small">${esc(text)}</span></div>

    <div class="card small">
      <b>Gewählt (nur mit den Anpassungs-Saisons):</b>
      <ul class="plain">
        <li>Marge herausrechnen: <b>${esc({ proportional: 'proportional', power: 'Power-Methode', shin: 'Shin-Methode' }[p.devig])}</b></li>
        <li>Kombination: <b>${esc(p.combine_name)}</b> (Modellgewicht Sieger ${pct(p.model_share['1X2'], 0)}, Tore ${pct(p.model_share.OU, 0)})</li>
        <li>Eigenes Modell: Spiele zählen nach ${months} Monaten halb, Schüsse aufs Tor ${pct(p.model.shots_weight, 0)}, Dixon-Coles ${p.model.rho}</li>
        <li>Wetten ab ${signedPct(p.edge['1X2'], 0)} Value (Sieger, Doppelte Chance), ${signedPct(p.edge.OU, 0)} (Tore 2.5),
          ${signedPct(p.edge.OU + p.derived_extra_edge, 0)} (Nebenmärkte); höchstens Quote ${num(p.max_odds['1X2'], 1)}</li>
      </ul>
      <span class="muted">Sporttip-Schätzung = Bet365-Quote minus ${pct(p.haircut, 0)}.</span>
    </div>

    <h2>Was getestet wurde</h2>
    <p class="small muted">Gewählt wird immer nur im Anpassungs-Zeitraum, sonst wäre der Test geschönt. Die fett markierte Zeile ist die gewählte.</p>
    ${data.experiments.map(experimentTable).join('')}

    <h2>Strategien im Vergleich</h2>
    <div class="toolbar">${Object.entries(data.scenarios).map(([k, n]) => chip('scenario', k, n, scenario)).join('')}</div>
    <div class="toolbar">${Object.entries(data.timings).map(([k, n]) => chip('timing', k, n, timing)).join('')}</div>
    <div class="toolbar">${chip('period', 'test', 'Test (ehrlich)', period)}${chip('period', 'tune', 'Anpassung (geschönt)', period)}</div>
    <div class="card">${strategyTable()}</div>
    <p class="small muted">ROI = Gewinn pro gesetztem Franken. CLV = wie viel besser deine Quote als die faire Schlussquote war (kurz vor Anpfiff nicht messbar). „Glück?“ = Wahrscheinlichkeit, so ein Resultat ohne echten Vorteil zu erzielen.</p>

    <h2>Gewinnverlauf im Test</h2>
    <div class="card">${chartHtml()}</div>
    <p class="small muted">Gleiche Prognosen, gleiche Regeln, nur andere Quoten. 1 Einheit pro Wette.</p>

    <h2>Nach Liga und Saison</h2>
    <p class="small muted">Kombination, früh gewettet, Test-Saisons, ${esc(data.scenarios[scenario])}.</p>
    <div class="card">${breakdownTable(data.by_league[scenario], 'name', 'Liga')}</div>
    <div class="card">${breakdownTable(data.by_season[scenario], 'season', 'Saison')}</div>

    <h2>Margen der Buchmacher</h2>
    <div class="card">${marginTable()}</div>

    <details class="card small"><summary>Mindest-Value: alle Einstellungen</summary>${tuningTable()}</details>
    <details class="card small"><summary>Nebenmärkte: Kalibrierung</summary>${calibrationTable()}</details>
    <details class="card small"><summary>Datenabdeckung</summary>${coverageTable()}</details>`;
  attachChart();
}

function chip(kind, value, label, current) {
  return `<button class="chip" data-${kind}="${value}" aria-pressed="${value === current}">${esc(label)}</button>`;
}

function format(kind, value) {
  if (value == null) return '–';
  if (kind === 'loss') return num(value, 4);
  if (kind === 'int') return String(value);
  if (kind === 'signed') return signedPct(value);
  if (kind === 'luck') return luck(value);
  if (kind === 'pct') return pct(value);
  return esc(value);
}

function experimentTable(table) {
  const head = table.columns.map(c => `<th>${esc(c.label)}</th>`).join('');
  const rows = table.rows.map(row => `<tr class="${row.chosen ? 'chosen' : ''}${row.reference ? ' reference' : ''}">${row.cells.map((value, i) => {
    const kind = table.columns[i].kind;
    const tone = kind === 'signed' ? ` class="${cls(value)}"` : '';
    return `<td${tone}>${format(kind, value)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="card"><h3>${esc(table.title)}</h3>
    <p class="small muted">${esc(table.note)} <i>${esc(table.metric)}</i></p>
    <div class="table-wrap"><table class="wrap-first"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function strategyTable() {
  let rows = '';
  for (const s of data.strategies) {
    rows += `<tr class="group"><td colspan="5">${esc(s.name)}</td></tr>`;
    for (const market of ['1X2', 'OU']) {
      const r = s.results[timing][scenario][period][market];
      const t = s.thresholds[market];
      rows += `<tr><td>${MARKET_NAMES[market]} <span class="small muted">ab ${signedPct(t.edge, 0)}, bis ${num(t.max_odds, 1)}</span></td>
        <td>${r.bets}</td><td class="${cls(r.roi)}">${r.bets ? signedPct(r.roi) : '–'}</td>
        <td class="${cls(r.clv)}">${signedPct(r.clv)}</td><td>${luck(r.p_luck)}</td></tr>`;
    }
  }
  const note = data.params.combine_name === 'Nur Markt'
    ? '<p class="small muted">Die Kombination ist hier gleich wie der Value-Finder: Das eigene Modell bekam 0 % Gewicht.</p>' : '';
  return `<div class="table-wrap"><table><thead><tr><th>Markt</th><th>Wetten</th><th>ROI</th><th>CLV</th><th>Glück?</th></tr></thead><tbody>${rows}</tbody></table></div>${note}`;
}

function breakdownTable(list, key, label) {
  if (!list?.length) return '<div class="empty small">Keine Wetten.</div>';
  const rows = list.map(r => `<tr><td>${esc(r[key])}</td><td>${r.bets}</td>
    <td class="${cls(r.roi)}">${signedPct(r.roi)}</td><td class="${cls(r.clv)}">${signedPct(r.clv)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>${label}</th><th>Wetten</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function marginTable() {
  const names = { reference: 'Pinnacle / Betfair', bet365: 'Bet365', sporttip: 'Sporttip-Schätzung', max: 'Höchstquote aller Buchmacher' };
  const rows = Object.entries(names).map(([key, name]) => `<tr><td>${name}</td>
    <td>${pct(data.margins['1X2'][key])}</td><td>${pct(data.margins.OU[key])}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Quelle</th><th>Sieger</th><th>Tore 2.5</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted">Marge = um wie viel die Quoten unter fair liegen. Negativ heisst: Wer überall die beste Quote nimmt, liegt sogar über fair.
      Deine echte Sporttip-Marge misst das Tagebuch.</p>`;
}

function tuningTable() {
  let rows = '';
  for (const [market, grid] of Object.entries(data.tuning_grid)) {
    const chosen = data.params.edge[market], chosenMax = data.params.max_odds[market];
    for (const g of grid.filter(x => x.bets >= 10)) {
      const mark = g.edge === chosen && g.max_odds === chosenMax ? ' class="chosen"' : '';
      rows += `<tr${mark}><td>${MARKET_NAMES[market]} ab ${signedPct(g.edge, 0)}, bis ${num(g.max_odds, 1)}</td><td>${g.bets}</td>
        <td class="${cls(g.clv)}">${signedPct(g.clv)}</td><td class="${cls(g.roi)}">${signedPct(g.roi)}</td></tr>`;
    }
  }
  return `<p class="muted">Anpassungs-Zeitraum, Bet365-Quoten. Gewählt wird der grösste Gesamt-CLV (mit genug Wetten).</p>
    <div class="table-wrap"><table><thead><tr><th>Einstellung</th><th>Wetten</th><th>CLV</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function calibrationTable() {
  return data.derived.map(d => `<h3>${esc(d.name)}</h3>
    <div class="table-wrap"><table><thead><tr><th>Erwartet</th><th>Eingetroffen</th><th>Spiele</th></tr></thead><tbody>
    ${d.bins.map(b => `<tr><td>${pct(b.predicted)}</td><td>${pct(b.actual)}</td><td>${b.games}</td></tr>`).join('')}
    </tbody></table></div>`).join('') + '<p class="muted">Liegen „Erwartet“ und „Eingetroffen“ nahe beieinander, stimmen die fairen Quoten der Nebenmärkte.</p>';
}

function coverageTable() {
  const columns = [['pinnacle', 'Pinnacle'], ['betfair', 'Betfair'], ['bet365', 'Bet365'], ['bet365_close', 'B365 Schluss'],
    ['max', 'Max'], ['reference_ou', 'Tore'], ['shots', 'Schüsse']];
  const rows = (data.coverage || []).map(c => `<tr><td>${esc(c.league)} ${c.season}</td><td>${c.games}</td>
    ${columns.map(([key]) => `<td>${pct(c[key], 0)}</td>`).join('')}</tr>`).join('');
  return `<p class="muted">Anteil Spiele mit diesen Daten.</p><div class="table-wrap"><table><thead><tr><th>Liga</th><th>Spiele</th>
    ${columns.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- Liniendiagramm (selbst gezeichnet als SVG) --------------------------------
// Breite passend zum Bildschirm, damit die Schrift auf dem Handy nicht winzig wird.
let W = 640, H = 260;
const PAD = { left: 40, right: 48, top: 12, bottom: 24 };
let chartGeometry = null;

function chartHtml() {
  const series = LINES.filter(line => data.curves[line.key]?.length);
  if (!series.length) return '<div class="empty small">Keine Wetten im Test.</div>';
  W = Math.round(Math.min(640, Math.max(300, window.innerWidth - 62)));
  H = Math.round(W * 0.55);

  // Alle Kurven teilen sich eine Zeitachse und eine y-Achse
  const all = series.flatMap(line => data.curves[line.key]);
  const times = all.map(([d]) => Date.parse(d));
  const values = all.map(([, v]) => v).concat(0);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const v0 = Math.min(...values), v1 = Math.max(...values);
  const x = t => PAD.left + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = v => PAD.top + (v1 === v0 ? 0.5 : (v1 - v) / (v1 - v0)) * (H - PAD.top - PAD.bottom);

  let svg = niceTicks(v0, v1, 4).map(t => `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="axis" x="${PAD.left - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  for (let year = new Date(t0).getUTCFullYear() + 1; year <= new Date(t1).getUTCFullYear(); year++) {
    svg += `<text class="axis" x="${x(Date.UTC(year, 0, 1))}" y="${H - 6}" text-anchor="middle">${year}</text>`;
  }
  for (const line of series) {
    const points = data.curves[line.key];
    const d = points.map(([date, v], i) => `${i ? 'L' : 'M'}${x(Date.parse(date)).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const [lastDate, lastValue] = points[points.length - 1];
    svg += `<path class="series" d="${d}" stroke="${line.color}"/>`;
    svg += `<text class="end-label" x="${x(Date.parse(lastDate)) + 6}" y="${y(lastValue) + 4}">${lastValue > 0 ? '+' : ''}${num(lastValue, 0)}</text>`;
  }
  svg += `<line class="cursor hidden" y1="${PAD.top}" y2="${H - PAD.bottom}"/>`;
  chartGeometry = { series, x, t0, t1 };
  const legend = series.map(line => `<span><i style="background:${line.color}"></i>${esc(line.name)}</span>`).join('');
  return `<div class="legend">${legend}</div><div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewinnverlauf im Test nach Quellen der Quoten">${svg}</svg><div class="tooltip hidden"></div></div>`;
}

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
    const lines = series.map(line => {
      let value = 0;   // letzter Punkt der Kurve vor dem Datum t
      for (const [date, v] of data.curves[line.key]) { if (Date.parse(date) <= t) value = v; else break; }
      return `<div><span style="color:${line.color}">●</span> ${esc(line.name)}: <b>${value > 0 ? '+' : ''}${num(value, 1)}</b></div>`;
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
