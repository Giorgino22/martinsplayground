// Sporttip-Quoten holen (mit Erlaubnis von Swisslos, nur für den privaten Gebrauch).
//
//   GET /api/sporttip?paths=/fussball/deutschland/bundesliga,/tennis
//        &all=1    zusätzlich alle Wettarten laden (Doppelte Chance, Beide treffen, …)
//        &tree=1   zusätzlich die Unterkategorien abfragen (für "Pfad testen")
//
// So macht es auch die Swisslos-Seite: Sie öffnet eine WebSocket-Verbindung zu Admiral
// (der Firma hinter Sporttip) und fragt dort nach einer Seite, z.B. "/tennis".
// Jede Nachricht ist JSON, mit "deflate-raw" komprimiert (wie eine ZIP-Datei ohne Kopf).
//
// Diese Function ist nur der Briefträger: Sie stellt dieselben Fragen wie die Swisslos-Seite,
// entpackt die Antworten und gibt sie unverändert weiter. Das Zusammensetzen der Spiele macht
// der Browser (site/js/feed.js). Darum braucht die Function kaum Rechenzeit: Cloudflare erlaubt
// gratis nur 10 ms pro Aufruf, das Warten auf Antworten zählt dabei nicht.
//
// Antwort: Text mit einer JSON-Zeile pro Nachricht.
//   {"path":"/tennis","found":true,"fetched":"2026-10-11T16:00:00Z"}   <- hier beginnt eine Seite
//   {"payload":"[…]","properties":{…}}                                  <- Nachrichten von Sporttip
//
// Rücksichtsvoll: eine Verbindung pro Aufruf, Seiten nacheinander, 5 Minuten zwischengespeichert.
// Nichts wird dauerhaft gespeichert.

const SOCKET = 'https://ws.ch.admiral.at/';       // wss:// – Cloudflare will hier https:// sehen
const ORIGIN = 'https://www.swisslos.ch';
const SERVICE = { type: 'binary', service: 'sportsbook' };
const PAGE = 'RetrieveSportsbookPage/RetrieveSportsbookPage';
const CACHE_SECONDS = 300;
const MAX_PATHS = 4;
const ANSWER_MS = 6000;     // so lange höchstens auf die Antwort warten
const QUIET_MS = 400;       // so lange keine neue Nachricht = alles angekommen
const SETTLE_MS = 3000;     // nie länger warten (Live-Spiele schicken laufend neue Quoten)

const isPath = path => /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(path);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const text = body => new Response(body, {
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequestGet({ request, waitUntil }) {
  const params = new URL(request.url).searchParams;
  const paths = (params.get('paths') || '').split(',').filter(Boolean);
  const options = { all: params.get('all') === '1', tree: params.get('tree') === '1' };
  if (!paths.length || paths.length > MAX_PATHS || !paths.every(isPath)) return json({ error: 'Ungültige Pfade' }, 400);

  // Gleiche Frage innert 5 Minuten -> Antwort aus dem Zwischenspeicher
  const query = new URLSearchParams({ paths: paths.join(','), all: Number(options.all), tree: Number(options.tree) });
  const cacheKey = new Request(new URL(`/__cache/sporttip?${query}`, request.url));
  const cached = await caches.default.match(cacheKey);
  if (cached) return text(await cached.text());

  let body;
  try {
    body = await relay(paths, options);
  } catch (error) {
    return json({ error: `Sporttip nicht erreichbar: ${error.message}` }, 502);
  }
  waitUntil(caches.default.put(cacheKey, new Response(body, {
    headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` },
  })));
  return text(body);
}

// --- Verbindung ---------------------------------------------------------------------------

async function relay(paths, options) {
  const response = await fetch(SOCKET, { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`keine WebSocket-Verbindung (${response.status})`);
  socket.accept();

  // Jede Nachricht wird entpackt und in den Briefkasten gelegt. "chain" sorgt dafür, dass
  // die Reihenfolge stimmt, auch wenn das Entpacken unterschiedlich lange dauert.
  let inbox = [];
  let lastMessage = 0;
  let closed = false;
  let chain = Promise.resolve();
  socket.addEventListener('message', event => {
    lastMessage = Date.now();
    chain = chain.then(async () => { inbox.push(await decodeFrame(event.data)); }).catch(() => {});
  });
  socket.addEventListener('close', () => { closed = true; });

  // Warten, bis nach "since" eine Antwort kam und danach Ruhe ist
  const settle = async since => {
    const start = Date.now();
    while (!closed && lastMessage <= since && Date.now() - start < ANSWER_MS) await sleep(50);
    while (!closed && Date.now() - lastMessage < QUIET_MS && Date.now() - start < SETTLE_MS) await sleep(50);
    await chain;
  };
  const send = async message => {
    socket.send(await encodeFrame(message));
    return Date.now();
  };

  const lines = [];
  try {
    await send({ connect: { headers: {} }, properties: SERVICE });
    for (const path of paths) {
      if (closed) break;                       // die schon geholten Seiten behalten
      inbox = [];
      const requestId = randomId();
      await send(command('RetrieveSportsbookPage', PAGE, { urlPart: path, pageScope: 1 }, requestId));

      // Auf die Antwort zu genau dieser Anfrage warten. Ein Textvergleich reicht und spart Rechenzeit;
      // "checked" merkt sich, welche Nachrichten schon angeschaut wurden.
      let answer = null;
      let checked = 0;
      const asked = Date.now();
      while (!answer && !closed && Date.now() - asked < ANSWER_MS) {
        await sleep(50);
        await chain;
        for (; checked < inbox.length && !answer; checked++) {
          const t = inbox[checked];
          if (t.includes('SportsbookPageRetrieved') && t.includes(requestId)) answer = pageOf(t, requestId);
        }
      }
      if (closed && !lines.length && !answer) throw new Error('Sporttip hat die Verbindung geschlossen');
      if (answer) {
        await settle(0);
        if (options.all) await loadAllMarkets(answer, send, settle);
        if (options.tree) await loadCategories(answer, send, settle);
      }
      lines.push(JSON.stringify({ path, found: Boolean(answer), fetched: new Date().toISOString() }),
        ...inbox.map(t => t.replace(/[\r\n]+/g, ' ')));
    }
  } finally {
    try { socket.close(1000, 'fertig'); } catch { /* war schon zu */ }
  }
  return lines.join('\n');
}

// Wie der Markt-Umschalter auf swisslos.ch: Das Raster zeigt immer zwei Wettarten pro Spiel
// (z.B. Sieger und Tore). Wir schalten der Reihe nach alle anderen Paare ein.
async function loadAllMarkets(page, send, settle) {
  let lastSent = 0;
  for (const grid of nodesOfType(page.viewNode, 'SportsGridViewNode')) {
    const shown = new Set((grid.selectedMarketSwitcher || []).map(s => s.marketConfigUrn));
    const rest = (grid.availableMarketSwitcher || []).filter(config => !shown.has(config));
    for (let i = 0; i < rest.length; i += 2) {
      lastSent = await send(command('UpdateSportsbookPage', `${randomId()}/UpdateSportsbookPage`, {
        sportsGridViewNodeId: grid.id,
        pageSubscriptionName: PAGE,
        commandProperties: [{ type: 0 }, { type: 1, value: JSON.stringify(rest.slice(i, i + 2)) }],
      }, randomId()));
      await sleep(150);
    }
  }
  if (lastSent) await settle(lastSent);
}

// Unterkategorien (z.B. Länder und Ligen einer Sportart), so wie das Menü auf swisslos.ch
async function loadCategories(page, send, settle) {
  for (const category of page.categoryPath?.categories || []) {
    const sent = await send(command('RetrieveCategoryChildren', 'RetrieveCategoryChildrenSubscription', { category, name: 'L1' }));
    await settle(sent);
  }
}

// --- Bausteine ---------------------------------------------------------------------------------

const command = (type, name, body, requestId) => ({ payload: [{ type, name, body, requestId }], properties: SERVICE });

// Zufällige ID im selben Stil wie die Swisslos-Seite (21 Zeichen)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(21)), b => ALPHABET[b & 63]).join('');

// "payload" ist mal eine Liste, mal ein JSON-Text mit einer Liste
export function itemsOf(message) {
  const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
  return Array.isArray(payload) ? payload : [];
}

// Die Antwort auf unsere Seiten-Anfrage (nur diese eine, kleine Nachricht wird ganz gelesen)
function pageOf(messageText, requestId) {
  try {
    const item = itemsOf(JSON.parse(messageText))
      .find(i => i.type === 'SportsbookPageRetrieved' && i.requestId === requestId);
    return item ? item.body || {} : null;
  } catch {
    return null;
  }
}

// Alle Knoten eines Typs im verschachtelten Seitenaufbau
function nodesOfType(node, type, found = []) {
  if (Array.isArray(node)) node.forEach(n => nodesOfType(n, type, found));
  else if (node && typeof node === 'object') {
    if (node.type === type) found.push(node);
    Object.values(node).forEach(n => nodesOfType(n, type, found));
  }
  return found;
}

// --- Komprimieren und Entpacken -------------------------------------------------------------------

async function pipe(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function encodeFrame(message) {
  return (await pipe(new TextEncoder().encode(JSON.stringify(message)), new CompressionStream('deflate-raw'))).buffer;
}

// Eine Nachricht von Sporttip -> JSON-Text
export async function decodeFrame(data) {
  if (typeof data === 'string') {
    if (data.trim().startsWith('{')) return data;
    data = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  }
  return new TextDecoder().decode(await pipe(data, new DecompressionStream('deflate-raw')));
}
