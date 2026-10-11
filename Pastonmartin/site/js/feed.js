// Sporttip-Nachrichten (von functions/api/sporttip.js) -> Spiele mit Quoten.
//
// Sporttip schickt Bausteine, die über Nummern ("urn") verknüpft sind:
//   Event      das Spiel:    { name: "SC Freiburg : Schalke 04", startTime, sport, markets: [Markt-urns] }
//   Market     die Wettart:  { type: "asw:markettype:18", properties: { total: 2.5 }, selections: [...] }
//   Selection  der Tipp:     { type: "asw:selectiontype:12", odds: 1.85, state: 1 }
// Spätere Nachrichten ergänzen oder ändern frühere Bausteine (z.B. eine neue Quote).
// Darum werden alle Bausteine zuerst in einer Map gesammelt und erst am Schluss zusammengesetzt.

const number = urn => Number(String(urn).split(':').pop());     // "asw:markettype:18" -> 18
const LINK = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;                   // sieht aus wie "/tennis/atp"

// "payload" ist mal eine Liste, mal ein JSON-Text mit einer Liste
function itemsOf(message) {
  const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
  return Array.isArray(payload) ? payload : [];
}

export function parseFeed(text) {
  const entities = new Map();        // urn -> Baustein
  const pages = [];
  let page = null;
  for (const line of text.split('\n')) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (typeof message.path === 'string') {               // hier beginnt eine neue Seite
      page = { path: message.path, found: message.found, fetched: message.fetched, answer: null,
        seen: new Set(), created: new Set(), other: [] };
      pages.push(page);
      continue;
    }
    let items;
    try { items = itemsOf(message); } catch { continue; }
    for (const item of items) {
      const updates = item.body?.snapshotUpdate?.snapshotUpdateItems;
      if (item.type === 'SportsbookPageRetrieved') {
        if (page && !page.answer) page.answer = item.body || {};
      } else if (!updates) {
        page?.other.push(item);                            // z.B. Antworten mit Unterkategorien
      }
      for (const { type, entity } of updates || []) {
        if (!entity?.urn) continue;
        if (!entities.has(entity.urn)) page?.created.add(entity.urn);   // zum ersten Mal gesehen
        entities.set(entity.urn, { ...entities.get(entity.urn), ...entity, entityType: type });
        page?.seen.add(entity.urn);
      }
    }
  }
  return pages.map(p => finishPage(p, entities));
}

function finishPage(page, entities) {
  // Die Spiele, die auf der Seite stehen. Fehlt diese Liste, die Spiele, die mit dieser Seite neu
  // dazukamen (nicht Live-Updates von Spielen einer früheren Seite).
  const listed = eventUrns(page.answer);
  const urns = listed.length ? listed : [...page.created].filter(urn => entities.get(urn)?.entityType === 'Event');
  return {
    path: page.path,
    found: page.found,
    fetched: page.fetched,
    redirect: page.answer?.categoryPath?.redirectToPath || null,
    events: urns.map(urn => buildEvent(entities.get(urn), entities)).filter(Boolean),
    debug: { answer: page.answer, other: page.other, seen: [...page.seen].map(urn => entities.get(urn)) },
  };
}

// Alle Spiele im verschachtelten Seitenaufbau ("viewNode")
function eventUrns(answer) {
  const found = new Set();
  const walk = node => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.eventUrn === 'string') found.add(node.eventUrn);
      Object.values(node).forEach(walk);
    }
  };
  walk(answer?.viewNode);
  return [...found];
}

// Ein Spiel mit allen offenen Wettarten:
//   { name, home, away, kickoff, sport: 1, markets: [{ type: 18, line: 2.5, odds: { 12: 1.85, 13: 1.95 } }] }
function buildEvent(event, entities) {
  if (!event?.name || !event.name.includes(' : ')) return null;     // ohne " : " ist es eine Langzeitwette
  const [home, away] = event.name.split(' : ');
  const markets = [];
  for (const urn of event.markets || []) {
    const market = entities.get(urn);
    if (!market || market.state !== 1) continue;                   // 1 = offen
    const odds = {};
    for (const selectionUrn of market.selections || []) {
      const selection = entities.get(selectionUrn);
      if (selection && selection.state === 1 && selection.odds > 1) odds[number(selection.type)] = selection.odds;
    }
    if (Object.keys(odds).length < 2) continue;
    const { mode, IsMainMarket, ...spec } = market.properties || {};
    markets.push({ type: number(market.type), line: spec.total ?? spec.hcp ?? null, spec, odds, live: mode === 'inplay' });
  }
  if (!markets.length) return null;
  return { urn: event.urn, name: event.name, home: home.trim(), away: away.trim(), kickoff: event.startTime,
    sport: number(event.sport), competition: event.competition || null, markets };
}

// --- "Pfad testen": kurze Zusammenfassung einer Seite ------------------------------------------
// Damit sieht man (und Claude), was Sporttip auf einer Seite schickt, ohne die Entwicklertools.
export function summarize(page) {
  const count = (list, key) => list.reduce((acc, x) => { const k = key(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const types = {};
  for (const event of page.events) {
    for (const m of event.markets) {
      const t = (types[m.type] ||= { count: 0, outcomes: new Set(), lines: new Set(), example: '' });
      t.count++;
      Object.keys(m.odds).forEach(o => t.outcomes.add(Number(o)));
      if (m.line != null) t.lines.add(m.line);
      t.example ||= `${event.name}: ${JSON.stringify(m.odds)}${m.line != null ? ` @ ${m.line}` : ''}`;
    }
  }
  const nodeTypes = {};
  const walk = node => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.type === 'string') nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
      Object.values(node).forEach(walk);
    }
  };
  walk(page.debug.answer?.viewNode);
  const unusual = page.debug.seen.filter(e => e && !['Event', 'Market', 'Selection'].includes(e.entityType));
  const short = x => JSON.stringify(x).slice(0, 500);
  return {
    path: page.path,
    found: page.found,
    redirect: page.redirect,
    events: page.events.length,
    sports: count(page.events, e => e.sport),
    sample: page.events.slice(0, 3).map(e => `${e.name} · ${e.kickoff}`),
    marketTypes: Object.fromEntries(Object.entries(types).map(([type, t]) =>
      [type, { count: t.count, outcomes: [...t.outcomes], lines: [...t.lines].slice(0, 8), example: t.example }])),
    entityTypes: count(page.debug.seen.filter(Boolean), e => e.entityType),
    viewNodes: nodeTypes,
    categoryPath: page.debug.answer?.categoryPath?.categories || null,
    viewConfig: page.debug.answer?.categoryPath?.viewConfig || null,
    links: findLinks(page),
    otherTypes: count(page.debug.other, i => i.type),
    samples: [...page.debug.other.slice(0, 2), ...unusual.slice(0, 2)].map(short),
  };
}

// Pfade (wie "/tennis/atp-paris"), die irgendwo in den Antworten stehen, mit einem Namen dazu
function findLinks(page) {
  const found = new Map();
  const visit = (node, label) => {
    if (Array.isArray(node)) { node.forEach(n => visit(n, label)); return; }
    if (!node || typeof node !== 'object') return;
    const name = node.name || node.title || node.displayName || label || '';
    for (const value of Object.values(node)) {
      if (typeof value === 'string' && LINK.test(value)) {
        if (value !== page.path && !found.has(value)) found.set(value, name);
      } else {
        visit(value, name);
      }
    }
  };
  visit(page.debug.answer?.viewNode, '');
  visit(page.debug.other, '');
  visit(page.debug.seen.filter(e => e && !['Event', 'Market', 'Selection'].includes(e.entityType)), '');
  return [...found].slice(0, 60).map(([path, name]) => ({ path, name }));
}
