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
| `hater/`      | `hater.odermatts.ch`         | Familienkalender. Read-only view of the family's Google Calendar embeds. Static page, no bindings. |
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

`hater/index.html` is a single static page — a read-only view of the family's calendars, no
backend, no bindings. It reuses the old `hater.odermatts.ch` Pages project (build output
directory `hater`).

**One person = one category.** All of a person's calendars (private, work, sport, …) live in
their `srcs` array and show up together under their name; the individual calendar names are never
shown (`showCalendars=0`).

- Tabs: **Alle** (everyone overlaid, one colour per person so you can tell whose event it is)
  plus one tab per person (their own per-calendar colours, if `colors` is set).
- Monat / Woche / Agenda switch, ↻ reload, last choice kept in `localStorage`.
  Phones open in Agenda view.

**Adding a person / a calendar:** edit the `CALENDARS` array at the top of the `<script>`;
commented-out blocks for Mama and Papa are already there. The calendar ID is the `src=…` part of
the Google embed code (*Settings → Calendar → «Integrate calendar»*), before `&ctz=`. Plain
addresses (`someone@gmail.com`, `…@group.calendar.google.com`) and Google's base64 form both work.

**Sharing is what makes it visible.** The page only embeds; it cannot grant access. Every calendar
has to be set **individually** — making a primary calendar public does *not* cascade to the other
calendars in that account. Per calendar: *Settings → pick the calendar → Access permissions for
events → Make available to public → See all event details*. Public means anyone who knows
`hater.odermatts.ch` can read it; the alternative is sharing with each family member's Google
account, which then requires them to be signed into Google in that browser.

**Subscribed calendars can never work here.** A calendar whose id ends in
`@import.calendar.google.com` was added via *Other calendars → From URL* (an Apple/iCloud feed, a
holiday or sports feed, …). Google offers an embed code for it, but its settings have no *Access
permissions* section at all — a subscription cannot be shared or made public, so only the account
that subscribed ever sees it. Everyone else gets *"Events from one or more calendars could not be
shown here because you do not have the permission to view them."* To put such a calendar on this
page, the events must live in a Google calendar that someone **owns**: add the Google account to
the iPhone/Mac (*Settings → Apps → Calendar → Accounts → Add Google*), write events into that
Google calendar, make it public, and use its id here.

**Apple/iCloud calendars:** Apple has no HTML embed, only a `webcal://` .ics feed. Subscribe to it
in Google Calendar (*Other calendars → From URL*, `webcal://` → `https://`), then use the resulting
`…@import.calendar.google.com` ID here. Google re-polls external feeds slowly (hours, not
minutes), so those entries are not live.

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
