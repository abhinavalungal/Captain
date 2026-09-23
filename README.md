# K.R.1.S

**K.R.1.S** (say it "Kris") is the vessel-data assistant embedded in GeoServe
apps. The name is a codename inspired by Lord Krishna — the calm charioteer
who guides without taking the reins — and the whole experience is built around
that idea: a small, friendly figure in the corner of your app who guides you
through your fleet's records and the product, while every figure still comes
straight from your own database.

## Who K.R.1.S is

- **The character.** An original chibi portrait drawn in inline SVG: cloud-blue
  skin, dark curls, a golden mukut with a peacock feather, a Vaishnava tilak,
  makara earrings, a yellow pitambar with a vaijayanti garland, and a bansuri
  resting across the chest. On the launcher the feather lifts past the rim of
  the badge and sways gently; a slow aura of gold, peacock teal, indigo and
  lotus pink turns around it.
- **The palette.** Shyam indigo, peacock teal, temple gold, marigold and lotus
  pink on a warm ivory ground (light), or midnight indigo (dark).
- **The voice.** Serene, warm, clear-sighted and gently playful — never
  preachy. It greets in kind ("Namaste", "Radhe Radhe" and "Hare Krishna" are
  answered with the same words), explains its own name if asked ("what does
  K.R.1.S stand for?"), and does not quote scripture or make religious claims
  unless the user raises the subject.
- **The rule that does not change.** It never states a figure about your
  vessels that did not come from your records, and says so plainly when the
  records don't hold the answer.

## Upgrading an existing deployment

This release renames every identifier, so an existing deployment needs four
one-time steps, in this order:

1. **Database** — run `db/005_rename_to_kris.sql` once against the live
   database. It renames the read views, the vocabulary, query-log and sync-log
   tables, their sequences and indexes, and the two database roles, in one
   transaction. It is idempotent and a no-op on a fresh install. Delete the
   file afterwards if you like; nothing reads it.
2. **Environment** — every variable now starts with `KRIS_` (for example
   `KRIS_READ_URL`, `KRIS_LLM_API_KEY`, `KRIS_ALLOW_ORIGIN`). Rename them in
   your host's dashboard (Render → Environment) before deploying; `.env.example`
   lists them all.
3. **Deploy** the new build.
4. **Embed** — the script is now `/kris-widget.js`, the API is `/api/kris`
   (sync: `/api/kris-sync`, header `x-kris-sync-key`), and the global is
   `KRIS` (`KRIS.init(...)`). Update the snippet on every page that loads the
   widget.

## Speed and chat experience

A greeting used to take 5–10 s because, with `KRIS_MODE=agent`, **every**
message — "hi" included — went to the hosted reasoning model with five tool
definitions, and then the reply waited on a database connection (opened
fresh each time, because idle connections closed after 10 s) to check vessel
names. None of that was needed for "hi".

How a message is handled now:

| Message | Path | Server time |
|---|---|---|
| hi, thanks, bye, how are you | answered **in the browser** — no request at all | 0 ms |
| what can you do, date/time, maths, names, app help | server **fast lane** — no DB, no model, every mode | ~1 ms |
| data questions the parser fully understands | engine directly (agent mode no longer spends model turns deciding to call it) | one SQL round trip |
| everything else | model, **streamed** a sentence at a time | first sentence as soon as the model writes it |

What changed underneath:

- **Fast lane in every mode** (`src/router.js`): instant facts, identity,
  capability, help, small talk and app guide run before agent mode.
- **Streaming** (`src/stream.js`, `server.js`): POST `{ stream: true }`
  returns NDJSON (`delta` / `replace` / `status` / `final`). Text is released
  one whole sentence at a time, and each sentence passes the same
  fabrication guard on the same sentence boundaries as before, so streaming
  never shows anything the old path would have blocked. Non-model answers
  still come back as a single JSON body.
- **No CORS preflight**: the widget sends `text/plain` with the token in the
  body, so cross-origin messages go out without an OPTIONS round trip. The
  `Authorization` header still works (`tokenInHeader: true`).
- **Caches** (`src/cache.js`): RBAC scope and learned vocabulary are reused
  for 60 s, and refreshed in the background on the pool. A conversational
  message never waits on the vocabulary lookup.
- **Warm connections**: the pool keeps idle connections for 5 min
  (`KRIS_PG_IDLE_MS`), pings one every 4 min (`KRIS_PG_KEEPALIVE_MS`,
  `0` = off), and has an `error` handler (before this, a dropped idle
  connection could crash the process). `GET /api/kris` warms the DB and the
  model's TLS connection in the background. The widget calls it when the page
  is idle, which also wakes a sleeping Render instance before the first message.
- **Agent mode**: the guard's vessel-name lookup runs in parallel with the
  model call, from cache. OpenRouter requests ask for the lowest-latency
  provider (`KRIS_LLM_PROVIDER_SORT`, default `latency`, `off` to disable).
  Fixed a `const` reassignment that crashed the retry when a provider rejected
  the `reasoning` field.
- Query logging is fire-and-forget. The metric alias index is memoised
  (classifying a message went from ~1.3 ms to ~0.05 ms). Fuzzy matching no
  longer "corrects" common words ("chat with me for a bit" was read as
  ME FOC, a data question).
- The widget is served from memory, brotli/gzip-compressed (150 KB → 36 KB),
  with an ETag and `max-age=300`. `keepAliveTimeout` is 65 s, so the browser
  reuses its connection between messages.

Measured with `npm run bench` (loopback, mock model with 1.8 s to first
token, database behind a 140 ms round-trip proxy, `KRIS_MODE=agent`):

| Message | Before | After |
|---|---|---|
| Hi / Hello / How are you? | 2,290 ms (2,825 ms cold) | 4–5 ms from the server, 0 ms in the widget |
| What can you do? | 2,289 ms | 3 ms |
| What is the date today? | 3,448 ms | 2 ms |
| How do I export a report? | 2,288 ms | 3 ms |
| fuel consumption for Aurora Trader last month | 4,363 ms | 147 ms |
| Tell me a joke (model) | 2,387 ms, all at once | first sentence at 1,950 ms, then streams |

Add your own network round trip (India → Render, ~200–300 ms) to the server
figures. The model's own time to first token is the one delay code cannot
remove. If `z-ai/glm-5.3-flash` is still slow in practice, set
`KRIS_AGENT_MODEL` to a non-reasoning flash model.

On Render's free plan the instance sleeps after 15 minutes idle and takes
30–60 s to wake. The widget shows "Waking up the server…" while that happens.
To avoid it, use an always-on instance or a free uptime pinger hitting
`GET /api/kris` every 10 minutes.

**Widget**: a new
composer (auto-grow, stop button, Esc to stop, ↑ to edit the last message,
IME-safe Enter), streamed rendering with a steady reveal, safe markdown (code
blocks with copy, tables, lists, links), instrument-style data readouts,
stick-to-bottom scrolling with a "Latest" pill, retry and regenerate,
connection status in the header, per-tab persistence (`persist: false` to
turn off), a new-chat button, suggested prompts on the empty state
(`examples: []` to hide), and a mobile full-screen sheet. The public API
hasn't changed; `KRIS.reset()` and `KRIS.warm()` are new.



No paid APIs or services anywhere. Every component is open-source: Postgres,
the `pg` driver, and — for the optional conversation layer — a model you host
yourself with Ollama or any OpenAI-compatible server. The only runtime
dependency is the Postgres driver.

It ships as four parts:

- **a sync job** that pulls Veson IMOS (FuelEU leg-wise, off-hire) and Geoform
  reports into your Postgres, on a schedule
- **a deterministic data core** — a parser and SQL builder that answers
  vessel questions straight from those tables, and only from them
- **a router** that also handles app-navigation questions from a static
  knowledge base, a data-driven "anything I should know" briefing, and
  everything else (greetings, small talk) via a self-hosted open-source
  model — see "The companion layer" below for how that stays safe
- **an embeddable widget** — K.R.1.S, a small Krishna-inspired figure in the
  corner of your app, who opens a chat panel when clicked

**No vendor platform is required.** The whole backend is `server.js` — a
plain Node HTTP server. `node server.js` runs it anywhere Node runs: a VPS,
Render, Railway, Fly.io, Docker, your own machine.

K.R.1.S never calls Veson or Geoform during a conversation. Report APIs are
slow, return whole reports, and would put a third party between a user and a
question about their own vessel. Sync on a schedule; answer from the copy.

---

## What it does

```
"What was the S.P. for Aurora Trader yesterday?"
  -> Shaft power for Aurora Trader on 31 August 2026: 9,855.8 kW.
     Vessel Aurora Trader · Period Yesterday · Reports read 1 · Source Daily noon reports
```

```
"Tell me the consumption from 1 January until today."
  -> Which measurement do you mean by "consumption"?
     [Fuel consumption (MT)] [Main engine consumption (MT)] [Auxiliary engine consumption (MT)]
```

```
"total shaft power last month"
  -> Adding up shaft power across reports does not produce a meaningful
     number — it is an instantaneous reading, not an amount that accumulates.
     I can give you the average, minimum or maximum instead.
```

```
"shaft power on 25 December 2026"
  -> I could not find this information in the available vessel data.
```

---

## Why there is no language model in it

Your query space is narrow. Every question in the brief reduces to four slots:
vessel, metric, time range, aggregation. That is slot filling against a closed
vocabulary, and a deterministic parser beats a model at it on the axis you
care about most.

The difference is the failure mode. A model that misreads a question returns a
fluent, plausible, wrong number. This parser returns "I did not understand
that — did you mean X?" It cannot invent a figure, because there is exactly one
code path that puts a number into an answer: reading a value out of a result
set from the query built for that question. There is no fallback that produces
a number when the query returns no rows.

Accuracy here is a property of the architecture, not of how well something was
prompted.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill it in. Everything sensitive is read
from the environment — the widget has no credentials and does not know the
upstream APIs exist.

| Variable | Purpose |
|---|---|
| `KRIS_READ_URL` | connection string for `kris_reader` |
| `KRIS_WRITE_URL` | connection string for `kris_writer` (sync + vocabulary) |
| `VESON_API_TOKEN` | Veson IMOS token |
| `VESON_LEGWISE_API` | FuelEU leg-wise report URL (token may be included or not; it is added once) |
| `VESON_OFFHIRE_API` | FuelEU off-hire report URL |
| `GEOFORM_API` | `…/getallforms` |
| `GEOFORM_API_KEY`, `GEOFORM_API_KEY_HEADER` | Geoform key and header name (`library-api`) |
| `KRIS_SYNC_KEY` | shared secret for triggering a sync over HTTP |
| `KRIS_SYNC_DAYS` | how far back Geoform is pulled (default 120) |
| `KRIS_IMOS` | optional comma-separated IMO list; default is every IMO seen in Veson |
| `KRIS_FIELD_MAP` | optional JSON override for upstream field names (see step 3) |
| `KRIS_DATE_ORDER` | `DMY` (default) or `MDY` |
| `KRIS_EXPOSE_SQL` | `1` to send generated SQL to the browser |
| `KRIS_ENABLE_LLM` | `0` to run without a conversation model |
| `KRIS_LLM_PROVIDER` | `ollama` or `openai_compat` |
| `KRIS_LLM_URL`, `KRIS_LLM_MODEL` | where the model is and which one |
| `KRIS_LLM_API_KEY` | only if your own server requires one |
| `KRIS_APP_NAME` | how K.R.1.S refers to your application (`Shuddha now`) |

A token that has been pasted into a chat or ticket should be rotated. The one
you gave me is in `.env` now; `.gitignore` excludes it.

### 3. Run the migrations, then discover the field names

```bash
psql "$DATABASE_URL" -f db/001_kris.sql     # roles, vocabulary, query log
psql "$DATABASE_URL" -f db/002_veson_geoform.sql  # synced tables + grants
npm run discover                                # one call to each API
```

`discover` calls each upstream API once and prints the real field names, the
mapping the sync resolved, and anything it could not place:

```
=== Veson FuelEU leg-wise: 412 rows ===
  fields: imoNumber, vesselName, voyageNo, ...
  mapped:
    imo                  <- imoNumber
    dep_time             <- departureTime
    ...
  no upstream field for: fuel_mt
  unmapped upstream fields: HFO_MT, VLSFO_MT, MGO_MT
```

The mapper is tolerant of case, spaces, underscores and hyphens, and each
K.R.1.S column accepts a list of candidate spellings
(`src/integrations/mapping.js`). Where a report splits fuel by type with no
total, the sync sums the per-fuel columns and flags the row `fuel_derived`.
Anything still unmapped is fixed either by adding a candidate or with one
env var:

```
KRIS_FIELD_MAP={"veson_legs":{"fuel_mt":"TotalFuelConsumedMT"}}
```

**I could not run `discover` for you.** The build environment cannot reach
`api.veslink.com` or `perform.geoserves.com`, so the candidate lists are
educated guesses and the sync was tested against stub payloads in three
different shapes. Run it once; it takes a minute and tells you exactly what
to change, if anything.

### 4. Sync

```bash
npm run sync
```

No platform required to run it on a schedule — three options, pick one:

- **A system cron entry**, the simplest and most portable:
  ```
  0 * * * *  cd /path/to/kris && /usr/bin/node scripts/sync.js >> sync.log 2>&1
  ```
- **`server.js`'s built-in scheduler** — set `KRIS_AUTO_SYNC=1` (plus
  `KRIS_WRITE_URL`) and the running server pulls fresh data on startup and
  every `KRIS_SYNC_INTERVAL_MS` (default one hour) for as long as it stays
  up. No cron needed if the process runs continuously already.
- **A network trigger**, for a host where only inbound HTTP reaches you:
  ```bash
  curl -X POST https://kris.your-domain.com/api/kris-sync \
       -H "x-kris-sync-key: $KRIS_SYNC_KEY"
  ```

Every write is an upsert on a natural key, so re-running is safe and a
partial failure leaves earlier data intact. A Geoform error for one IMO is a
warning in the result, not an abort. Each run is recorded in
`kris_sync_log` with its warnings.

Vessel ids are IMO numbers — the key Veson and Geoform share. The `vessels`
table is populated from what the sync sees; set `department` there to scope
users the way Shuddha now does.

### What K.R.1.S can be asked

Seventeen metrics across the three sources (`src/config.js`):

| Source | Metrics |
|---|---|
| Geoform reports | shaft power, fuel / ME / AE consumption, distance, speed, RPM, CO2 |
| Veson leg-wise | leg fuel, leg CO2, leg distance, GHG intensity, EU scope share, compliance balance, leg count |
| Veson off-hire | off-hire hours, off-hire days |

Words that span sources are deliberately ambiguous so K.R.1.S asks:
"consumption" offers the three Geoform figures and Veson leg fuel; "co2"
offers report CO2 and leg CO2. An organisation can settle any of these once by
teaching K.R.1.S ("consumption means fuel consumption").

### 5. Wire authentication

`src/httpHandler.js` has a `verifyToken()` stub that **returns null for every
request** until you implement it (unless `KRIS_DEV_SESSION=1`, prototype
only — see step 6). That is deliberate: K.R.1.S refuses everything rather
than trusting a client-supplied identity.

Return `{ userId, orgId, departments?, vesselIds? }`. Give it `departments` to
reuse the Shuddha now department gate, or `vesselIds` to pin a user to an
explicit list.

### 6. Run it

```bash
KRIS_READ_URL=... KRIS_WRITE_URL=... node server.js
```

That starts a plain HTTP server on `PORT` (default `8787`) serving:

- `GET /` — the prototype host page, standing in for `perform.geoserves.com/pages/`
  until K.R.1.S moves there for real. Shows a live readout (backend,
  database, companion model, sign-in mode), a department switcher to try
  RBAC, a page-context demo, and the exact embed snippet for your real page.
  It carries the Shuddha now identity: the reverse logo in a Deep Pine
  header, the compass-and-kayak favicon, and the brand palette and typeface
  (Manrope, served locally from `assets/fonts/`).
- `GET /assets/…`, `/favicon.ico`, `/site.webmanifest` — the logo (light and
  reverse), symbol, favicons, app icons, social preview image and fonts. The
  SVGs are vector artwork with the lettering converted to outlines, so they
  render the same on every machine with no font installed.

The complete brand kit — every logo version as SVG and PNG, app icons, and
the brand guide (`brand/Shuddha-now-brand-guide.pdf`) — is in `brand/`; see
`brand/README.md` for which file to use where. It is not part of the deployed
server.
- `GET /kris-widget.js` — the widget, as a static file
- `GET|POST /api/kris` — health check / ask a question
- `POST /api/kris-sync` — optional network-triggered sync (see step 4)

For the prototype page to answer without real authentication yet, also set
`KRIS_DEV_SESSION=1` — this makes the backend trust an unsigned token
describing a department, which the page's dropdown generates.
**Remove this before any real user can reach the server** — it exists only
so the prototype can be demonstrated before real auth is wired.

**Deploying it** is running that same command somewhere that stays up:

| Where | How |
|---|---|
| A VPS / your own server | `git clone`, `npm install`, then run under `pm2` or `systemd` so it survives reboots and restarts on crash |
| [Render](https://render.com), [Railway](https://railway.app), [Fly.io](https://fly.io) | free tiers exist on all three; point them at this repo, start command `node server.js` |
| Docker, on any of the above or your own host | `docker build -t kris .` then `docker run -p 8787:8787 --env-file .env kris` |

Set `KRIS_ALLOW_ORIGIN=https://perform.geoserves.com` (comma-separated
list, or `*`, both accepted) once you're ready to embed on your real page,
and put your real domain in front of the server (a reverse proxy like nginx,
or the host's built-in TLS/domain support) so the widget is served over
`https://`.

Moving K.R.1.S onto `perform.geoserves.com/pages/` later is one script tag
(the prototype page shows it, pre-filled with wherever it's currently running):

```html
<script src="https://kris.your-domain.com/kris-widget.js"></script>
<script>
  KRIS.init({ getToken: function () { return window.SESSION_TOKEN; } });
</script>
```

The widget works out its own API address from the origin it was loaded from,
so the page needs no endpoint configuration — this holds regardless of what
K.R.1.S is hosted on. Two things happen server-side: `KRIS_ALLOW_ORIGIN`
as above, and replacing `verifyToken()` in `src/httpHandler.js` with a real
check of the token your page supplies.

`GET /api/kris` is the health check the prototype page reads — it returns
what is configured, never a credential.

### 7. Make it part of the app

Three things do most of the work:

```js
// 1. Tell K.R.1.S what the user is looking at. "Fuel consumption last month"
//    now means this vessel, with no need to name it. Call it on route change.
KRIS.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
KRIS.clearContext();   // on leaving the vessel page

// 2. Match your brand.
KRIS.init({ theme: 'auto', brand: { accent: '#2B3A9E', accent2: '#0F8F8A', font: 'Inter, system-ui, sans-serif' } });

// 3. Open it from your own UI — a help menu, a keyboard shortcut, an empty state.
KRIS.open();
KRIS.ask('compliance balance this quarter');
```

The current-vessel context is checked against the user's scope on the
server; a vessel id the user can't see is ignored, not trusted.

**Two integration styles.** Floating (default) — K.R.1.S in the corner,
click to open. Inline — the panel lives inside your own layout, no floating
badge, always open:

```html
<div id="kris-slot" style="height:100%"></div>
<script src="https://kris.your-domain.com/kris-widget.js"></script>
<script>KRIS.init({ mount: '#kris-slot', theme: 'dark' });</script>
```

**Options**

| Option | Default | Purpose |
|---|---|---|
| `endpoint` | `SCRIPT_ORIGIN + '/api/kris'` | where questions are POSTed; overrides the auto-detected origin |
| `getToken` | `null` | returns the bearer token for the signed-in user |
| `ask` | `null` | custom transport `(text, pending, history, context)`; overrides `endpoint` entirely |
| `mount` | `null` | selector or element for inline mode |
| `theme` | `'light'` | `'light'`, `'dark'`, or `'auto'` (follows the OS) |
| `brand` | `null` | `{ accent, accent2, font }` |
| `nudge`, `nudgeText` | `true` | first-visit speech bubble on the badge; retires on first open |
| `followups` | `true` | next-question chips after a data answer |
| `title`, `tagline`, `kicker`, `subtitle`, `greeting`, `intro`, `examples`, `placeholder` | | copy |
| `position` | `'right'` | `'right'` or `'left'` (floating only) |
| `openOnLoad` | `false` | |
| `onOpen`, `onClose`, `onAnswer(data)` | | hooks |

**Methods:** `open()`, `close()`, `ask(text)`, `setContext(ctx)`,
`clearContext()`, `setTheme('light'|'dark'|'auto')`, `destroy()`.

**Interaction details that are easy to miss but were done on purpose:**

- After every data answer, K.R.1.S offers two or three follow-ups built from
  that answer's provenance — trend, comparison, six-month analysis — so the
  next question is one tap. An empty answer offers wider periods instead of a
  dead end. These chips are quieter than clarification choices, because a
  clarification needs an answer and a follow-up is optional.
- Every answer has a copy button (visible on hover, always on touch).
- Enter sends, Shift+Enter is a newline, Escape closes, focus moves into the
  composer on open and back to the badge on close.
- The composer is 16px on phones so iOS doesn't zoom on focus, and the sheet
  respects the home-indicator safe area.
- Every animation is off under `prefers-reduced-motion`.

**Isolation.** The widget renders inside a Shadow DOM with a `:host{all:initial}`
reset. Your page's CSS cannot restyle it, and its CSS cannot leak out. This
was verified by mounting it into a host page with hostile global rules
(`* { font-family: "Comic Sans MS" !important; color: red !important }`,
`button { background: lime !important }`) and screenshotting in Chromium: the
host was ugly, the widget was not.

**The character.** An original chibi drawing of Krishna in inline SVG — no
images, no fonts, no network. Painted with gradients for light; every moving
part (eyes, brows, mouth, cheeks, the feather) is driven by a `mood`
attribute, so a glance at the corner tells you what happened:

| Face | When |
|---|---|
| eyes up and aside, flute notes drifting off the badge | reading the records |
| open smile, feather dancing | a figure was found |
| one brow up, mouth a small "o" | K.R.1.S needs you to choose |
| inner brows lifted, feather drooping | the question can't be answered that way |
| slight frown | the records are empty for that period |
| cheeks flushed, gaze dropped | you paid a compliment |
| eyes closed in a laugh | you made a joke |

K.R.1.S blinks every few seconds and its eyes follow the cursor. The blink,
the aura, the feather sway, the flute notes and the panel animation are all
off under `prefers-reduced-motion`.

`KRIS.react('success' | 'fail' | 'praise' | 'funny' | 'confused')` drives the
same faces from events in your app; `KRIS.setMood(name)` sets one directly
(`KRIS.emotions` lists them).

## The companion layer

A message is tried against four things, in this fixed order, and stops at
the first one that has a real answer:

1. **the data parser** (`src/engine.js`) — unchanged from the deterministic
   core. If the question is vessel-data-shaped, it's answered or clarified
   here and nothing below ever runs.
2. **the app guide** (`src/guide.js`) — a static knowledge base of "how do I…"
   entries, matched by keyword overlap with typo tolerance. Edit this file to
   teach K.R.1.S about your app's features; it is maintained the same way
   you'd maintain a help center, not trained.
3. **the briefing** (`src/alerts.js`) — triggered by phrases like "anything I
   should know" or "give me a briefing". Every finding is a plain SQL query
   with a threshold (a negative compliance balance, off-hire hours over 24 in
   30 days, no report in 3+ days) — no model involved, so a briefing carries
   the same guarantee as any other data answer.
4. **the companion** (`src/companion.js`) — a self-hosted open-source model
   for whatever is left: greetings, small talk, phrasing the parser and guide
   both missed.

The companion is never in the path for a vessel figure, and that is enforced
twice, not once:

- **Structurally.** `converse()` is called with no database handle and no
  query tool, and neither request shape it builds carries a `tools` field.
  There is nothing in that function that can execute SQL. It can fabricate a
  number if asked to, but it cannot retrieve a real one — the distinction
  matters for what happens next.
- **Defensively.** Every reply is scanned before it reaches the user. A
  number next to a unit (kW, MT, nm, %, hours, gCO2e…) or a suspicious bare
  number is treated as a stated measurement, and the whole reply is discarded
  in favour of a fixed redirect: *"ask me directly and I'll pull it from the
  records."* This is tested directly — `test/companion.js` feeds the
  companion a fabricated fuel figure through a stubbed model response and
  asserts the number never reaches the returned text, for both provider
  shapes.

### Running the model

Any of these works; all are free and open-source:

| Server | `KRIS_LLM_PROVIDER` | Notes |
|---|---|---|
| [Ollama](https://ollama.com) | `ollama` (default) | `ollama pull llama3.1:8b`, done. Easiest. |
| vLLM, llama.cpp server, LM Studio, LocalAI | `openai_compat` | point `KRIS_LLM_URL` at the server; `/v1/chat/completions` is appended |

Good small models for this job: `llama3.1:8b`, `qwen2.5:7b`, `mistral:7b`.
Anything that follows a system prompt is fine — the model's only jobs are
navigation help and pleasantries, and the numeric guard covers the rest.

**Where the model runs matters.** `KRIS_LLM_URL` has to be reachable from
wherever `server.js` runs. If both are on the same machine, `http://127.0.0.1:11434`
(Ollama's default) just works. If K.R.1.S is deployed elsewhere (a VPS,
Render, Railway), either run Ollama on that same host, or point
`KRIS_LLM_URL` at a model server with a stable network address — a small
VPS, an office server. Without a reachable model, K.R.1.S still works: data,
guide and briefing are unaffected, and open-ended chat gets a fixed honest
line instead of a conversation. Set `KRIS_ENABLE_LLM=0` to turn the
companion off outright.

The widget carries the last few conversational turns in memory (not persisted,
not sent to the data endpoints) so the companion has continuity within a
session — but a data lookup or a clarification is never added to that
history, because there is nothing about a fuel figure the companion should
be recalling in small talk later.

## How access control works

The scope is resolved from the session *before* the question is parsed, and the
parser is only ever shown vessels inside it. A vessel a user cannot see cannot
be named, cannot be offered in a disambiguation list, and cannot be confirmed
to exist — asking about it looks exactly like asking about a vessel that is not
in the fleet.

The resolved vessel ids are then passed into every statement as a bound
parameter. There is no code path in `src/sql.js` that builds a query without
the scope predicate; `build()` throws on an empty scope rather than running
unfiltered.

Injection is impossible by construction rather than by filtering: table and
column names come only from the registry, and every value is bound. A vessel id
containing `'; DROP TABLE noon_reports;--` reaches the driver as a parameter
and never appears in SQL text. There is a test for exactly that.

---

## How learning works

When a user says "S.P. means Shaft Power", K.R.1.S asks for confirmation, then
writes one row to `kris_term_mappings`. Nothing else is written, ever.

Learned mappings *replace* the built-in aliases for that exact term, scoped to
one organisation. That matters for the ambiguous ones: "consumption" is
deliberately ambiguous out of the box, and an org that teaches K.R.1.S it means
fuel consumption stops being asked, while every other org still is.

Two guards:

- A term cannot be redirected to a metric outside its own ambiguity group.
  "Consumption means shaft power" is refused, because it would silently change
  the meaning of every answer already given.
- A learned term cannot shadow a config alias belonging to a different metric.

Learning changes which column is read. It cannot change what the column
contains — a test asserts the stored values are byte-identical before and after
a teaching cycle.

---

## Tests

```bash
# full suite, needs a database
KRIS_TEST_URL='postgres://...' npm test

# no database: parser, fast lane, streaming, widget, server
npm run test:offline

# end-to-end latency (add BENCH_PG_URL=postgres://... to include data questions)
npm run bench
```

`test/stream_test.js` covers the fast lane (zero model calls in agent mode),
sentence-gated streaming, the guard inside a stream, cancellation, and the
NDJSON protocol over a real `server.js`. The model is `test/mock_llm.js`, a
local OpenAI-compatible server with configurable latency. `test/widget.js`
mounts the real widget in a hostile jsdom host page with a fake transport. It
covers local replies, the no-preflight transport, streaming, XSS probes,
clarification, errors and retry, stop, keyboard handling, persistence and
reactions. It needs no database.

To set up a local test database:

```bash
createdb kris_test
psql kris_test -f db/001_kris.sql
psql kris_test -f db/002_veson_geoform.sql
psql kris_test -f test/fixtures/example_schema.sql
```

`test/fixtures/example_schema.sql` is a fixture, not a migration. Every number
in it is generated by a formula and is meaningless as vessel data. Delete it
once K.R.1.S is pointed at your own tables.

---

## Design decisions worth knowing about

**Dates are hand-written, not from a library.** The common date libraries
resolve a bare "1 January" asked in September to *next* January, and return a
single instant for "last month" rather than the month. Both produce confidently
wrong answers about vessel history. Here a bare month/day always resolves to
the most recent occurrence at or before today, and every period phrase expands
to its full span. `31 February` is rejected outright rather than being widened
to the whole of February.

**Typo tolerance is scaled to word length, and short words get none.** "ap" does
not become "sp". They are different metrics, and guessing between them is the
exact failure this system exists to prevent. Longer fuzzy matches are confirmed
with the user, never silently accepted.

**Assumptions are disclosed, not hidden.** If you ask for "fuel consumption last
month" without saying total or average, K.R.1.S picks one based on the metric's
`kind` and then tells you it did.

**Coverage gaps are always stated.** A total over a period with missing days is
the commonest way to be confidently wrong, so if the reports do not cover the
period, the answer says so next to the figure.

**Comparisons flag when they are not like-for-like.** Comparing a 1-day month to
date against a full 31-day month produces a real number and a warning that the
report counts differ.

**In the widget, chart-caution colour is reserved for trust.** Assumptions and
coverage gaps get it. Neutral explanations of how a figure was built do not,
because using the warning treatment for both would blunt it.

---

## Known limits

- **It handles phrasings that were anticipated.** Novel phrasing falls through
  to a clarification prompt rather than an answer. Watch `kris_query_log`
  for `outcome = 'unparsed'` — that is your list of aliases to add.
- **Conversational follow-ups are single-turn.** "And the month before that?"
  is not carried; the pending-clarification mechanism handles one open question
  at a time.
- **All time arithmetic is UTC.** Legs are booked to their arrival date and
  off-hire events to their start date, both derived in UTC.
- **Upstream field names are unverified until you run `discover`.** See step 3.
- **`kind` is your responsibility.** Mark a rate as a quantity and K.R.1.S will
  happily sum it. The registry is the safety mechanism, so it has to be right.

If unparsed questions turn out to be common, the cheapest way to add a fallback
is self-hosted Ollama with a small model used *only* to convert a failed
question into the four slots, never to produce a number. Ship this first and
measure before adding that.
