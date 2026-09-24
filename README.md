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

## A personal assistant underneath

On the surface K.R.1.S is the same small figure in the corner. Underneath,
this release makes it a personal, context-aware assistant: it knows who it is
talking to (when the user allows it), keeps conversations, and can be shaped
by the user.

**The menu.** The ☰ button in the header opens a drawer inside the panel:
New chat, Chat, History (with the five most recent conversations), then
Profile, Memory, Appearance, Settings and About, and the user's own name and
role at the foot. Each section slides over the conversation in the same
indigo-and-ivory design, with a "‹ Chat" back button; Esc peels back one
layer at a time (drawer, then section, then the panel).

**Two kinds of context, kept apart on purpose.**

| | Conversation context | Long-term memory |
|---|---|---|
| What | This chat's messages, anything the user said about themselves in it, the vessel on screen | Only what the user said yes to |
| Lifetime | Until a new chat starts (it stays with the chat in History) | Until the user edits or deletes it |
| Where it shows | Memory → "This conversation only" | Memory → "K.R.1.S remembers", and Profile |

**Asking before remembering.** When a message states something useful —
*"I'm Alex and I work as a marine emissions analyst."* — the widget
recognises the name and role locally (no model, no network), uses them in
that conversation straight away, and puts a card under the reply: *"Would
you like me to remember this for next time?"* with each value editable and
tickable. **Remember** saves; **Not now** keeps it in this chat only and is
never asked again for that value. Detection only ever proposes profile
fields (name, preferred name, role, company, department, location, time
zone, interests, answer length, tone) — random conversation content never
becomes permanent memory. Passwords, ID and account numbers, contact details,
and health, religious, political, sexual, marital or financial details are
never proposed and are refused if asked for.

**Talking to memory.** "Remember that I report to the fleet director
weekly", "forget my role", "forget that", "forget everything" (asks first)
and "what do you remember about me?" are answered in the browser, instantly.
So are questions about the user — "where do I work?", "what's my company
name?", "tell me about me", typos included: they come from the profile and
this chat, never from the app guide. If the chat knows details that aren't
saved, the answer says so and offers **Remember these** (with Undo). The
server answers the same questions from `context.profile` for other clients.
"S.P. means shaft power" is still vocabulary teaching and still goes to the
server.

**The user stays in control.** Memory → turn memory off (kept, not used),
turn suggestions off, see every item with where it came from ("Learned in
chat · 23 Sep", "Added by you", "From your account"), edit, forget (with
Undo), add a note, clear all (two presses). Profile → edit every field; time
zone is validated and, once set, is what "today" means.

**Where it lives.** Memory and History are stored in this browser
(localStorage), namespaced per endpoint and per user (`user.id`). With each
message the widget sends only the approved profile, merged with this chat's
context, as `context.profile`. The server (`src/profile.js`) whitelists and
caps it, adds an "about the user" block to the conversation layer's system
prompt, and keeps nothing. The profile can change how K.R.1.S talks — the
name, the examples, the length and tone of answers — and never a figure:
nothing in it reaches the parser, the SQL builder or the data engine, and a
test proves a figure-shaped note cannot leak into a data answer. To follow a
user across devices later, pass `memoryStore: { load, save }` and keep it in
your own backend; nothing else changes.

**History.** Conversations are kept on this device for 30 days (at most 40),
listed by day, searchable, reopened exactly where they were left (their
context included), and deletable with Undo. The empty state offers
"Continue …" for the latest one, and its suggestions follow the user's role
once K.R.1.S knows it (compliance prompts for an emissions analyst, engine
prompts for a superintendent, off-hire and legs for commercial roles).

**Chat.** A clock appears on the thinking line after 3 s and a plain reason
after 12 s; a long answer stops scrolling once it fills the view so it can be
read from its first line ("Latest" jumps to the end); your own messages can
be copied or edited and resent (↑ in an empty composer); a failed send says
"Not delivered" on the bubble and the error card offers Try again; toasts
confirm changes, with Undo where it matters.

**Appearance and settings.** Light / dark / system, three text sizes,
comfortable or compact density, times on or off, reduce motion (on top of
the OS setting), a still character; Enter-to-send or Ctrl/⌘+Enter, follow-ups
on or off, history on or off, delete all history, keyboard shortcuts, reset,
and delete everything on this device. About shows the server's status and
build, and how information is handled.

**On a shared machine,** call `KRIS.forget()` at sign-out, or pass the
signed-in user's id as `user.id` so each person's memory and history stay
apart. `KRIS.setUser({ id })` switches user without a page load.

**For later.** Sections are a registry (one entry and one render function to
add another), replies can carry section-link actions, every message carries
`client: { v, features }` for capability negotiation, and `KRIS.on(...)`
exposes `memory`, `settings`, `view`, `conversation`, `open`, `close` and
`answer` events. Voice, files, tools, other models or workspace knowledge
can be added on these seams without rebuilding the widget.

### Upgrading to kris-11 (new Supabase database, test environment)

- **New database:** Supabase project `rpiuxplctquqwqvmgxqk`. Everything K.R.1.S
  reads lives in one private schema, `kris`, defined in `db/001_schema.sql`
  (which replaces `db/001`–`005`, `check_connection.js` and
  `schema_report.sql`; they are in git history). Set it up with:

  ```bash
  node db/setup.js            # schema, roles, test data, checks
  node db/setup.js --check    # checks only
  ```

  `db/setup.js` reads `DATABASE_URL` (the `postgres` connection, used by setup
  only), gives `kris_reader` and `kris_writer` random passwords, writes
  `KRIS_READ_URL` / `KRIS_WRITE_URL` into `.env` without printing them, loads
  the test data and runs the checks, first as the owner, then as
  `kris_reader` through K.R.1.S's own engine and records code.
  `--print-seed > seed.sql` gives the test data as SQL for the SQL editor.
- **Security.** The `kris` schema is not exposed to Supabase's Data API, and
  `anon` / `authenticated` are revoked on it, so the publishable key reaches
  nothing. Row-level security is on for every table: the two server roles
  have policies, and any other role sees no rows. The server runs as
  `kris_reader` (read-only sessions) instead of `postgres`, which the
  previous `.env` used. `DATABASE_URL` belongs on the machine that runs setup,
  never on the server.
- **Facts in tables, figures in views.** Tables hold vessels, voyages, port
  calls, reports, fuel by type and consumer, bunker deliveries, filings,
  trades, allocations, invoices, emails and the regulatory parameters
  (emission factors, CII reference lines and reduction factors, FuelEU
  targets, ETS phase-in). Voyage days, CO2 and CO2e, energy, GHG intensity,
  FuelEU balances and penalties, AER/CII and the rating, allowance
  obligations, exposure and invoice status are views, so they cannot drift
  from the facts. `kris.voyage_summary`, `cii_annual`, `fueleu_period`,
  `ets_obligations`, `carbon_exposure` and `compliance_overview` are the ones
  to start with.
- **Records tool.** Until now K.R.1.S could only aggregate one measurement
  over a period. The new `get_vessel_records` tool (`src/records.js`, driven by
  `RECORDS` in `src/config.js`) reads rows: particulars, voyages and ports,
  fuel by voyage, BDNs, DCS/MRV annual figures, CII, FuelEU, allowances,
  exposure, filings, trades, invoices and emails. Same rules as the engine:
  identifiers only from the registry, values bound, vessel scope mandatory.
  Figures the tool returned may be stated; the output guard still blocks any
  other figure about the user's vessels.
- **Metrics.** Voyage metrics read `kris.voyage_summary` (fuel by type, CO2,
  distance, voyage/net/sea/port days, voyage FuelEU balance). The metrics on
  the old `fueleu_final` / `dnv` views are gone (those tables are not in the
  new database, and their units were unconfirmed). So is the per-voyage GHG
  average: the energy-weighted intensity is in the FuelEU records.
- **Router.** The engine still answers a complete figure question without the
  model. Its clarifying questions now go to the model, which can answer the
  likely reading from the records ("How much VLSFO did TEST VESSEL 01
  consume?" gets the figures by year, not "over what period?").
- **Briefing.** The FuelEU rule reads this year's balance after pooling, and a
  new rule flags allowances still to surrender within 30 days of the deadline.
- **Test data** (`db/test_data.js`): TEST VESSEL 01 (IMO 1000019, Ultramax bulk
  carrier, scrubber, HSFO/VLSFO/MGO) and TEST VESSEL 02 (IMO 1000021, LNG
  dual-fuel Aframax tanker), January 2023 to the day it is loaded. Each voyage
  timeline is simulated, and reports and fuel follow from engine power and
  speed. Pooling, surrenders, allocations, invoice amounts and the figures
  quoted in emails are inserted by SQL that reads the views, so every number
  agrees. Scenarios built in: TEST VESSEL 01 rated CII D three years running
  (corrective action plan due), a 2025 FuelEU deficit covered by pooling with
  TEST VESSEL 02, 2025 EUAs still to source close to the deadline, a UK ETS
  obligation from an August 2026 Immingham–Teesport voyage, an EU MRV
  verification held on a disputed BDN, and paid, pending, overdue and draft
  invoices. IMO numbers in the 1000000 range are not issued to ships; company
  names start with TEST and emails use `.example`.
- **Tests.** `test/db_test.js` loads the real schema and test data into an
  in-memory Postgres (PGlite, a dev dependency) on every `npm test`. It checks
  the structure, security, row-level security and consistency, and runs
  questions through the engine, the records tool, the briefing and the router.

### Upgrading to kris-10 (answers the latest message)

- An open clarifying question no longer swallows the next message. A new
  question, a correction ("that's not what I asked") or the same question
  coming back closes it (`src/turn.js`).
- A question *about* something ("What are the steps to verify and report
  emissions?") reaches the model instead of the metric parser.
- Data answers and clarifying questions are part of the history the widget
  sends. Older turns are clipped as background, and a repeated reply is
  regenerated once. `test/context_test.js` is the benchmark;
  `KRIS_EVAL_LIVE=1` runs it against the real model.

### Upgrading to kris-9 (ready for many users)

- Deploy `server.js`, `src/ratelimit.js` (new), `src/httpHandler.js`,
  `src/router.js`, `src/agent.js`, `src/parser.js`, `src/instant_src.js`,
  `src/envcheck.js` and `public/kris-widget.js` (build `2026-09-24.kris-9`).
- **Database connections are held only while records are read.** A data
  question used to keep its connection until the whole reply was written,
  model time included, and the pool had 3 — so a fourth simultaneous data
  question waited 8 s and then failed. The connection now goes back to the
  pool the moment the lookup is done, and the pool size is
  `KRIS_PG_POOL_MAX` (default 10). With several instances, keep
  instances × pool within your database's limit (on Supabase, use the
  pooler URL).
- **A per-user message limit.** `KRIS_RATE_PER_MIN` (default 20) messages a
  minute per user; past it the reply is a 429 with `Retry-After` and a plain
  "give me N seconds" card. Prototype sign-in gives every visitor the same
  claims, so there visitors are told apart by address. The count lives in
  each process; with several instances it is per instance.
- **Less CPU per message.** The metric classifier runs once per distinct text
  (it used to run several times per message, once per history turn for the
  follow-up check), and date/time-zone formatters are built once. Measured on
  one process (mock model, 1 s to first token): 1,000 questions spread over
  10 s went from 25 s to first words to 1.1 s; 1,000 at the same instant from
  27 s to 10 s; 1,000 instant-lane answers from 2.5 s to 0.4 s.
- **Hosting.** Render's free plan sleeps after 15 minutes and has a small
  slice of CPU; for real users, run an always-on paid instance. The server
  keeps no per-user state (memory and history live in each browser), so it
  scales out by adding instances behind the load balancer.

### Upgrading to kris-8 (answers, not essays)

- Deploy `src/companion_src.js`, `src/agent.js`, `src/router.js`,
  `src/httpHandler.js` and `public/kris-widget.js` (build `2026-09-24.kris-8`).
- **Brief is the default.** "How do the EU ETS and FuelEU Maritime differ?"
  used to come back as a six-section essay. Answer length is now decided
  separately from reasoning depth (`answerDepth` in `src/companion_src.js`):
  - *short* — a quick fact: one or two sentences;
  - *brief* (default) — the direct answer in one or two sentences, then a
    visual that carries the detail (one compare card, one timeline), at most
    one short line around it, under about 70 words of prose, no headings;
  - *detailed* — only when the user asks for depth ("explain in detail",
    "walk me through", "deep dive", "tell me more", "write a…") or has set
    Answer length to Thorough.
  A comparison is now reasoned at medium effort; high effort is kept for
  requests for depth.
- **Reference figures.** Both prompts carry the figures the domain turns on —
  EU ETS scope and phase-in, FuelEU limits and the €2,400 per tonne
  VLSFO-equivalent penalty, CII reduction factors and the D/E rule, EEXI — so
  the model states them exactly instead of improvising (it had written the
  penalty as "per gram of shortfall per MJ").

### Upgrading to kris-7 (knowing the user, visual answers)

- Deploy together: `src/identity.js`, `src/guide.js`, `src/profile.js`,
  `src/stream.js`, `src/companion_src.js`, `src/agent.js`, `src/router.js`,
  `src/httpHandler.js` and `public/kris-widget.js`. Build stamps are
  `2026-09-24.kris-7`. No migration, no new environment variables.
- **"What do you know about me?" is answered from what K.R.1.S knows, never
  from the feature list.** It used to fail because the help-centre matcher
  took the single word "about" as a topic and answered with "What K.R.1.S can
  do". Now:
  - One classifier recognises questions about the user by their shape — a
    recall verb aimed at "me" ("what have you got on me", "anything you
    remember of me"), "who am I", or "my name / role / company…" asked as a
    question — with typos folded ("wat u kno abt me"). The widget and the
    server carry the same code, and `test/about_me_test.js` runs one corpus
    through both, plus near-misses that must not match ("what do you know
    about my vessel", "what is my fuel consumption").
  - The help centre ignores filler words and a leading "Kris," and needs two
    real matches in any sentence of six words or more.
  - With nothing known, the answer says so and asks for a name and a few
    basics, and a bare "Abhinav" is taken as the reply. With some details
    known, it lists exactly those and names what it doesn't know yet.
  - The model is always told what is known about the user — or, in so many
    words, that nothing is — and never to guess.
  - Details the user states are offered for memory by the widget's local
    detection and, in agent mode, by the model (`remember_user_details`).
    The server keeps a model-proposed detail only if it appears in the
    user's own message, and nothing is saved until the user says yes.
- **Visual answers.** The model can put a ```` ```visual ```` block holding
  one JSON spec anywhere in its answer: `stats` (key figures, with good /
  watch / risk status), `bar`, `line` (up to three series, crosshair
  tooltip), `breakdown` (part of a whole), `meter` (a value against a limit
  or a rating scale such as CII A–E), `compare` (options side by side),
  `steps`, `timeline`, and a `dashboard` of several. The prompt says when a
  visual earns its place and when it doesn't. The widget draws them in one
  design language — a validated categorical palette per theme, thin marks,
  status only with an icon and a word, arrival animation once (and not at
  all with reduced motion) — from strict, capped, text-only specs;
  anything malformed renders nothing. The server holds each block until it
  is complete, shows "Preparing a visual" meanwhile, and checks its numbers
  with the same invented-figure guard as prose. The agent's `show_chart`
  tool is gone: a visual no longer costs an extra model turn. Copying an
  answer gives the visual as words, not JSON.

### Upgrading to kris-6 (GLM-5.3-Flash, tools by default, chat polish)

- Deploy together: `src/companion_src.js`, `src/agent.js`, `src/router.js`,
  `src/httpHandler.js`, `src/stream.js`, `src/envcheck.js`, `server.js` and
  `public/kris-widget.js`. Build stamps are `2026-09-24.kris-6`.
- **The model is GLM-5.3-Flash** (`z-ai/glm-5.3-flash`) on OpenRouter, for
  both conversation and tool use. Set **`KRIS_LLM_API_KEY`** (an OpenRouter
  key) on the host; nothing else is required. Remove `KRIS_LLM_PROVIDER`,
  `KRIS_LLM_URL` and `KRIS_LLM_MODEL` if they point at the old model, and
  drop `KRIS_LLM_FAST_MODEL`, `KRIS_AGENT_MODEL` and `KRIS_LLM_REASONING`
  (no longer read). Pages still show the model as N.A.V 3.8b.
- **Agent mode is the default.** Anything the instant lane doesn't answer
  goes to the model with its tools (vessel records, fleet briefing, help
  centre, charts). `KRIS_MODE=router` brings back the old ladder.
- **Reasoning follows the question**: low effort for a quick fact, medium by
  default, high for "explain / compare / calculate / draft" or long messages.
  `KRIS_LLM_REASONING_EFFORT=low|medium|high` pins it. The reasoning is never
  shown: the server reads it only as a heartbeat and sends the widget a
  "Thinking" status.
- **Fewer limits**: 20 turns of history at up to 6,000 characters each,
  messages up to 8,000 characters, 8,192 output tokens (`KRIS_AGENT_MAX_TOKENS`
  up to 32,768), and the model's own recommended temperature. Answers may use
  headings, tables and code blocks. Timeouts are now *silence* timeouts
  (`KRIS_LLM_TIMEOUT_MS`, `KRIS_AGENT_TIMEOUT_MS`, widget `timeoutMs`): a long
  answer that keeps streaming is never cut off.
- **Widget**: finished blocks of a streamed answer are drawn once instead of
  every frame (long answers no longer stutter, and the DOM matches the final
  render exactly); no scrollbar in an empty composer; table cells no longer
  break words mid-word; clearer headings in answers; a calmer "still
  thinking" note after 20 s instead of 12 s.

### Upgrading to kris-5 (answer quality, Shuddha Now site)

- Deploy together: `src/instant_src.js`, `src/identity.js`,
  `src/companion_src.js`, `src/agent.js`, `src/httpHandler.js`,
  `src/router.js`, `public/kris-widget.js`, `public/index.html`,
  `public/site.webmanifest` and `public/assets/`. Build stamps are
  `2026-09-23.kris-5`. No migration, no new environment variables.
- **Number comparisons no longer depend on the model.** "Compare 2 and 10.
  Which one is bigger? Show me visually." used to fall through to the model
  because "visually" (and any typo — "whoch", "bisually", "oyu") was not in
  the comparison vocabulary; with the model unreachable it failed outright.
  It is now answered exactly in the fast lane (~1 ms) with a bar chart.
  Typos one slip from a comparison word are accepted; vessel words never
  are ("power" is not "lower"), so data questions still reach the parser.
  "Is 2 bigger than 10?" gets a yes or no; three or more numbers get a chart.
- **The model is shown as N.A.V 3.8b.** Pages and the widget show only
  `companion.label` from `GET /api/kris`; the real `KRIS_LLM_MODEL` stays in
  configuration and logs, and replies no longer carry a `model` field.
  "Which model are you?" is answered in the fast lane, and both conversation
  prompts say the same and never name another model or vendor. The label is
  `MODEL_LABEL` in `src/identity.js`.
- **Model reachability is reported.** `GET /api/kris` now carries
  `companion.reachable` and `companion.problem` (`LLM_UNREACHABLE`,
  `LLM_HTTP_404`, `LLM_MODEL_MISSING` when Ollama hasn't pulled the model…),
  from the warm-up probe and the last real message. The status page and
  About show "unreachable" instead of a green light.
- The companion's default model was `K.R.1.S` — not a real tag, so an unset
  `KRIS_LLM_MODEL` failed every message with a 404. It is now `llama3.1:8b`.
- Conversation prompt: answer first, read past typos, one sentence for a
  simple question, and a chart whenever the user asks to see something or
  compares three or more numbers. A `CHART:` line or one wrapped in a code
  fence (small models do both) is now parsed too.
- `GET /` is now a Shuddha Now site with the new logo (see "Run it").

### Upgrading to kris-4

- Deploy **every** changed server file together — `src/profile.js` (new),
  `src/identity.js`, `src/httpHandler.js`, `src/router.js`,
  `src/companion_src.js`, `src/agent.js` — plus `public/kris-widget.js`. The
  build stamps were all `2026-09-23.kris-4`; a mixed deploy is reported on
  error cards as "FILES OUT OF SYNC". `GET /api/kris` shows the build.
- No database migration and no new environment variables. The conversation
  layer still needs `KRIS_LLM_PROVIDER`, `KRIS_LLM_URL` and `KRIS_LLM_MODEL`
  (and `KRIS_LLM_API_KEY` for a hosted model) — see "Running the model".
- A model that can't be reached is now an error card that names the cause —
  `LLM_NOT_CONFIGURED`, `LLM_HTTP_401` (key), `LLM_HTTP_402` (credit),
  `LLM_HTTP_404` (model), `LLM_HTTP_429`, `LLM_TIMEOUT`, `LLM_UNREACHABLE` —
  instead of a chatty apology, and About shows "Conversation model: Not
  configured" when no model URL is set. Introductions, questions about the
  user, greetings and app questions are still answered without a model.
- A bare "what?" after an answer gets "Sorry — I didn't get that right…"
  instead of a model call.
- A first-person introduction ("I'm Alex and I work as a marine emissions
  analyst.") is now treated as conversation in both modes. Before, the word
  "emissions" made it a data request, so it got a database answer or a
  clarifying question about emissions. A request ("I'm checking shaft power
  for Aurora Trader") is still a data question.
- The router-mode companion now streams its answers sentence by sentence
  (before, only agent mode streamed), and a stop from the widget now cancels
  the model call.
- Behaviour change: a name the user mentions is used in that conversation at
  once but is only carried into the next one if they choose to remember it.

## Upgrading from a Captain deployment (earlier release)

This release renames every identifier, so an existing deployment needs four
one-time steps, in this order:

1. **Database** — an old database needed `db/005_rename_to_kris.sql` (in git
   history, removed in kris-11). The kris-11 database is new and is set up
   with `node db/setup.js`; see "Upgrading to kris-11".
2. **Environment** — every variable now starts with `KRIS_` (for example
   `KRIS_READ_URL`, `KRIS_LLM_API_KEY`, `KRIS_ALLOW_ORIGIN`). Rename them in
   your host's dashboard (Render → Environment) before deploying; `.env.example`
   lists them all. If a setting is missed, the server still starts but runs on
   defaults — no database, production sign-in — and every signed-in question
   gets a 401. It tells you which: the startup log and `GET /api/kris`
   (`renameNeeded`) list every setting still under the old prefix, the
   prototype page shows them in red, and the widget says "sign-in isn't set up
   on this server" with the list underneath, instead of "session expired".
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
remove. If replies feel slow, pin `KRIS_LLM_REASONING_EFFORT=low`.

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



The conversation layer runs GLM-5.3-Flash on OpenRouter (pay-per-token, one
key). Everything else is open-source — Postgres and the `pg` driver — and the
model can be swapped for one you host yourself with Ollama or any
OpenAI-compatible server. The only runtime dependency is the Postgres driver.

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
| `DATABASE_URL` | Supabase `postgres` connection, for `node db/setup.js` only; never on the server |
| `KRIS_READ_URL` | connection string for `kris_reader` (written by `db/setup.js`) |
| `KRIS_WRITE_URL` | connection string for `kris_writer`: sync, vocabulary, query log (written by `db/setup.js`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | the project URL and publishable key; not used by the server |
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
| `KRIS_LLM_API_KEY` | OpenRouter key for GLM-5.3-Flash (the only model setting you need) |
| `KRIS_PG_POOL_MAX` | read connections per server process (default 10) |
| `KRIS_RATE_PER_MIN` | messages per user per minute, per process (default 20, `0` = off) |
| `KRIS_MODE` | `agent` (default: model + tools) or `router` |
| `KRIS_LLM_REASONING_EFFORT` | pin `low` / `medium` / `high`; unset follows the question |
| `KRIS_LLM_PROVIDER`, `KRIS_LLM_URL`, `KRIS_LLM_MODEL` | only to self-host instead (`ollama` or `openai_compat`) |
| `KRIS_APP_NAME` | how K.R.1.S refers to your application (`Shuddha Now`) |

A token that has been pasted into a chat or ticket should be rotated. The one
you gave me is in `.env` now; `.gitignore` excludes it.

### 3. Create the database, then discover the field names

```bash
node db/setup.js            # schema, roles, test data, checks (needs DATABASE_URL)
npm run discover            # one call to each API
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
users the way Shuddha Now does.

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
reuse the Shuddha Now department gate, or `vesselIds` to pin a user to an
explicit list.

### 6. Run it

```bash
KRIS_READ_URL=... KRIS_WRITE_URL=... node server.js
```

That starts a plain HTTP server on `PORT` (default `8787`) serving:

- `GET /` — the Shuddha Now site, standing in for `perform.geoserves.com/pages/`
  until K.R.1.S moves there for real: hero, platform overview, a K.R.1.S
  section with try-it prompts and the department switcher (prototype
  sign-in), a live status readout (backend, database, model — shown as
  N.A.V 3.8b — and sign-in mode), the page-context demo and the embed
  snippet. It uses the new Shuddha Now logo (S-ring and needle mark) in Deep
  Pine, Jade, Sage and Mist, set in Manrope (served from `assets/fonts/`).
- `GET /assets/…`, `/favicon.ico`, `/site.webmanifest` — the logo (light and
  reverse), the mark (light and reverse), favicons, app icons, social preview
  image and fonts. The SVGs are vector artwork with the lettering converted
  to outlines, so they render the same on every machine with no font installed.
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
| `user` | `null` | `{ id, name, preferredName, role, company, department, location, timezone }` from your account record. `id` keeps each user's memory and history apart; the rest pre-fill the profile as "From your account" (the user can still change or remove them) |
| `memory` | `true` | `false` removes long-term memory entirely: no Profile or Memory, nothing kept, no profile sent |
| `memoryStore` | `null` | `{ load(): memory \| Promise, save(memory) }` — keep memory in your own backend instead of the browser |
| `onMemoryChange(memory)` | | called whenever what K.R.1.S remembers changes |
| `history`, `historyDays`, `historyMax` | `true`, `30`, `40` | past conversations on this device (`persist: false` also turns this off) |
| `settings` | `null` | defaults for the user's settings: `{ textSize: 's'\|'m'\|'l', density: 'comfortable'\|'compact', timestamps, motion: 'system'\|'reduce', character, sendWithEnter, followups, history }` |
| `hotkey` | `null` | e.g. `'mod+k'` to open and close from anywhere on the page (mod = Ctrl, or ⌘ on a Mac) |

**Methods:** `open()`, `close()`, `ask(text)`, `newChat()`, `setContext(ctx)`,
`clearContext()`, `setTheme('light'|'dark'|'auto')`,
`openView('history'|'profile'|'memory'|'appearance'|'settings'|'about'|'chat')`,
`memory.get() / set(key, value) / remove(key) / addNote(text) / clear() / enable(bool) / isEnabled()`,
`history.list() / open(id) / remove(id) / clear()`, `settings.get() / set(key, value) / reset()`,
`setUser(user)`, `forget()` (sign-out: removes this user's memory, history and
open chat from the browser), `on(event, fn)` / `off(event, fn)`, `destroy()`.

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

The model is **GLM-5.3-Flash** (`z-ai/glm-5.3-flash`) on OpenRouter. Set
`KRIS_LLM_API_KEY` and that is all: provider, URL and model default to it,
requests ask OpenRouter for the lowest-latency provider, and the reasoning
effort follows each question.

To self-host instead, override the transport:

| Server | `KRIS_LLM_PROVIDER` | Notes |
|---|---|---|
| vLLM, llama.cpp server, LM Studio, LocalAI | `openai_compat` | point `KRIS_LLM_URL` at the server; `/v1/chat/completions` is appended |
| [Ollama](https://ollama.com) | `ollama` | set `KRIS_LLM_URL` and `KRIS_LLM_MODEL`; agent mode uses Ollama's `/v1` endpoint |

Without a reachable model, K.R.1.S still works: data, guide and briefing are
unaffected, and open-ended chat gets an error card that names the cause
(`LLM_NOT_CONFIGURED`, `LLM_HTTP_401`…). Set `KRIS_ENABLE_LLM=0` to turn the
companion off outright.

The widget sends the last 20 turns of the current conversation with each
message so the companion has continuity — but only conversational replies are
included; a data lookup or a clarification is never added to that history,
because there is nothing about a fuel figure the companion should be recalling
in small talk later. What the user has chosen to have remembered travels
separately, as `context.profile` (see "A personal assistant underneath").

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

# no database: parser, fast lane, streaming, widget, memory, server
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
reactions. It needs no database. `test/widget_memory.js` covers the memory
layer the same way: detection and the consent card, "Not now", private
details refused, local memory commands, pausing, the Memory and Profile
sections, the drawer and Esc order, History (archive, search, reopen, delete
with Undo), appearance and settings, edit-and-resend, sending and failure
states, the `user` / `memoryStore` / `forget()` integration points, and XSS
through remembered values. `test/profile_test.js` covers the server side:
sanitising `context.profile`, the prompt block in both conversation layers,
that a profile cannot reach a data answer, introductions routed as
conversation, and router-mode streaming.

`test/db_test.js` needs no database server: it loads `db/001_schema.sql` and
the test data into PGlite (Postgres in WebAssembly) and runs the setup checks
and K.R.1.S's queries against it.

The older end-to-end suite in `test/run.js` still wants a real Postgres:

```bash
createdb kris_test
psql kris_test -f db/001_schema.sql
psql kris_test -f test/fixtures/example_schema.sql
KRIS_TEST_URL=postgres://localhost/kris_test node test/run.js
```

`test/fixtures/example_schema.sql` is a fixture, not a migration. Every number
in it is generated by a formula and is meaningless as vessel data.

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
