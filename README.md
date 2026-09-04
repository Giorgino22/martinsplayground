# martinsplayground

A monorepo of little websites, one folder per subdomain of `odermatts.ch`.
Each folder is deployed as its own Cloudflare Pages project; pushing to
`master` updates the live sites automatically.

## Sites

| Folder        | URL                          | What it does                              |
|---------------|------------------------------|-------------------------------------------|
| `askMartin/`  | `askmartin.odermatts.ch`     | A big "Ja" in the middle of the page. `/second/` loads `second.asknils.ch`, then a shark swims in and swallows his whole site ("Nei" and all), leaving a big "Ja". |
| `askSchoggi/` | `askschoggi.odermatts.ch`    | Waits 2–3s, then screams a massive "NEI". |
| `fottis/`     | `fottis.odermatts.ch`        | (Parked) Shared photo/video drop. Needs Cloudflare R2 (binding `BUCKET`) + Pages Functions. |
| `hater/`      | `oderkalender.odermatts.ch`  | Familienkalender. Read-only view of the family's public `.ics` feeds. Needs Pages Functions (Root directory `hater`), no bindings. Folder name is historical — it reuses the old `hater` Pages project. |
| `nizza/`      | `nizza.odermatts.ch`         | **The app.** Installable PWA hub: home launcher + `/aura/`, `/chooser/`, `/hater/`. Needs D1 (`DB`), Workers AI (`AI`), R2 (`BUCKET`). |

### nizza app (everything in one PWA)

`nizza/` is one Cloudflare Pages project (build output dir `nizza`) serving the whole app:

- `/` — home launcher.
- `/aura/` — global hero aura battle (D1). Start 67, custom ±amounts, per-hero video upload
  (R2) that grants +10% on positive gains, highest on top, live via polling.
- `/chooser/` — name wheel + rigged finger picker.
- `/hater/` — AI photo roast (Workers AI).
- `functions/api/` — `aura.js`, `roast.js`, `video/{create,part,complete,get}.js`.
- PWA: `manifest.json` + `icon-180/512.png` + apple-touch meta; add to home screen for an
  app-like, full-screen experience (stays in-app because it's all one origin).

Bindings on the nizza project: **`DB`** (D1), **`AI`** (Workers AI), **`BUCKET`** (R2).
The old standalone `chooser.odermatts.ch` project can be deleted; the old `hater` project has been
repurposed as the family calendar and now serves `oderkalender.odermatts.ch` (see below).

**Cloudflare config (important):** because this project uses Pages Functions in
`nizza/functions/`, the project's **Root directory** must be set to `nizza` (Functions are
detected relative to the Root directory). With Root directory = `nizza`, the **Build output
directory** is `/` (assets sit at the root of `nizza`). If Root directory is left at the repo
root, Functions are not deployed and `/api/*` returns 405.

### hater (Familienkalender)

A read-only view of the whole family's calendars, served at `oderkalender.odermatts.ch`. The
folder is still called `hater/` because it reuses that old Pages project; nothing in the code
refers to a hostname, so the custom domain can be changed freely. Two things do reset on a domain
change: the access cookie (everyone enters the code once more) and the remembered view, since
browsers scope both per domain. **Nobody logs in to look at it** — the page reads public `.ics` feeds server-side and
draws the calendar itself, so there is no Google embed, no sign-in and no Google account involved
for viewers.

- `hater/functions/api/feed.js` — fetches every feed (the browser can't, CORS), parses iCalendar,
  expands recurring events, converts to `Europe/Zurich`, returns ready-to-draw JSON. Cached 5 min.
- `hater/index.html` — four views, person tabs, ‹ › + Heute, tap a day for its details.
  Phones open in Agenda; the month grid collapses to coloured dots there.

Views: **Monat** (grid), **Woche** (time grid like a normal calendar), **Liste** (the seven days
as cards), **Agenda** (flowing list). The week time grid only draws the hours that actually
contain events, padded to the hour, so a whole week always fits the window without scrolling —
even on a short screen. Overlapping events sit side by side, all-day events get their own row
above the grid, and a red line marks the current time. On phones the columns stay but the blocks
lose their text; tapping one opens that day.

**Planen** looks for slots where everyone is free. Pick a duration (or *ganztägig*), a date range,
a daily time window, and who has to be free; it returns up to 10 suggestions, one per day, each
with a preview showing that day's events with the proposed slot in its place. It only suggests —
nothing is ever written to anyone's calendar. Optionally all-day events can be treated as
not-busy, for calendars where a birthday or a marker would otherwise block the whole day.

**One person = one category.** All of a person's calendars (private, work, sport, …) sit in their
`feeds` array and appear together under their name. Individual calendar names are never shown; in
the *Alle* view each person gets one colour.

**Cloudflare (important):** because this uses Pages Functions, the project's **Root directory**
must be set to `hater` — Functions are detected relative to it. The **Build output directory** is
then `/`, *not* `hater`: it is resolved relative to the root directory, so `hater` there makes the
build fail with `Output directory "hater/hater" not found`. If Root directory is left at the repo
root instead, `/api/feed` returns 405 and the page stays empty. Same trap as nizza.

**Adding a person / a calendar:** edit `PEOPLE` at the top of `functions/api/feed.js`.

- *Google:* make the calendar public first (*Settings → the calendar → Access permissions for
  events → Make available to public → See all event details*), then add `gcal('<calendar-id>')`.
  Every calendar has to be set individually — it is not inherited from the primary calendar.
- *A shared iCloud family calendar* is **not** readable from here as-is: private sharing is
  authenticated CalDAV, with no URL a server can fetch. Its **owner** has to publish it as well
  (share icon → *Public Calendar*) and hand over that link, which then goes in `FEEDS_FAMILIE`.
  Note the iCloud sharing pane presents *Private* and *Public* as alternatives, so check that the
  family keeps its write access after publishing — if it does not, the calendar cannot be shown
  here without reading iCloud over authenticated CalDAV, which would mean putting an Apple
  app-specific password in Cloudflare.
- *Apple/iCloud:* iCloud.com → Calendar → the share icon next to the calendar → *Public Calendar*
  → copy link, replace `webcal://` with `https://`, paste it in. No Google detour, so it is live
  rather than delayed.

**Don't want a calendar public?** Google also offers a *Secret address in iCal format* under
*Integrate calendar* (ends in `/private-xxxxx/basic.ics`). It works without sign-in and without
making the calendar public — but it is effectively a password, so it must **not** be committed to
this repo, which is public. Put those in Cloudflare environment variables instead:
`FEEDS_MARTIN`, `FEEDS_PATRICK`, `FEEDS_MAMA`, `FEEDS_FAMILIE`, `FEEDS_PAPA`, `FEEDS_SCHOENI` — several addresses separated by
commas, semicolons or newlines (any mix; trailing separators and blank lines are fine). When set,
the variable replaces that person's `feeds` list in the code. An entry that obviously isn't a feed
— a `?cid=` subscribe link, or anything without `http(s)://` — is skipped and named in that
person's note rather than silently failing.

All six entries exist as slots in `PEOPLE` (Martin, Patrick, Mamma, Familie, Geissepapi, Schöni).
A person with no feeds at all (in code or env) is left out of the response entirely, so an unset
one shows no tab — set their variable and they appear on their own, no code change needed. Secrets are per **calendar**,
not per account: someone with five calendars contributes five addresses to their variable.
Umlauts in a name become their two-letter form in the variable, so *Schöni* is `FEEDS_SCHOENI`.
A person may also pin their variable name with an `env` field, so renaming the displayed name does
not orphan a variable already set in Cloudflare — *Mamma* reads `FEEDS_MAMA` or `FEEDS_MAMMA`,
*Geissepapi* reads `FEEDS_PAPA` or `FEEDS_GEISSEPAPI`.

**Environment variables only take effect on a new deployment.** Cloudflare Pages binds them when a
deployment is created, so adding or changing one in the dashboard does nothing until you redeploy
(*Deployments → Retry deployment*, or push a commit). This is the usual reason a freshly added
calendar does not appear.

**Access gate.** The site is behind a numeric code on an iPhone-style keypad: three columns of
round keys, 1–9 with their letters, then a gap, 0 and a delete key, with a row of dots above. Keys
register on `pointerdown` rather than `click`, so rapid entry never drops a digit, and
`touch-action: manipulation` stops a double tap from zooming the page (pinch zoom still works). On
a computer the code can simply be typed — digits, Backspace to delete, Escape to clear.

The check is **server-side** in `functions/api/login.js`; a correct code returns an HMAC-signed,
`HttpOnly` `Secure` `SameSite=Lax` cookie valid for 180 days, and `/api/feed` returns `401` without
it. That ordering matters: the page holds no calendar data of its own, so gating the API is what
actually protects anything — a browser-only check would be bypassed by calling `/api/feed`
directly. `?debug=1` is gated too. A wrong code costs a ~900 ms delay to slow scripted guessing.

Because the response now depends on a cookie, it is `private, no-store` — caching it at the shared
edge would hand it to someone without the cookie. The per-feed cache (`cacheTtl: 300`) is
unaffected and still carries the load, so this costs nothing upstream.

Set **`SITE_CODE`** (digits, any length — four or six are usual) and **`SESSION_SECRET`** (any long
random string) in Cloudflare. Both have fallbacks so the site works before they are set, but the
default code sits in a public repo and is therefore not a secret — set them. Changing
`SESSION_SECRET` invalidates every existing session, which is how you log everyone out.

Honest limit: a six-digit code is a million combinations, four digits ten thousand. With the delay
that is a long grind, and it keeps out search engines, link-guessers and passers-by. It is not
authentication and there are no per-person accounts — everyone shares one code.

**`/api/feed?debug=1`** reports what the Function actually sees. `feedVars` lists every `FEEDS_*`
variable that reached it and which of them match nobody — that separates "not redeployed yet"
(nothing arrives at all) from "name mistyped" (it arrives but is unmatched). Only names are shown,
never values. Per person it also reports: which variable names were checked
for each person, which were found, where the feeds came from (env or code), and per feed the HTTP
status, size, number of `VEVENT`s and how many fall in the window. Feed addresses are truncated to
host plus a few characters, so the tokens are not exposed.

**Not a feed:** `calendar.google.com/calendar/u/0?cid=…` links are *subscribe* pages that require a
Google sign-in, not calendar data. They only wrap the calendar id, which the code already has.

**How fresh is it?** Two things add delay. The source system republishes its `.ics` on its own
schedule — that part is outside this repo and is usually the bigger share. On top of that,
Cloudflare caches each feed for 5 minutes at the edge; the JSON response is `max-age=0` for
browsers and `s-maxage=300` at the edge, so a reload never serves a stale copy from the browser
itself. The ↻ button sends `?fresh=…` with `no-store`, which bypasses both the edge cache and the
feed cache and really re-fetches. The header shows *Stand HH:MM* — the time the data was last
fetched. The page also re-fetches on load, when navigating outside the loaded window, and on
returning to the tab after 15+ minutes idle.

Handled: recurring events (daily/weekly/monthly/yearly, `INTERVAL`/`COUNT`/`UNTIL`/`BYDAY`/
`BYMONTHDAY`), `EXDATE`, moved single occurrences (`RECURRENCE-ID`), all-day and multi-day events,
`DURATION` without `DTEND`, cancelled events, folded lines, `TZID` and daylight-saving changes.

A feed that can't be read doesn't break the page: that person is marked with a note in the header
(e.g. *"Kalender ist nicht öffentlich freigegeben"* for a 404) and everyone else still renders.

## Adding a new site

1. Create a new folder named after the subdomain (e.g. `mysite/`).
2. Put an `index.html` inside it.
3. Push to `master`.
4. In Cloudflare Pages, create a new project from this repo with the
   **build output directory** set to the new folder, then add the custom
   domain and the matching CNAME at Hostpoint.

## Shared code

Put anything reused across sites in `shared/` and reference it with a
relative path. (Created on demand.)
