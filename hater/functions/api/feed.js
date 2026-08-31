/**
 * GET /api/feed?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Holt die iCal-Feeds der Familie serverseitig (der Browser darf das wegen CORS
 * nicht), rechnet Serientermine aus und gibt fertige Anzeigewerte als JSON zurück.
 * Niemand muss sich anmelden — die Feeds sind öffentliche .ics-Adressen.
 */

const TZ = 'Europe/Zurich';
const MAX_EVENTS = 6000;

/** Öffentliche .ics-Adresse eines freigegebenen Google-Kalenders. */
function gcal(id) {
  return 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(id) + '/public/basic.ics';
}

/* ------------------------------------------------------------------
   Familie. Eine Person = eine Kategorie, alle ihre Kalender in `feeds`.

   Google: Kalender öffentlich schalten (Einstellungen → Kalender →
   «Zugriffsberechtigungen» → «Für die Öffentlichkeit freigeben»), dann
   gcal('<kalender-id>') eintragen.

   Apple/iCloud: iCloud.com → Kalender → Freigabe-Symbol neben dem Kalender →
   «Öffentlicher Kalender» → Link kopieren, webcal:// durch https:// ersetzen.

   Nicht öffentlich? Google bietet unter «Kalender integrieren» auch eine
   «Private Adresse im iCal-Format» (endet auf /private-xxxxx/basic.ics). Die
   funktioniert ohne Anmeldung und ohne den Kalender öffentlich zu machen —
   aber sie ist ein Passwort. Solche Adressen gehören NICHT in dieses Repo
   (es ist öffentlich), sondern in eine Umgebungsvariable in Cloudflare:

     FEEDS_MARTIN, FEEDS_PATRICK, FEEDS_MAMA, FEEDS_PAPA

   Mehrere Adressen mit Komma oder Zeilenumbruch trennen. Ist die Variable
   gesetzt, ersetzt sie die `feeds`-Liste dieser Person hier im Code.

   Achtung: «Kalender teilen»-Links (calendar.google.com/calendar/u/0?cid=…)
   sind KEINE Feeds. Das sind Seiten zum Abonnieren, die eine Anmeldung
   verlangen — sie lassen sich hier nicht verwenden.
------------------------------------------------------------------- */
export const PEOPLE = [
  {
    name: 'Martin',
    color: '#ff9500',
    feeds: [
      // Öffentlicher iCloud-Kalender (webcal:// → https://). Kein Umweg über Google,
      // darum sofort aktuell und ohne Anmeldung sichtbar.
      'https://p175-caldav.icloud.com/published/2/MTc2NDExNzgzMTkxNzY0Mbv5FaYbFKuosjLF8zsfAA_72g-71uZh3SGUszE8_98DPR0WqQu2pAA7UQugs9z4P2OHbUwCbyuoJNHW0D2dVyA'
    ]
  },
  {
    name: 'Patrick',
    color: '#0088ff',
    feeds: [
      gcal('poyllix4@gmail.com'),
      gcal('54ba6b142b1cf12a964fa3676e197d212e6ebb730e642ff059a7444f63568237@group.calendar.google.com'),
      gcal('2307244d188dbd1d1081be45fba30d8c9fe6502bab61bd728b62b75d24c98a47@group.calendar.google.com'),
      gcal('842616bdeef3886686973a194d72fb3aeae4b7625ecbc00750fd24a6e033da6b@group.calendar.google.com'),
      gcal('a09b3a710534fc603645f32c44e54aba5c866aa4b45508d4cfc28b38250058cc@group.calendar.google.com')
    ]
  },

  // Mama und Papa: erscheinen automatisch, sobald FEEDS_MAMA bzw. FEEDS_PAPA in
  // Cloudflare gesetzt ist. Solange leer, tauchen sie gar nicht erst auf.
  { name: 'Mama', color: '#cb30e0', feeds: [] },
  { name: 'Papa', color: '#2ea043', feeds: [] },

  {
    name: 'Schöni',
    color: '#00897b',
    feeds: [
      // ClubDesk-Feed des Vereins. webcal:// wird beim Holen zu https://.
      'webcal://calendar.clubdesk.com/clubdesk/ical/47195/1000665/djEtrDz5oMGoLS_mavMxV98QWeTYTqUZbfGkFEwdOip7gVA=/basic.ics'
    ]
  }
];

/* ------------------------------------------------------------------
   Zeitzonen
------------------------------------------------------------------- */

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (e) {
      f = dtf(TZ);           // unbekannte TZID (z.B. Outlook-Namen) → Ortszeit
    }
    dtfCache.set(tz, f);
  }
  return f;
}

function partsIn(ms, tz) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** Verschiebung der Zone gegenüber UTC zum Zeitpunkt ms. */
function offsetMs(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

/** Wanduhrzeit in einer Zone → UTC-Millisekunden. */
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = wall - offsetMs(wall, tz);
  ms = wall - offsetMs(ms, tz);          // zweiter Durchgang fängt Zeitumstellungen ab
  return ms;
}

function fmtDate(ms) {
  const p = partsIn(ms, TZ);
  return p.year + '-' + p.month + '-' + p.day;
}
function fmtTime(ms) {
  const p = partsIn(ms, TZ);
  return p.hour + ':' + p.minute;
}

/* ------------------------------------------------------------------
   iCalendar lesen
------------------------------------------------------------------- */

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i).split(';');
  const params = {};
  for (let k = 1; k < left.length; k++) {
    const eq = left[k].indexOf('=');
    if (eq > 0) params[left[k].slice(0, eq).toUpperCase()] = left[k].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: left[0].toUpperCase(), params, value: line.slice(i + 1) };
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\').trim();
}

/** DTSTART/DTEND/EXDATE-Wert → Wanduhr-Objekt. */
function parseWall(value, params) {
  if (/^\d{8}$/.test(value) || params.VALUE === 'DATE') {
    return { allDay: true, y: +value.slice(0, 4), mo: +value.slice(4, 6), d: +value.slice(6, 8), h: 0, mi: 0, s: 0, tz: TZ };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return null;
  return {
    allDay: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
    tz: m[7] ? 'UTC' : (params.TZID || TZ)      // ohne TZID: schwebende Zeit = Ortszeit
  };
}

function wallToMs(w) {
  if (w.tz === 'UTC') return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz);
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 604800 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRRule(v) {
  const o = {};
  v.split(';').forEach(function (kv) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1).toUpperCase();
  });
  if (!o.FREQ) return null;
  return {
    freq: o.FREQ,
    interval: Math.max(1, parseInt(o.INTERVAL || '1', 10) || 1),
    count: o.COUNT ? parseInt(o.COUNT, 10) : null,
    until: o.UNTIL ? wallToMs(parseWall(o.UNTIL, {})) : null,
    byday: o.BYDAY ? o.BYDAY.split(',') : null,
    bymonthday: o.BYMONTHDAY ? o.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: o.BYMONTH ? o.BYMONTH.split(',').map(Number) : null
  };
}

export function parseICS(text) {
  const out = [];
  let cur = null;
  for (const raw of unfold(text).split('\n')) {
    if (!raw) continue;
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (cur && cur.start) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = parseLine(raw);
    if (!l) continue;
    switch (l.name) {
      case 'DTSTART': cur.start = parseWall(l.value, l.params); break;
      case 'DTEND': cur.end = parseWall(l.value, l.params); break;
      case 'DURATION': cur.duration = parseDuration(l.value); break;
      case 'SUMMARY': cur.title = unescapeText(l.value); break;
      case 'LOCATION': cur.loc = unescapeText(l.value); break;
      case 'UID': cur.uid = l.value; break;
      case 'RRULE': cur.rrule = parseRRule(l.value); break;
      case 'STATUS': if (l.value.toUpperCase() === 'CANCELLED') cur.cancelled = true; break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseWall(l.value, l.params); break;
      case 'EXDATE':
        l.value.split(',').forEach(function (v) {
          const w = parseWall(v, l.params);
          if (w) cur.exdates.push(wallToMs(w));
        });
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   Serientermine ausrechnen
------------------------------------------------------------------- */

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function addDays(p, n) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function weekday(p) {
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}
function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** n-ter Wochentag im Monat, n negativ = vom Monatsende her. */
function nthWeekdayOfMonth(y, mo, dw, n) {
  const len = daysInMonth(y, mo);
  const hits = [];
  for (let d = 1; d <= len; d++) if (weekday({ y, mo, d }) === dw) hits.push(d);
  const d = n > 0 ? hits[n - 1] : hits[hits.length + n];
  return d ? { y, mo, d } : null;
}

/** Wanduhr-Startdaten einer Serie, begrenzt auf das Fenster. */
function expandRule(w0, rule, windowEndMs) {
  const res = [];
  const dtstartMs = wallToMs(w0);
  let emitted = 0;
  let done = false;

  function msOf(p) { return wallToMs({ ...w0, y: p.y, mo: p.mo, d: p.d }); }

  function take(p) {
    if (done) return;
    const ms = msOf(p);
    if (ms < dtstartMs) return;                                 // vor DTSTART
    if (rule.until !== null && ms > rule.until) { done = true; return; }
    if (rule.count !== null && emitted >= rule.count) { done = true; return; }
    emitted++;
    if (ms <= windowEndMs) res.push(p);
    if (res.length >= 2000) done = true;
  }

  const step = rule.interval;
  let guard = 0;

  if (rule.freq === 'DAILY') {
    let p = { y: w0.y, mo: w0.mo, d: w0.d };
    while (!done && guard++ < 4000 && msOf(p) <= windowEndMs) { take(p); p = addDays(p, step); }

  } else if (rule.freq === 'WEEKLY') {
    const wanted = (rule.byday || [DAYS[weekday(w0)]])
      .map(function (x) { return DAYS.indexOf(x.slice(-2)); })
      .filter(function (i) { return i >= 0; })
      .sort(function (a, b) { return ((a + 6) % 7) - ((b + 6) % 7); });   // Woche ab Montag
    let weekStart = addDays(w0, -((weekday(w0) + 6) % 7));
    while (!done && guard++ < 1000) {
      let any = false;
      for (const dw of wanted) {
        const p = addDays(weekStart, (dw + 6) % 7);
        if (msOf(p) <= windowEndMs) { any = true; take(p); }
      }
      if (!any && msOf(weekStart) > windowEndMs) break;
      weekStart = addDays(weekStart, 7 * step);
    }

  } else if (rule.freq === 'MONTHLY') {
    let y = w0.y, mo = w0.mo;
    while (!done && guard++ < 1200) {
      let cands = [];
      if (rule.bymonthday) {
        cands = rule.bymonthday
          .map(function (n) { return n > 0 ? n : daysInMonth(y, mo) + 1 + n; })
          .filter(function (d) { return d >= 1 && d <= daysInMonth(y, mo); })
          .map(function (d) { return { y, mo, d }; });
      } else if (rule.byday) {
        cands = rule.byday.map(function (x) {
          const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x);
          if (!m) return null;
          const dw = DAYS.indexOf(m[2]);
          return m[1] ? nthWeekdayOfMonth(y, mo, dw, +m[1]) : null;
        }).filter(Boolean);
      } else if (w0.d <= daysInMonth(y, mo)) {
        cands = [{ y, mo, d: w0.d }];
      }
      cands.sort(function (a, b) { return a.d - b.d; });
      cands.forEach(take);
      if (Date.UTC(y, mo - 1, 1) > windowEndMs) break;
      mo += step;
      while (mo > 12) { mo -= 12; y++; }
    }

  } else if (rule.freq === 'YEARLY') {
    let y = w0.y;
    while (!done && guard++ < 200) {
      for (const mo of (rule.bymonth || [w0.mo])) {
        let cands;
        if (rule.byday) {
          cands = rule.byday.map(function (x) {
            const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x);
            return m && m[1] ? nthWeekdayOfMonth(y, mo, DAYS.indexOf(m[2]), +m[1]) : null;
          }).filter(Boolean);
        } else {
          cands = w0.d <= daysInMonth(y, mo) ? [{ y, mo, d: w0.d }] : [];
        }
        cands.forEach(take);
      }
      if (Date.UTC(y, 0, 1) > windowEndMs) break;
      y += step;
    }

  } else {
    take({ y: w0.y, mo: w0.mo, d: w0.d });          // unbekannte FREQ → nur der Ersttermin
  }

  return res;
}

/** Rohe VEVENTs → konkrete Termine im Fenster. */
export function expandAll(raws, fromMs, toMs) {
  const overrides = new Map();
  raws.forEach(function (e) {
    if (e.recurrenceId && e.uid) overrides.set(e.uid + '|' + wallToMs(e.recurrenceId), e);
  });

  const out = [];

  function emit(e, startMs) {
    if (e.cancelled) return;
    let dur;
    if (e.end) dur = wallToMs(e.end) - wallToMs(e.start);
    else if (e.duration != null) dur = e.duration;
    else dur = e.start.allDay ? 86400000 : 0;
    if (dur < 0) dur = 0;
    const endMs = startMs + dur;
    if (endMs < fromMs || startMs > toMs) return;
    out.push({ e, startMs, endMs });
  }

  raws.forEach(function (e) {
    if (e.recurrenceId) return;                    // Ausnahmen kommen über die Serie
    if (!e.rrule) { emit(e, wallToMs(e.start)); return; }

    const ex = new Set(e.exdates);
    for (const p of expandRule(e.start, e.rrule, toMs)) {
      const ms = wallToMs({ ...e.start, y: p.y, mo: p.mo, d: p.d });
      if (ex.has(ms)) continue;
      const ov = e.uid ? overrides.get(e.uid + '|' + ms) : null;
      if (ov) emit(ov, wallToMs(ov.start));
      else emit(e, ms);
    }
  });

  return out;
}

/** Konkreter Termin → fertige Anzeigewerte. */
export function toDisplay(occ, personIndex) {
  const e = occ.e;
  const allDay = !!e.start.allDay;
  const lastMs = occ.endMs > occ.startMs ? occ.endMs - 1 : occ.startMs;   // DTEND ist exklusiv
  const d = {
    p: personIndex,
    t: e.title || '(ohne Titel)',
    allDay: allDay,
    s: fmtDate(occ.startMs),
    e: fmtDate(lastMs),
    sort: occ.startMs
  };
  if (e.loc) d.loc = e.loc;
  if (!allDay) { d.st = fmtTime(occ.startMs); d.et = fmtTime(occ.endMs); }
  return d;
}

/* ------------------------------------------------------------------
   Endpunkt
------------------------------------------------------------------- */

/** Feeds einer Person: FEEDS_<NAME> aus Cloudflare schlägt die Liste im Code. */
/** «Schöni» -> FEEDS_SCHOENI (nicht FEEDS_SCHNI). */
export function envKeyFor(name) {
  return 'FEEDS_' + String(name).toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE')
    .replace(/[^A-Z0-9]/g, '');
}

export function feedsFor(person, env) {
  const key = envKeyFor(person.name);
  const raw = env && env[key];
  if (raw && String(raw).trim()) {
    return String(raw).split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return person.feeds;
}

function dayMs(iso, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  return zonedToUtc(+m[1], +m[2], +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, TZ);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const now = Date.now();
  const fromMs = dayMs(url.searchParams.get('from'), false) || now - 60 * 86400000;
  const toMs = dayMs(url.searchParams.get('to'), true) || now + 400 * 86400000;
  const fresh = url.searchParams.has('fresh');      // ↻ umgeht jeden Zwischenspeicher

  const people = [];
  const events = [];

  await Promise.all(PEOPLE.map(async function (person, i) {
    const info = { name: person.name, color: person.color, ok: true };
    people[i] = info;

    const entries = feedsFor(person, context.env);
    if (!entries.length) {
      info.hidden = true;              // noch kein Kalender -> gar nicht anzeigen
      return;
    }

    // Offensichtlich falsche Eintraege gar nicht erst holen, sondern benennen.
    const feeds = [];
    const wrong = [];
    entries.forEach(function (entry) {
      const href = entry.replace(/^webcal:\/\//i, 'https://');
      if (/calendar\.google\.com/.test(href) && /[?&]cid=/.test(href)) {
        wrong.push('ein «?cid=»-Link ist eine Abo-Seite, kein Kalender-Feed');
      } else if (!/^https?:\/\//i.test(href)) {
        wrong.push('«' + entry.slice(0, 30) + '…» ist keine Adresse');
      } else {
        feeds.push(href);
      }
    });

    if (!feeds.length) {
      info.ok = false;
      info.note = wrong.join(' · ');
      return;
    }

    const results = await Promise.all(feeds.map(async function (href) {
      try {
        const res = await fetch(href, {
          cf: fresh ? { cacheTtl: 0 } : { cacheTtl: 300, cacheEverything: true },
          headers: { 'user-agent': 'familienkalender/1.0' }
        });
        if (!res.ok) return { error: 'HTTP ' + res.status };
        return { text: await res.text() };
      } catch (err) {
        return { error: 'nicht erreichbar' };
      }
    }));

    const failed = results.filter(function (r) { return r.error; });
    const notes = wrong.slice();
    if (failed.length === results.length) {
      info.ok = false;
      notes.push(failed[0].error === 'HTTP 404'
        ? 'Kalender ist weder öffentlich noch als private iCal-Adresse hinterlegt'
        : 'Kalender nicht erreichbar (' + failed[0].error + ')');
      info.note = notes.join(' · ');
      return;
    }
    if (failed.length) notes.push(failed.length + ' von ' + results.length + ' Kalendern nicht erreichbar');
    if (notes.length) info.note = notes.join(' · ');

    results.forEach(function (r) {
      if (!r.text) return;
      try {
        expandAll(parseICS(r.text), fromMs, toMs).forEach(function (occ) {
          events.push(toDisplay(occ, i));
        });
      } catch (err) {
        info.note = 'Kalender konnte nicht gelesen werden';
      }
    });
  }));

  events.sort(function (a, b) { return a.sort - b.sort || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1); });

  // Personen ohne hinterlegten Kalender herausnehmen und die Indizes der
  // Termine entsprechend nachziehen.
  const shown = [];
  const remap = [];
  people.forEach(function (info, i) {
    if (info.hidden) { remap[i] = -1; return; }
    remap[i] = shown.length;
    shown.push(info);
  });
  const visible = events.filter(function (e) { return remap[e.p] >= 0; });
  visible.forEach(function (e) { e.p = remap[e.p]; });

  return new Response(JSON.stringify({
    tz: TZ,
    from: fmtDate(fromMs),
    to: fmtDate(toMs),
    people: shown,
    events: visible.slice(0, MAX_EVENTS),
    truncated: visible.length > MAX_EVENTS
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Der Rand von Cloudflare darf 5 Minuten zwischenspeichern, der Browser nicht —
      // sonst zeigt ein Neuladen der Seite minutenlang alte Termine.
      'cache-control': fresh
        ? 'no-store'
        : 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'
    }
  });
}
