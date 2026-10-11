// Teamnamen vergleichen: Die Odds API schreibt "Manchester United", football-data "Man United".
// Gleiche Idee wie match_team() in engine/oddsapi.py.

const FILLER = new Set(['fc', 'afc', 'cf', 'sc', 'sv', 'ac', 'as', 'ss', 'us', 'fk', 'bsc', 'vfb', 'vfl',
  'tsg', '1', 'club', 'de', 'the', 'calcio']);

// "1. FC Köln" -> "koln"
function simplify(name) {
  const words = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  const kept = words.filter(w => !FILLER.has(w));
  return (kept.length ? kept : words).join(' ');
}

// Ähnlichkeit 0..1: Anteil gemeinsamer Buchstabenpaare ("Dice-Koeffizient")
function similarity(a, b) {
  const pairs = s => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const x = pairs(a), y = pairs(b);
  if (!x.size || !y.size) return a === b ? 1 : 0;
  let common = 0;
  for (const pair of x) if (y.has(pair)) common++;
  return (2 * common) / (x.size + y.size);
}

// Wörter, die viele Teams im Namen haben: Sie zählen nicht als Gemeinsamkeit
const COMMON = new Set(['united', 'city', 'town', 'county', 'real', 'sporting', 'athletic', 'atletico', 'racing',
  'olympique', 'dynamo', 'inter', 'sport', 'team', 'women', 'u19', 'u21', 'u23']);

// Anteil gemeinsamer Wörter: "sinner j" und "jannik sinner" teilen 1 von 1 Wort -> 1
function sharedWords(x, y) {
  const words = s => new Set(s.split(' ').filter(w => w.length >= 3 && !COMMON.has(w)));
  const a = words(x), b = words(y);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / Math.min(a.size, b.size);
}

// Wie ähnlich sind zwei Namen? 1 = gleich, 0 = nichts gemeinsam.
// Buchstabenpaare helfen bei Schreibweisen ("München"/"Munich"), gemeinsame Wörter bei
// vertauschten oder abgekürzten Vornamen ("Sinner J."/"Jannik Sinner").
export function teamScore(a, b, aliases = {}) {
  if (a === b || aliases[a] === b) return 1;
  const x = simplify(a), y = simplify(b);
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  return Math.max(similarity(x, y), 0.9 * sharedWords(x, y));
}

export function sameTeam(apiName, ourName, aliases = {}) {
  if (apiName === ourName || aliases[apiName] === ourName) return true;
  const a = simplify(apiName), b = simplify(ourName);
  return a === b || a.includes(b) || b.includes(a) || similarity(a, b) >= 0.75;
}

// Gleiches Spiel? Gleiche Teams und Anpfiff höchstens 36 Stunden auseinander
export function sameMatch(event, match, aliases) {
  const hours = match.kickoff ? Math.abs(new Date(event.kickoff) - new Date(match.kickoff)) / 3600e3 : 0;
  return hours < 36 && sameTeam(event.home, match.home, aliases) && sameTeam(event.away, match.away, aliases);
}
