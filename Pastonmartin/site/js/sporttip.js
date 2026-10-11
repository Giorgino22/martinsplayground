// "Sporttip scannen": holt die echten Sporttip-Quoten (functions/api/sporttip.js) und
// ordnet sie unseren Spielen zu. Danach trägt die App sie ein, als hättest du sie getippt.

import { teamScore } from './teams.js';
import { store } from './util.js';

// Liga -> Pfad auf swisslos.ch (der Teil nach ".../sporttip/sportwetten").
// Bundesliga ist geprüft, die anderen sind nach demselben Muster geraten.
// Stimmt einer nicht, kann man ihn in der App ändern (dann aus der Adresszeile kopieren).
export const DEFAULT_PATHS = {
  E0: '/fussball/england/premier-league',
  E1: '/fussball/england/championship',
  D1: '/fussball/deutschland/bundesliga',
  D2: '/fussball/deutschland/2-bundesliga',
  I1: '/fussball/italien/serie-a',
  SP1: '/fussball/spanien/laliga',
  F1: '/fussball/frankreich/ligue-1',
  N1: '/fussball/niederlande/eredivisie',
  SWZ: '/fussball/schweiz/super-league',
};
export const pathsFor = () => ({ ...DEFAULT_PATHS, ...store.get('sporttipPaths', {}) });

// Sporttip-Nummern -> unsere Wetten.
// Markttyp 1 = Sieger (Tipp 1/2/3 = Heim/Remis/Gast), Markttyp 18 = Über/Unter (Tipp 12 = Über, 13 = Unter)
const WINNER = { market: '1X2', keys: { 1: 'H', 2: 'D', 3: 'A' } };
const TOTALS = {
  1.5: { market: 'OU15', keys: { 12: 'O15', 13: 'U15' } },
  2.5: { market: 'OU', keys: { 12: 'O', 13: 'U' } },
  3.5: { market: 'OU35', keys: { 12: 'O35', 13: 'U35' } },
};

// Ein Sporttip-Spiel -> { '1X2': { H: 1.85, D: 4.1, A: 3.6 }, OU: { O: 1.35, U: 2.95 }, ... }
export function oddsByMarket(event) {
  const result = {};
  for (const market of event.markets) {
    const mapping = market.type === 1 ? WINNER : market.type === 18 ? TOTALS[market.line] : null;
    if (!mapping) continue;
    const odds = {};
    for (const [number, key] of Object.entries(mapping.keys)) {
      if (market.odds[number]) odds[key] = market.odds[number];
    }
    // nur vollständige Märkte (sonst lässt sich die Marge nicht messen)
    if (Object.keys(odds).length === Object.keys(mapping.keys).length) result[mapping.market] = odds;
  }
  return result;
}

// Welches Sporttip-Spiel gehört zu welchem unserer Spiele?
// Sporttip schreibt "Bayern München", football-data "Bayern Munich". Darum: gleiche Anpfiffzeit
// (höchstens 20 Minuten Unterschied) und möglichst ähnliche Teamnamen.
export function matchEvents(events, matches, aliases = {}) {
  const pairs = new Map();          // unsere Spiel-ID -> Sporttip-Spiel
  for (const match of matches) {
    let best = null, bestScore = 0;
    for (const event of events) {
      const minutes = Math.abs(new Date(event.kickoff) - new Date(match.kickoff)) / 60e3;
      if (!(minutes <= 20)) continue;
      const home = teamScore(event.home, match.home, aliases), away = teamScore(event.away, match.away, aliases);
      const score = home + away;
      if (Math.min(home, away) >= 0.35 && score >= 1.2 && score > bestScore) { best = event; bestScore = score; }
    }
    if (best) pairs.set(match.id, best);
  }
  return pairs;
}

// Fragt unsere Cloudflare-Function nach mehreren Ligen auf einmal
export async function fetchSporttip(paths) {
  let response;
  try {
    response = await fetch(`/api/sporttip?paths=${encodeURIComponent(paths.join(','))}`);
  } catch {
    throw new Error('Keine Verbindung.');
  }
  if (!(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('Sporttip scannen geht nur auf der echten Website (Cloudflare).');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Fehler ${response.status}`);
  return body.pages;
}
