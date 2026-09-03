# Captain

A natural-language assistant that answers questions about your vessels from
your database, and refuses to answer from anything else.

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
- **an embeddable widget** — a ship's captain in dress whites in the corner of
  your app, who opens a chat panel when clicked

**No vendor platform is required.** The whole backend is `server.js` — a
plain Node HTTP server. `node server.js` runs it anywhere Node runs: a VPS,
Render, Railway, Fly.io, Docker, your own machine. Netlify support still
exists (`netlify/functions/*.js`) as a thin, optional adapter over the same
logic, for anyone who wants it, but nothing in this project depends on it.

Captain never calls Veson or Geoform during a conversation. Report APIs are
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
| `CAPTAIN_READ_URL` | connection string for `captain_reader` |
| `CAPTAIN_WRITE_URL` | connection string for `captain_writer` (sync + vocabulary) |
| `VESON_API_TOKEN` | Veson IMOS token |
| `VESON_LEGWISE_API` | FuelEU leg-wise report URL (token may be included or not; it is added once) |
| `VESON_OFFHIRE_API` | FuelEU off-hire report URL |
| `GEOFORM_API` | `…/getallforms` |
| `GEOFORM_API_KEY`, `GEOFORM_API_KEY_HEADER` | Geoform key and header name (`library-api`) |
| `CAPTAIN_SYNC_KEY` | shared secret for triggering a sync over HTTP |
| `CAPTAIN_SYNC_DAYS` | how far back Geoform is pulled (default 120) |
| `CAPTAIN_IMOS` | optional comma-separated IMO list; default is every IMO seen in Veson |
| `CAPTAIN_FIELD_MAP` | optional JSON override for upstream field names (see step 3) |
| `CAPTAIN_DATE_ORDER` | `DMY` (default) or `MDY` |
| `CAPTAIN_EXPOSE_SQL` | `1` to send generated SQL to the browser |
| `CAPTAIN_ENABLE_LLM` | `0` to run without a conversation model |
| `CAPTAIN_LLM_PROVIDER` | `ollama` or `openai_compat` |
| `CAPTAIN_LLM_URL`, `CAPTAIN_LLM_MODEL` | where the model is and which one |
| `CAPTAIN_LLM_API_KEY` | only if your own server requires one |
| `CAPTAIN_APP_NAME` | how Captain refers to your application |

A token that has been pasted into a chat or ticket should be rotated. The one
you gave me is in `.env` now; `.gitignore` excludes it.

### 3. Run the migrations, then discover the field names

```bash
psql "$DATABASE_URL" -f db/001_captain.sql     # roles, vocabulary, query log
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
Captain column accepts a list of candidate spellings
(`src/integrations/mapping.js`). Where a report splits fuel by type with no
total, the sync sums the per-fuel columns and flags the row `fuel_derived`.
Anything still unmapped is fixed either by adding a candidate or with one
env var:

```
CAPTAIN_FIELD_MAP={"veson_legs":{"fuel_mt":"TotalFuelConsumedMT"}}
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
  0 * * * *  cd /path/to/captain && /usr/bin/node scripts/sync.js >> sync.log 2>&1
  ```
- **`server.js`'s built-in scheduler** — set `CAPTAIN_AUTO_SYNC=1` (plus
  `CAPTAIN_WRITE_URL`) and the running server pulls fresh data on startup and
  every `CAPTAIN_SYNC_INTERVAL_MS` (default one hour) for as long as it stays
  up. No cron needed if the process runs continuously already.
- **A network trigger**, for a host where only inbound HTTP reaches you:
  ```bash
  curl -X POST https://captain.your-domain.com/api/captain-sync \
       -H "x-captain-sync-key: $CAPTAIN_SYNC_KEY"
  ```
  (or the Netlify equivalent, `netlify.toml` already schedules it hourly, if
  you're using that optional path)

Every write is an upsert on a natural key, so re-running is safe and a
partial failure leaves earlier data intact. A Geoform error for one IMO is a
warning in the result, not an abort. Each run is recorded in
`captain_sync_log` with its warnings.

Vessel ids are IMO numbers — the key Veson and Geoform share. The `vessels`
table is populated from what the sync sees; set `department` there to scope
users the way Geo Monitor does.

### What Captain can be asked

Seventeen metrics across the three sources (`src/config.js`):

| Source | Metrics |
|---|---|
| Geoform reports | shaft power, fuel / ME / AE consumption, distance, speed, RPM, CO2 |
| Veson leg-wise | leg fuel, leg CO2, leg distance, GHG intensity, EU scope share, compliance balance, leg count |
| Veson off-hire | off-hire hours, off-hire days |

Words that span sources are deliberately ambiguous so Captain asks:
"consumption" offers the three Geoform figures and Veson leg fuel; "co2"
offers report CO2 and leg CO2. An organisation can settle any of these once by
teaching Captain ("consumption means fuel consumption").

### 5. Wire authentication

`src/httpHandler.js` has a `verifyToken()` stub that **returns null for every
request** until you implement it (unless `CAPTAIN_DEV_SESSION=1`, prototype
only — see step 6). That is deliberate: Captain refuses everything rather
than trusting a client-supplied identity.

Return `{ userId, orgId, departments?, vesselIds? }`. Give it `departments` to
reuse the Geo Monitor department gate, or `vesselIds` to pin a user to an
explicit list.

### 6. Run it

```bash
CAPTAIN_READ_URL=... CAPTAIN_WRITE_URL=... node server.js
```

That starts a plain HTTP server on `PORT` (default `8787`) serving:

- `GET /` — the prototype host page, standing in for `perform.geoserves.com/pages/`
  until Captain moves there for real. Shows a live readout (backend,
  database, companion model, sign-in mode), a department switcher to try
  RBAC, a page-context demo, and the exact embed snippet for your real page.
- `GET /captain-widget.js` — the widget, as a static file
- `GET|POST /api/captain` — health check / ask a question
- `POST /api/captain-sync` — optional network-triggered sync (see step 4)

For the prototype page to answer without real authentication yet, also set
`CAPTAIN_DEV_SESSION=1` — this makes the backend trust an unsigned token
describing a department, which the page's dropdown generates.
**Remove this before any real user can reach the server** — it exists only
so the prototype can be demonstrated before real auth is wired.

**Deploying it** is running that same command somewhere that stays up:

| Where | How |
|---|---|
| A VPS / your own server | `git clone`, `npm install`, then run under `pm2` or `systemd` so it survives reboots and restarts on crash |
| [Render](https://render.com), [Railway](https://railway.app), [Fly.io](https://fly.io) | free tiers exist on all three; point them at this repo, start command `node server.js` |
| Docker, on any of the above or your own host | `docker build -t captain .` then `docker run -p 8787:8787 --env-file .env captain` |

Set `CAPTAIN_ALLOW_ORIGIN=https://perform.geoserves.com` (comma-separated
list, or `*`, both accepted) once you're ready to embed on your real page,
and put your real domain in front of the server (a reverse proxy like nginx,
or the host's built-in TLS/domain support) so the widget is served over
`https://`.

Moving Captain onto `perform.geoserves.com/pages/` later is one script tag
(the prototype page shows it, pre-filled with wherever it's currently running):

```html
<script src="https://captain.your-domain.com/captain-widget.js"></script>
<script>
  Captain.init({ getToken: function () { return window.SESSION_TOKEN; } });
</script>
```

The widget works out its own API address from the origin it was loaded from,
so the page needs no endpoint configuration — this holds regardless of what
Captain is hosted on. Two things happen server-side: `CAPTAIN_ALLOW_ORIGIN`
as above, and replacing `verifyToken()` in `src/httpHandler.js` with a real
check of the token your page supplies.

`GET /api/captain` is the health check the prototype page reads — it returns
what is configured, never a credential.

<details>
<summary>Optional: deploy on Netlify instead</summary>

`netlify/functions/captain.js` and `captain-sync.js` are thin adapters over
the exact same `src/httpHandler.js` — nothing is duplicated, so both paths
stay correct together. If you'd rather use Netlify:

1. Connect the repo, base directory empty, publish directory `public`
2. Set the same environment variables as above in Netlify's dashboard
3. `netlify.toml` already configures the functions and the hourly schedule
   for `captain-sync`
4. The widget's default endpoint (`/api/captain`) still resolves correctly,
   because Netlify redirects are not needed — the function is reachable at
   that path via `netlify.toml`'s function routing. If you deploy this way,
   confirm `/api/captain` reaches the function in your Netlify project
   settings (redirect rules may be needed depending on your Netlify plan).

</details>

### 7. Make it part of the app

Three things do most of the work:

```js
// 1. Tell Captain what the user is looking at. "Fuel consumption last month"
//    now means this vessel, with no need to name it. Call it on route change.
Captain.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
Captain.clearContext();   // on leaving the vessel page

// 2. Match your brand.
Captain.init({ theme: 'auto', brand: { accent: '#0B3B5C', accent2: '#124A73', font: 'Inter, system-ui, sans-serif' } });

// 3. Open it from your own UI — a help menu, a keyboard shortcut, an empty state.
Captain.open();
Captain.ask('compliance balance this quarter');
```

The current-vessel context is checked against the user's scope on the
server; a vessel id the user can't see is ignored, not trusted.

**Two integration styles.** Floating (default) — a captain in the corner,
click to open. Inline — the panel lives inside your own layout, no floating
badge, always open:

```html
<div id="captain-slot" style="height:100%"></div>
<script src="https://captain.your-domain.com/captain-widget.js"></script>
<script>Captain.init({ mount: '#captain-slot', theme: 'dark' });</script>
```

**Options**

| Option | Default | Purpose |
|---|---|---|
| `endpoint` | `SCRIPT_ORIGIN + '/api/captain'` | where questions are POSTed; overrides the auto-detected origin |
| `getToken` | `null` | returns the bearer token for the signed-in user |
| `ask` | `null` | custom transport `(text, pending, history, context)`; overrides `endpoint` entirely |
| `mount` | `null` | selector or element for inline mode |
| `theme` | `'light'` | `'light'`, `'dark'`, or `'auto'` (follows the OS) |
| `brand` | `null` | `{ accent, accent2, font }` |
| `nudge`, `nudgeText` | `true` | first-visit speech bubble on the badge; retires on first open |
| `followups` | `true` | next-question chips after a data answer |
| `title`, `subtitle`, `greeting`, `examples` | | copy |
| `position` | `'right'` | `'right'` or `'left'` (floating only) |
| `openOnLoad` | `false` | |
| `onOpen`, `onClose`, `onAnswer(data)` | | hooks |

**Methods:** `open()`, `close()`, `ask(text)`, `setContext(ctx)`,
`clearContext()`, `setTheme('light'|'dark'|'auto')`, `destroy()`.

**Interaction details that are easy to miss but were done on purpose:**

- After every data answer, Captain offers two or three follow-ups built from
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
host was ugly, the Captain was not.

**The character.** An original drawing in dress whites — white peaked cap with
a black visor, gold braid and an anchor-in-laurel badge; silver beard;
white jacket with gold shoulder boards and a dark tie; crow's feet drawn
lightly. Painted with gradients for lighting; the face is driven by a `mood`
attribute so a glance at the corner tells you what happened:

| Face | When |
|---|---|
| looking up, brows raised | reading the records |
| small smile | a figure was found |
| one brow up, mouth open | he needs you to choose |
| brows down, flat mouth | the question can't be answered that way |
| slight frown | the records are empty for that period |

He blinks every few seconds. Both the blink and the panel animation are off
under `prefers-reduced-motion`.

## The companion layer

A message is tried against four things, in this fixed order, and stops at
the first one that has a real answer:

1. **the data parser** (`src/engine.js`) — unchanged from the deterministic
   core. If the question is vessel-data-shaped, it's answered or clarified
   here and nothing below ever runs.
2. **the app guide** (`src/guide.js`) — a static knowledge base of "how do I…"
   entries, matched by keyword overlap with typo tolerance. Edit this file to
   teach Captain about your app's features; it is maintained the same way
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

| Server | `CAPTAIN_LLM_PROVIDER` | Notes |
|---|---|---|
| [Ollama](https://ollama.com) | `ollama` (default) | `ollama pull llama3.1:8b`, done. Easiest. |
| vLLM, llama.cpp server, LM Studio, LocalAI | `openai_compat` | point `CAPTAIN_LLM_URL` at the server; `/v1/chat/completions` is appended |

Good small models for this job: `llama3.1:8b`, `qwen2.5:7b`, `mistral:7b`.
Anything that follows a system prompt is fine — the model's only jobs are
navigation help and pleasantries, and the numeric guard covers the rest.

**Where the model runs matters.** `CAPTAIN_LLM_URL` has to be reachable from
wherever `server.js` runs. If both are on the same machine, `http://127.0.0.1:11434`
(Ollama's default) just works. If Captain is deployed elsewhere (a VPS,
Render, Railway), either run Ollama on that same host, or point
`CAPTAIN_LLM_URL` at a model server with a stable network address — a small
VPS, an office server. Without a reachable model, Captain still works: data,
guide and briefing are unaffected, and open-ended chat gets a fixed honest
line instead of a conversation. Set `CAPTAIN_ENABLE_LLM=0` to turn the
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

When a user says "S.P. means Shaft Power", Captain asks for confirmation, then
writes one row to `captain_term_mappings`. Nothing else is written, ever.

Learned mappings *replace* the built-in aliases for that exact term, scoped to
one organisation. That matters for the ambiguous ones: "consumption" is
deliberately ambiguous out of the box, and an org that teaches Captain it means
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
CAPTAIN_TEST_URL='postgres://...' npm test

# parser, dates and SQL shape only
npm run test:offline
```

217 tests: 91 backend, 17 integration, 31 companion, 12 function handler, 16 server, 50 widget. They were run against a live
PostgreSQL 16 through the real migrations, not mocks. Aggregate answers are checked against independently written SQL
rather than against Captain's own output. The widget tests mount the real
script into a jsdom host page and render real engine payloads, including an
XSS probe through every string the server can send.

To set up a local test database:

```bash
createdb captain_test
psql captain_test -f db/001_captain.sql
psql captain_test -f db/002_veson_geoform.sql
psql captain_test -f test/fixtures/example_schema.sql
```

`test/fixtures/example_schema.sql` is a fixture, not a migration. Every number
in it is generated by a formula and is meaningless as vessel data. Delete it
once Captain is pointed at your own tables.

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
month" without saying total or average, Captain picks one based on the metric's
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
  to a clarification prompt rather than an answer. Watch `captain_query_log`
  for `outcome = 'unparsed'` — that is your list of aliases to add.
- **Conversational follow-ups are single-turn.** "And the month before that?"
  is not carried; the pending-clarification mechanism handles one open question
  at a time.
- **All time arithmetic is UTC.** Legs are booked to their arrival date and
  off-hire events to their start date, both derived in UTC.
- **Upstream field names are unverified until you run `discover`.** See step 3.
- **`kind` is your responsibility.** Mark a rate as a quantity and Captain will
  happily sum it. The registry is the safety mechanism, so it has to be right.

If unparsed questions turn out to be common, the cheapest way to add a fallback
is self-hosted Ollama with a small model used *only* to convert a failed
question into the four slots, never to produce a number. Ship this first and
measure before adding that.
