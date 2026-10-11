// Sporttip: Seiten holen (über functions/api/sporttip.js), Wettarten verstehen,
// Sporttip-Spiele den Spielen mit fairen Quoten zuordnen.

import { teamScore } from './teams.js';
import { store } from './util.js';
import { parseFeed } from './feed.js';

// --- Welche Seiten? --------------------------------------------------------------------------
// Pfad = der Teil der Adresse auf swisslos.ch nach ".../sporttip/sportwetten".
// Bundesliga ist geprüft, die anderen sind nach demselben Muster geraten. Stimmt einer nicht,
// kann man ihn in der App ändern (aus der Adresszeile kopieren) oder mit "Pfad testen" prüfen.
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

// Für "Alle Sportarten": ganze Sportarten statt einzelner Ligen
export const DEFAULT_SPORT_PATHS = ['/fussball', '/tennis', '/eishockey', '/basketball', '/american-football', '/baseball', '/handball'];

// --- Welche Wettart ist was? -------------------------------------------------------------------
// Die Nummern folgen dem Sportradar-Format, dem Standard der Wettbranche.
// Mit echten Sporttip-Daten geprüft: 1 (Sieger 1X2) und 18 (Über/Unter). Die anderen folgen demselben
// Format. Zur Sicherheit prüft plausible() jede Wettart gegen die faire Chance, bevor sie zählt.
//   kind      win3 = Sieger mit Unentschieden, win2 = Sieger ohne Unentschieden, total = Über/Unter,
//             dc = Doppelte Chance, dnb = Unentschieden keine Wette, btts = Beide treffen
//   soccer    nur im Fussball (sonst nur in den anderen Sportarten)
//   football  Name des Marktes im Fussball-Tab (siehe tips.json, market_defs)
//   outcomes  Sporttip-Tipp-Nummer -> unser Kürzel
export const MARKET_TYPES = {
  1: { kind: 'win3', soccer: true, football: '1X2', outcomes: { 1: 'H', 2: 'D', 3: 'A' } },
  10: { kind: 'dc', soccer: true, football: 'DC', outcomes: { 9: '1X', 10: '12', 11: 'X2' } },
  11: { kind: 'dnb', soccer: true, outcomes: { 4: 'H', 5: 'A' } },
  29: { kind: 'btts', soccer: true, football: 'BTTS', outcomes: { 74: 'BY', 76: 'BN' } },
  18: { kind: 'total', soccer: true, football: 'OU', outcomes: { 12: 'O', 13: 'U' } },
  186: { kind: 'win2', outcomes: { 4: 'H', 5: 'A' } },      // Sieger (Tennis, Darts, Volleyball, …)
  219: { kind: 'win2', outcomes: { 4: 'H', 5: 'A' } },      // Sieger inkl. Verlängerung (Basketball, American Football)
  406: { kind: 'win2', outcomes: { 4: 'H', 5: 'A' } },      // Sieger inkl. Verlängerung und Penaltyschiessen (Eishockey)
  251: { kind: 'win2', outcomes: { 4: 'H', 5: 'A' } },      // Sieger inkl. Extra-Innings (Baseball)
  225: { kind: 'total', outcomes: { 12: 'O', 13: 'U' } },   // Total inkl. Verlängerung
  189: { kind: 'total', outcomes: { 12: 'O', 13: 'U' } },   // Total Games (Tennis)
};

// Stehen die Teams bei Sporttip andersherum, gehört "Heim" zum anderen Team
export const SWAP = { H: 'A', A: 'H', '1X': 'X2', X2: '1X' };

// Für den Fussball-Tab: Sporttip-Spiel -> { '1X2': { H: 1.85, D: 4.1, A: 3.6 }, OU: { O: 1.35, U: 2.95 }, … }
const TOTAL_SUFFIX = { 1.5: '15', 2.5: '', 3.5: '35' };
export function footballOdds(event) {
  const result = {};
  for (const market of event.markets) {
    const def = MARKET_TYPES[market.type];
    if (market.live || !def?.football) continue;
    let name = def.football;
    let outcomes = def.outcomes;
    if (name === 'OU') {                                  // Über/Unter gibt es für viele Linien
      const suffix = TOTAL_SUFFIX[market.line];
      if (suffix === undefined) continue;
      name = `OU${suffix}`;
      outcomes = { 12: `O${suffix}`, 13: `U${suffix}` };
    }
    const odds = {};
    for (const [id, key] of Object.entries(outcomes)) if (market.odds[id]) odds[key] = market.odds[id];
    // nur vollständige Märkte (sonst lässt sich weder prüfen noch die Marge messen).
    // Gibt es eine Wettart doppelt, zählt die erste.
    if (Object.keys(odds).length === Object.keys(outcomes).length && !result[name]) result[name] = odds;
  }
  return result;
}

// Passt dieser Sporttip-Markt zur fairen Chance? Ohne Marge darf keine Chance mehr als
// 8 Prozentpunkte abweichen, und kein Value über 25 %. Sonst ist es fast sicher ein anderer Markt
// (z.B. nur die erste Halbzeit) oder die Teams sind vertauscht, und die Wette zählt nicht.
export function plausible(chances, odds) {
  const implied = odds.map(o => 1 / o);
  const scale = chances.reduce((a, b) => a + b, 0) / implied.reduce((a, b) => a + b, 0);
  return implied.every((q, i) => Math.abs(q * scale - chances[i]) <= 0.08)
    && odds.every((o, i) => chances[i] * o - 1 <= 0.25);
}

// --- Zuordnen ---------------------------------------------------------------------------------
// Fussball-Tab: Welches Sporttip-Spiel gehört zu welchem unserer Spiele?
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

// Alle Sportarten: Sporttip-Spiel -> Spiel bei The Odds API ({ id, home, away, kickoff }).
// Auch andersherum (bei Tennis ist die Reihenfolge der Spieler nicht festgelegt).
// Anpfiff höchstens 20 Minuten auseinander, oder (Tennis-Zeiten sind ungenau) bis 18 Stunden
// mit sehr ähnlichen Namen.
export function matchApiEvent(event, apiEvents) {
  let best = null;
  for (const api of apiEvents) {
    const minutes = Math.abs(new Date(api.kickoff) - new Date(event.kickoff)) / 60e3;
    if (!(minutes <= 18 * 60)) continue;
    const need = minutes <= 20 ? { each: 0.35, both: 1.2 } : { each: 0.6, both: 1.5 };
    for (const swapped of [false, true]) {
      const home = teamScore(event.home, swapped ? api.away : api.home);
      const away = teamScore(event.away, swapped ? api.home : api.away);
      const score = home + away - minutes / 1e4;             // bei Gleichstand gewinnt die nähere Zeit
      if (Math.min(home, away) >= need.each && home + away >= need.both && (!best || score > best.score)) {
        best = { api, swapped, score };
      }
    }
  }
  return best;
}

// --- Holen ------------------------------------------------------------------------------------
// Fragt unsere Cloudflare-Function. Höchstens 4 Seiten pro Aufruf (mit allen Wettarten 3),
// die Aufrufe nacheinander: So bleibt jeder Aufruf kurz und Sporttip wird nicht überlastet.
export async function fetchSporttip(paths, { all = false, tree = false } = {}, onProgress = () => {}) {
  const size = all ? 3 : 4;
  const pages = [];
  for (let i = 0; i < paths.length; i += size) {
    onProgress(i, paths.length);
    pages.push(...parseFeed(await fetchText(paths.slice(i, i + size), all, tree)));
  }
  onProgress(paths.length, paths.length);
  return pages;
}

async function fetchText(paths, all, tree) {
  const query = new URLSearchParams({ paths: paths.join(','), all: all ? '1' : '0', tree: tree ? '1' : '0' });
  let response;
  try {
    response = await fetch(`/api/sporttip?${query}`);
  } catch {
    throw new Error('Keine Verbindung.');
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('json')) {
    const body = await response.json();
    throw new Error(body.error || `Fehler ${response.status}`);
  }
  if (!response.ok || !type.includes('text/plain')) {
    throw new Error('Sporttip scannen geht nur auf der echten Website (Cloudflare).');
  }
  return response.text();
}
