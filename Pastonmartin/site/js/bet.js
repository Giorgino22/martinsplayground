// Bausteine, die die Fussball- und die Sport-Ansicht teilen:
// Zelle im Raster, Eingabefeld für die Sporttip-Quote und das Value-Resultat.
//
// Eine "Wette" ist hier immer ein Objekt mit:
//   key, short, name   z.B. "H", "1", "Heimsieg"
//   p, fair, min_odds  faire Chance, faire Quote, Mindestquote
//   edge, max_odds     verlangter Mindest-Value und höchste erlaubte Quote
import { pct, signedPct, num, esc, store } from './util.js';
import { stakeFor, stakeText } from './slip.js';

export const isValue = (bet, odds) => odds <= bet.max_odds && bet.p * odds - 1 >= bet.edge;

// Zelle im Raster: zeigt die Mindestquote, oder die eingetragene Sporttip-Quote (grün/grau)
export function cellHtml(id, bet, entered, isActive) {
  const tooLong = bet.min_odds > bet.max_odds;
  const classes = ['cell'];
  let main = tooLong ? '–' : num(bet.min_odds);
  if (entered) {
    main = num(entered);
    classes.push(isValue(bet, entered) ? 'value' : 'novalue');
  } else if (tooLong) {
    classes.push('off');
  }
  if (isActive) classes.push('active');
  return `<button class="${classes.join(' ')}" data-id="${esc(id)}" data-key="${esc(bet.key)}" aria-label="${esc(bet.name)}">
    <span class="cell-label">${esc(bet.short)}</span><span class="cell-odds">${main}</span></button>`;
}

// Eingabefeld unter einem Spiel
export function panelHtml(bet, inputText, note = '') {
  const details = [`Chance ${pct(bet.p)}`, `faire Quote ${num(bet.fair)}`];
  if (bet.p_model != null) details.push(`Modell ${pct(bet.p_model, 0)}`);
  if (bet.p_market != null && bet.p_model != null) details.push(`Markt ${pct(bet.p_market, 0)}`);
  const tooLong = bet.min_odds > bet.max_odds;
  return `
    <div class="panel-head"><b>${esc(bet.short)} · ${esc(bet.name)}</b><button class="close" data-close aria-label="Schliessen">✕</button></div>
    <div class="small muted">${details.join(' · ')}${note ? ` · ${esc(note)}` : ''}</div>
    <div class="small">${tooLong
      ? `Nicht wetten: Die nötige Quote (${num(bet.min_odds)}) liegt über der Höchstquote ${num(bet.max_odds, 1)}.`
      : `Wetten ab Quote <b>${num(bet.min_odds)}</b> (bis höchstens ${num(bet.max_odds, 1)}).`}</div>
    <label class="field odds-field">Sporttip-Quote <input id="odds-input" inputmode="decimal" autocomplete="off" placeholder="z.B. 2.15" value="${esc(inputText)}"></label>
    <div id="panel-result"></div>
    <div class="margin-hint" id="margin-hint"></div>`;
}

// Was bedeutet die eingetragene Quote? Value + Einsatz, oder warum nicht
export function resultHtml(bet, odds) {
  if (!odds) return '';
  if (odds > bet.max_odds) {
    return `<div class="sel-result novalue">Quote über ${num(bet.max_odds, 1)}: laut Backtest zu viel Zufall</div>`;
  }
  const edge = bet.p * odds - 1;
  if (edge >= bet.edge) {
    return `<div class="sel-result value"><span><b>${signedPct(edge)} Value</b> · ${stakeText(stakeFor(bet.p, odds))}</span>
      <span class="actions"><button class="primary" data-add>Ins Tagebuch</button><button class="ghost" data-slip>+ Kombi</button></span></div>`;
  }
  return `<div class="sel-result novalue">${edge > 0
    ? `${signedPct(edge)}: zu wenig Value (mind. ${signedPct(bet.edge, 0)})` : `Kein Value (${signedPct(edge)})`}</div>`;
}

// Sporttip-Marge eines Marktes, sobald alle Quoten eingetragen sind.
// Jede Messung wird gemerkt: Das Tagebuch zeigt den Durchschnitt. Diese Zahl entscheidet,
// ob sich Sporttip überhaupt lohnt (Bet365 hat ca. 5 %, mit 10 % wird Value sehr selten).
export function marginText(marketId, allOdds) {
  if (allOdds.length < 2 || !allOdds.every(Boolean)) return '';
  const margin = allOdds.reduce((sum, o) => sum + 1 / o, 0) - 1;
  const saved = store.get('sporttipMargins', {});
  saved[marketId] = { margin, date: new Date().toISOString().slice(0, 10) };
  store.set('sporttipMargins', saved);
  return `Sporttip-Marge auf diesem Markt: ${pct(margin)}`;
}
