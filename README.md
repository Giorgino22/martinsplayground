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
| `hater/`      | `hater.odermatts.ch`         | Familienkalender. Read-only view of the family's public `.ics` feeds. Needs Pages Functions (Root directory `hater`), no bindings. |
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
The old standalone `chooser.odermatts.ch` project can be deleted; `hater.odermatts.ch` has been
repurposed as the family calendar (see below).

**Cloudflare config (important):** because this project uses Pages Functions in
`nizza/functions/`, the project's **Root directory** must be set to `nizza` (Functions are
detected relative to the Root directory). With Root directory = `nizza`, the **Build output
directory** is `/` (assets sit at the root of `nizza`). If Root directory is left at the repo
root, Functions are not deployed and `/api/*` returns 405.

### hater (Familienkalender)

A read-only view of the whole family's calendars. It reuses the old `hater.odermatts.ch` Pages
project. **Nobody logs in to look at it** — the page reads public `.ics` feeds server-side and
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
- *Apple/iCloud:* iCloud.com → Calendar → the share icon next to the calendar → *Public Calendar*
  → copy link, replace `webcal://` with `https://`, paste it in. No Google detour, so it is live
  rather than delayed.

**Don't want a calendar public?** Google also offers a *Secret address in iCal format* under
*Integrate calendar* (ends in `/private-xxxxx/basic.ics`). It works without sign-in and without
making the calendar public — but it is effectively a password, so it must **not** be committed to
this repo, which is public. Put those in Cloudflare environment variables instead:
`FEEDS_MARTIN`, `FEEDS_PATRICK`, `FEEDS_MAMA`, `FEEDS_PAPA` — several addresses separated by
commas, semicolons or newlines (any mix; trailing separators and blank lines are fine). When set,
the variable replaces that person's `feeds` list in the code. An entry that obviously isn't a feed
— a `?cid=` subscribe link, or anything without `http(s)://` — is skipped and named in that
person's note rather than silently failing.

All four people exist as slots in `PEOPLE`. A person with no feeds at all (in code or env) is left
out of the response entirely, so Mama and Papa show no tab until `FEEDS_MAMA` / `FEEDS_PAPA` is
set — at which point they appear on their own, no code change needed. Secrets are per **calendar**,
not per account: someone with five calendars contributes five addresses to their variable.

**Not a feed:** `calendar.google.com/calendar/u/0?cid=…` links are *subscribe* pages that require a
Google sign-in, not calendar data. They only wrap the calendar id, which the code already has.

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
