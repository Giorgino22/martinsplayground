// Sporttip-Quoten holen (mit Erlaubnis von Swisslos, nur für den privaten Gebrauch).
//
//   GET /api/sporttip?paths=/fussball/deutschland/bundesliga,/fussball/england/premier-league
//
// So macht es auch die Swisslos-Seite: Sie öffnet eine WebSocket-Verbindung zu Admiral
// (der Firma hinter Sporttip) und fragt dort nach einer Seite, z.B. "/fussball/deutschland/bundesliga".
// Jede Nachricht ist JSON, mit "deflate-raw" komprimiert (wie eine ZIP-Datei ohne Kopf).
//
// Die Antwort kommt in drei Arten von Bausteinen, die über Nummern ("urn") verknüpft sind:
//   Event      das Spiel:  { name: "SC Freiburg : Schalke 04", startTime, markets: [Markt-urns] }
//   Market     die Wettart: { type: "asw:markettype:1", properties: { total: 2.5 }, selections: [...] }
//   Selection  der Tipp:   { type: "asw:selectiontype:1", odds: 1.85 }
// Diese Function setzt die Bausteine zu einer einfachen Liste zusammen.
//
// Rücksichtsvoll: Eine einzige Verbindung für alle Ligen, Ligen nacheinander, jede Liga
// 5 Minuten zwischengespeichert. Nichts wird dauerhaft gespeichert.

const SOCKET = 'https://ws.ch.admiral.at/';           // wss:// – Cloudflare will hier https:// sehen
const ORIGIN = 'https://www.swisslos.ch';
const CACHE_SECONDS = 300;
const QUIET_MS = 800;        // so lange keine neue Nachricht = die Seite ist fertig geladen
const PAGE_TIMEOUT_MS = 8000;
const MAX_PATHS = 12;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export async function onRequestGet({ request, waitUntil }) {
  const paths = (new URL(request.url).searchParams.get('paths') || '').split(',').filter(Boolean);
  if (!paths.length || paths.length > MAX_PATHS || !paths.every(p => /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(p))) {
    return json({ error: 'Ungültige Liga-Pfade' }, 400);
  }

  // Zuerst im Zwischenspeicher schauen, nur Fehlendes bei Sporttip holen
  const cacheKey = path => new Request(new URL(`/__cache/sporttip${path}`, request.url));
  const pages = {};
  for (const path of paths) {
    const cached = await caches.default.match(cacheKey(path));
    if (cached) pages[path] = await cached.json();
  }
  const missing = paths.filter(path => !pages[path]);
  if (missing.length) {
    let fresh;
    try {
      fresh = await fetchPages(missing);
    } catch (error) {
      return json({ error: `Sporttip nicht erreichbar: ${error.message}` }, 502);
    }
    for (const path of missing) {
      pages[path] = fresh[path];
      if (fresh[path].found) {
        waitUntil(caches.default.put(cacheKey(path), new Response(JSON.stringify(fresh[path]), {
          headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` },
        })));
      }
    }
  }
  return json({ pages });
}

// --- Verbindung -------------------------------------------------------------------------

async function fetchPages(paths) {
  const response = await fetch(SOCKET, { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`keine WebSocket-Verbindung (${response.status})`);
  socket.accept();

  const entities = new Map();          // urn -> Baustein (Event, Market, Selection)
  const answers = new Map();           // requestId -> Antwort "SportsbookPageRetrieved"
  let lastMessage = Date.now();
  socket.addEventListener('message', async event => {
    lastMessage = Date.now();
    try {
      for (const item of await decodeFrame(event.data)) {
        if (item.type === 'SportsbookPageRetrieved') answers.set(item.requestId, item.body);
        for (const update of item.body?.snapshotUpdate?.snapshotUpdateItems || []) {
          const { urn } = update.entity || {};
          if (urn) entities.set(urn, { ...entities.get(urn), ...update.entity, kind: update.type });
        }
      }
    } catch { /* unbekannte Nachricht: überspringen */ }
  });

  const result = {};
  try {
    await send(socket, { connect: { headers: {} }, properties: { type: 'binary', service: 'sportsbook' } });
    // Eine Liga nach der anderen: anfragen, auf die Antwort warten, bis Ruhe ist
    for (const path of paths) {
      const requestId = crypto.randomUUID();
      await send(socket, {
        payload: [{ type: 'RetrieveSportsbookPage', name: 'RetrieveSportsbookPage/RetrieveSportsbookPage',
          body: { urlPart: path, pageScope: 1 }, requestId }],
        properties: { type: 'binary', service: 'sportsbook' },
      });
      const started = Date.now();
      while (Date.now() - started < PAGE_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (answers.has(requestId) && Date.now() - lastMessage > QUIET_MS) break;
      }
      result[path] = answers.has(requestId)
        ? { found: true, fetched: new Date().toISOString(), events: buildEvents(eventUrns(answers.get(requestId)), entities) }
        : { found: false, events: [] };
    }
  } finally {
    socket.close(1000, 'fertig');
  }
  return result;
}

const send = async (socket, message) => socket.send(await encodeFrame(message));

// --- Komprimieren und Entpacken -----------------------------------------------------------

async function pipe(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function encodeFrame(message) {
  return (await pipe(new TextEncoder().encode(JSON.stringify(message)), new CompressionStream('deflate-raw'))).buffer;
}

// Eine Nachricht -> Liste von Einträgen. "payload" ist mal eine Liste, mal ein JSON-Text mit einer Liste.
export async function decodeFrame(data) {
  let text;
  if (typeof data === 'string') {
    text = data.trim().startsWith('{') ? data
      : new TextDecoder().decode(await pipe(Uint8Array.from(atob(data), c => c.charCodeAt(0)), new DecompressionStream('deflate-raw')));
  } else {
    text = new TextDecoder().decode(await pipe(data, new DecompressionStream('deflate-raw')));
  }
  const message = JSON.parse(text);
  const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
  return Array.isArray(payload) ? payload : [];
}

// --- Bausteine zusammensetzen ---------------------------------------------------------------

// Alle Spiele, die auf der Seite stehen (sie stecken irgendwo im verschachtelten "viewNode")
export function eventUrns(page) {
  const found = new Set();
  const walk = node => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.eventUrn === 'string') found.add(node.eventUrn);
      Object.values(node).forEach(walk);
    }
  };
  walk(page?.viewNode);
  return [...found];
}

// "asw:markettype:18" -> 18
const typeNumber = urn => Number(String(urn).split(':').pop());

export function buildEvents(urns, entities) {
  const events = [];
  for (const urn of urns) {
    const event = entities.get(urn);
    if (!event || !event.name) continue;
    const [home, away] = event.name.split(' : ');
    const markets = [];
    for (const marketUrn of event.markets || []) {
      const market = entities.get(marketUrn);
      if (!market || market.state !== 1) continue;           // 1 = offen
      const odds = {};
      for (const selectionUrn of market.selections || []) {
        const selection = entities.get(selectionUrn);
        if (selection && selection.state === 1 && selection.odds > 1) odds[typeNumber(selection.type)] = selection.odds;
      }
      if (Object.keys(odds).length >= 2) {
        markets.push({ type: typeNumber(market.type), line: market.properties?.total ?? null, odds });
      }
    }
    if (markets.length) {
      events.push({ name: event.name, home, away: away ?? '', kickoff: event.startTime, sport: event.sport, markets });
    }
  }
  return events;
}
