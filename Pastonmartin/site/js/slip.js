// Kombi-Schein: mehrere Value-Tipps aus verschiedenen Spielen zu einer Wette verbinden.
//
// Quoten und Chancen multiplizieren sich. Hat jeder Tipp Value, hat die Kombi sogar
// mehr Value (z.B. 2 x +5 % = +10.25 %). Dafür gewinnt sie seltener und schwankt stärker,
// darum ist der Kelly-Einsatz kleiner.
import { pct, signedPct, num, chf, esc, store, kellyStake } from './util.js';
import { addBet } from './journal.js';

const box = document.getElementById('slip');
let settings = { kelly_fraction: 0.25, max_stake: 0.02 };

export function initSlip(tips) {
  if (tips) settings = { kelly_fraction: tips.kelly_fraction, max_stake: tips.max_stake };
  box.addEventListener('click', onClick);
  document.addEventListener('bankroll-changed', render);
  render();
}

// Einsatz in CHF nach Bruchteil-Kelly
export function stakeFor(p, odds) {
  return store.get('bankroll', 500) * kellyStake(p, odds, settings.kelly_fraction, settings.max_stake);
}
export const stakeText = stake => (stake < 1 ? 'Einsatz unter CHF 1 (zu klein)' : `Einsatz ${chf(stake)}`);

// leg = { id, key, odds, p, label, match, kickoff, match_id }  (pro Spiel nur ein Tipp)
// match_id nur bei Fussball: damit rechnet das Tagebuch die Kombi automatisch ab.
export function addToSlip(leg) {
  const legs = store.get('slip', []).filter(l => l.id !== leg.id);
  legs.push(leg);
  store.set('slip', legs);
  render();
}

function currentLegs() {
  // begonnene Spiele fliegen raus
  const legs = store.get('slip', []).filter(l => !l.kickoff || new Date(l.kickoff) > Date.now());
  store.set('slip', legs);
  return legs;
}

function totals(legs) {
  const odds = legs.reduce((x, leg) => x * leg.odds, 1);
  const p = legs.reduce((x, leg) => x * leg.p, 1);
  return { odds, p, edge: p * odds - 1 };
}

function render() {
  const legs = currentLegs();
  if (!legs.length) { box.classList.add('hidden'); return; }
  const { odds, p, edge } = totals(legs);
  const open = store.get('slipOpen', false);
  box.classList.remove('hidden');
  box.innerHTML = `
    <button class="slip-head" data-toggle aria-expanded="${open}">
      <span><b>Kombi · ${legs.length} ${legs.length === 1 ? 'Tipp' : 'Tipps'}</b> · Quote ${num(odds)}</span>
      <span>${signedPct(edge)} ${open ? '▾' : '▴'}</span>
    </button>
    ${open ? `<div class="slip-body">
      ${legs.map(leg => `<div class="slip-leg"><span>${esc(leg.match)}<br>
        <span class="small muted">${esc(leg.label)} @ ${num(leg.odds)}</span></span>
        <button class="close" data-remove="${esc(leg.id)}" aria-label="Entfernen">✕</button></div>`).join('')}
      <div class="small muted">Chance, dass alles eintrifft: ${pct(p)} · ${legs.length > 1 ? stakeText(stakeFor(p, odds)) : 'mindestens 2 Tipps nötig'}</div>
      <div class="actions"><button class="primary" data-save ${legs.length < 2 || edge <= 0 ? 'disabled' : ''}>Kombi ins Tagebuch</button>
        <button class="ghost" data-clear>Leeren</button></div>
    </div>` : ''}`;
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.toggle !== undefined) store.set('slipOpen', !store.get('slipOpen', false));
  if (button.dataset.remove) store.set('slip', store.get('slip', []).filter(l => l.id !== button.dataset.remove));
  if (button.dataset.clear !== undefined) store.set('slip', []);
  if (button.dataset.save !== undefined) {
    const legs = currentLegs();
    const { odds, p } = totals(legs);
    button.disabled = true;
    try {
      await addBet({
        match: `Kombi (${legs.length} Tipps)`, market: 'KOMBI', label: legs.map(l => l.label).join(' + '),
        kickoff: legs.map(l => l.kickoff).filter(Boolean).sort().pop() || null,
        odds: Math.round(odds * 100) / 100, stake: Math.max(1, Math.round(stakeFor(p, odds))), p, fair: 1 / p,
        legs: legs.map(l => ({ match_id: l.match_id ?? null, match: l.match,
          selection: l.key, label: l.label, odds: l.odds, p: l.p })),
      });
      store.set('slip', []);
    } catch (error) {
      alert(error.message);
    }
  }
  render();
}
