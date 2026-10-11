// Live-Quoten von The Odds API: die scharfen Quoten (Pinnacle, sonst Betfair) einer Liga.
//
//   GET /api/odds?sport=soccer_epl   Spiele mit Sieger- und Über/Unter-Quoten
//   GET /api/odds?list=1             alle Sportarten, die gerade laufen (kostet nichts)
//
// Einrichten in Cloudflare Pages: Variable ODDS_API_KEY (gratis bei the-odds-api.com).
// Ist JOURNAL_KEY gesetzt, braucht es denselben Schlüssel wie fürs Tagebuch, damit
// niemand Fremdes die Abfragen (500 gratis pro Monat) aufbraucht.
// Jede Liga wird 5 Minuten zwischengespeichert: mehrfaches Tippen kostet nichts extra.

const BOOKMAKERS = ['pinnacle', 'betfair_ex_eu'];      // in dieser Reihenfolge bevorzugt
const NAMES = { pinnacle: 'Pinnacle', betfair_ex_eu: 'Betfair' };
const API = 'https://api.the-odds-api.com/v4/sports';

const json = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function onRequestGet({ request, env, waitUntil }) {
  if (!env.ODDS_API_KEY) return json({ error: 'Live-Quoten sind nicht eingerichtet (ODDS_API_KEY fehlt)' }, 503);
  if (env.JOURNAL_KEY && request.headers.get('x-journal-key') !== env.JOURNAL_KEY) {
    return json({ error: 'Falscher Schlüssel' }, 401);
  }
  const params = new URL(request.url).searchParams;
  const sport = params.get('sport') || '';
  const listing = params.has('list');
  if (!listing && !/^[a-z0-9_]{3,60}$/.test(sport)) return json({ error: 'Unbekannte Sportart' }, 400);

  // Zwischenspeicher von Cloudflare: gleiche Abfrage innert kurzer Zeit -> keine neue Abfrage
  const cacheKey = new Request(new URL(`/__cache/odds/${listing ? 'list' : sport}`, request.url));
  const cached = await caches.default.match(cacheKey);
  if (cached) return json(await cached.text());

  const url = listing
    ? `${API}?apiKey=${env.ODDS_API_KEY}`
    : `${API}/${sport}/odds?apiKey=${env.ODDS_API_KEY}&bookmakers=${BOOKMAKERS.join(',')}`
      + '&markets=h2h,totals&oddsFormat=decimal';
  const response = await fetch(url);
  if (!response.ok) return json({ error: `Odds API antwortet mit ${response.status}` }, 502);
  const data = await response.json();

  const body = JSON.stringify(listing
    ? { sports: data.filter(s => s.active && !s.has_outrights).map(s => ({ key: s.key, group: s.group, title: s.title })) }
    : { fetched: new Date().toISOString(), remaining: response.headers.get('x-requests-remaining'),
        events: data.map(simplify).filter(Boolean) });
  waitUntil(caches.default.put(cacheKey, new Response(body, {
    headers: { 'cache-control': `public, max-age=${listing ? 43200 : 300}` },
  })));
  return json(body);
}

// Pro Spiel nur das Nötige, vom besten verfügbaren Buchmacher:
//   h2h    = Sieger: [Heim, Remis, Gast] (Fussball) oder [Heim, Gast] (z.B. Tennis)
//   totals = Über/Unter-Linien [{ point, over, under }], die ausgeglichenste (Hauptlinie) zuerst
function simplify(event) {
  for (const key of BOOKMAKERS) {
    const book = (event.bookmakers || []).find(b => b.key === key);
    const h2h = book?.markets.find(m => m.key === 'h2h');
    if (!h2h) continue;
    const price = name => h2h.outcomes.find(o => o.name === name)?.price;
    const winner = h2h.outcomes.length === 3
      ? [price(event.home_team), price('Draw'), price(event.away_team)]
      : [price(event.home_team), price(event.away_team)];
    if (!winner.every(Boolean)) continue;
    return {
      home: event.home_team,
      away: event.away_team,
      kickoff: event.commence_time,
      source: NAMES[key],
      h2h: winner,
      totals: totalLines(book.markets.find(m => m.key === 'totals')),
    };
  }
  return null;
}

// Alle vollständigen Über/Unter-Linien, die ausgeglichenste (die "Hauptlinie") zuerst
function totalLines(market) {
  if (!market) return [];
  const lines = {};
  for (const o of market.outcomes) {
    lines[o.point] = { ...lines[o.point], point: o.point, [o.name === 'Over' ? 'over' : 'under']: o.price };
  }
  const complete = Object.values(lines).filter(l => l.over && l.under);
  return complete.sort((a, b) => Math.abs(a.over - a.under) - Math.abs(b.over - b.under));
}
