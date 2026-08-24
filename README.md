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

- Tabs per person plus an **Alle** tab that overlays everyone; in *Alle* each person gets one
  colour, in their own tab their original per-calendar colours.
- Monat / Woche / Agenda switch, ↻ reload, last choice remembered in `localStorage`.
  Phones open in Agenda view.

**Adding a family member:** copy the commented-out block in the `CALENDARS` array at the top of
the `<script>`. Take the values from Google Calendar → *Settings → «Integrate calendar»*: every
`&src=…` in the embed code becomes one entry in `srcs`, every `&color=%23xxxxxx` one entry in
`colors` (same order). `color` is the person's colour in the *Alle* view.

**Apple/iCloud calendars:** Apple has no HTML embed, only a `webcal://` .ics feed. Subscribe to it
in Google Calendar (*Other calendars → From URL*, `webcal://` → `https://`), then paste that
Google embed code here. Google re-polls external feeds slowly (hours, not minutes), so those
entries are not live.

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
