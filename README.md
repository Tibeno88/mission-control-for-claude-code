# Mission Control for Claude Code

**English** · [Français](./README.fr.md)

A **100% local** web dashboard for monitoring Claude Code sessions in near
real time, with a sci-fi HUD aesthetic. It reads the files Claude Code writes
to `~/.claude/`, aggregates tokens and costs, and keeps a long-term history
that is independent of transcript purging.

> Community project, not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

The server listens only on `127.0.0.1` and exposes **no authentication** — see [Security](#security).

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Startup & lifecycle](#startup--lifecycle)
- [Shell aliases](#shell-aliases)
- [Functional guide](#functional-guide)
- [Data sources](#data-sources)
- [Configuration](#configuration)
- [REST API & WebSocket](#rest-api--websocket)
- [Operations](#operations)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Tests & quality](#tests--quality)
- [Architecture](#architecture)
- [Distribution](#distribution)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites

| Prerequisite                 | Details                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Node.js ≥ 22.14**          | `node -v`. Tested in CI on Node 22.14 and 26.                                                                               |
| **Yarn 4**                   | Provided by corepack: `npm install -g corepack`, then `corepack enable`. Do not install dependencies with `npm` (Yarn PnP). |
| **Network**                  | Required for the first installation (downloading dependencies); the app works offline afterwards.                           |
| **C++ toolchain**            | Needed for `better-sqlite3` if no prebuilt binary exists for the platform: `sudo apt install build-essential python3`.      |
| **Claude Code**              | Installed and used at least once: without `~/.claude/projects/` or `~/.claude/sessions/`, the app starts but shows nothing. |
| **Plannotator** _(optional)_ | Recommended: adds visualization of active Plannotator UIs. See [Plannotator](#plannotator-optional).                        |

## Installation

### From the repository

```bash
git clone https://github.com/Tibeno88/mission-control-for-claude-code.git
cd mission-control-for-claude-code
npm install -g corepack   # Node ≥ 25 no longer bundles corepack
corepack enable
yarn install
```

### From a GitHub release

Each version is published on the [releases page](https://github.com/Tibeno88/mission-control-for-claude-code/releases) as a zip. It contains the sources, not the dependencies: installation is the same as from a clone, minus the `git clone` step.

```bash
unzip mission-control-for-claude-code-<version>.zip
cd mission-control-for-claude-code-<version>
npm install -g corepack   # Node ≥ 25 no longer bundles corepack
corepack enable
yarn install
yarn build
yarn start        # http://127.0.0.1:4517
```

Check the archive integrity first against the sha256 published with the release:

```bash
sha256sum mission-control-for-claude-code-<version>.zip
```

## Startup & lifecycle

### Development mode

```bash
yarn dev
```

This starts two processes in parallel (via `concurrently`):

- the **API** on `http://127.0.0.1:4517` (Hono server + WebSocket);
- **Vite** on `http://localhost:5173`, which proxies `/api` and `/ws` to the API.

In development, open the Vite URL (`:5173`) — it provides hot reloading of the UI.

### Local production mode

```bash
yarn build        # builds the UI (Vite), then the server (tsc)
yarn start        # serves both the API AND the built UI on http://127.0.0.1:4517
```

In production, the compiled UI (`web/dist`) is served directly by the server, with a SPA fallback to `index.html`. One URL, one process.

> ⚠️ **Yarn PnP**: always start the server with `yarn start` (or
> `yarn node server/dist/server.js`). A bare `node server/dist/server.js` fails
> with `ERR_MODULE_NOT_FOUND` because it does not load the PnP runtime.

### Stopping

Press `Ctrl+C` in the process, or run `cmc-stop` if you use the aliases. The
server catches `SIGINT`/`SIGTERM` and cleanly closes the watchers, the WebSocket
and the SQLite database.

## Shell aliases

The repository ships a ready-to-use script, `scripts/cmc-aliases.sh`, compatible
with bash and zsh. It locates itself automatically (including through a symbolic
link), can be sourced several times without side effects, and `cmc-help` lists
everything it exposes.

There are two ways to install it, your choice:

```bash
# 1) direct source — in ~/.zshrc, ~/.bashrc or your alias file
source /path/to/mission-control-for-claude-code/scripts/cmc-aliases.sh

# 2) symbolic link — loaded automatically by oh-my-zsh
#    (oh-my-zsh sources every *.zsh file in custom/, hence the extension of the link)
ln -s /path/to/mission-control-for-claude-code/scripts/cmc-aliases.sh \
      "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/cmc-aliases.zsh"
```

The second option is preferable if you keep the repository up to date: the
aliases follow the code automatically.

| Alias         | Effect                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| `cmc-start`   | Starts API + UI (dev mode) in the background, log written to `logs/app.log` |
| `cmc-stop`    | Stops all processes of the workspace                                        |
| `cmc-restart` | `cmc-stop` then `cmc-start`                                                 |
| `cmc-status`  | API health, fleet counters, today's cost                                    |
| `cmc-logs`    | `tail -f` of the application log                                            |
| `cmc-open`    | Opens the UI: Vite (`:5173`) if it responds, otherwise `:4517`              |
| `cmc-build`   | `yarn build`                                                                |
| `cmc-test`    | `yarn test`                                                                 |
| `cmc-backup`  | Manual one-shot backup / archiving                                          |
| `cmc-package` | Produces the distributable zip in `dist-pkg/`                               |
| `cmc-update`  | `git pull` (if it is a git repository), then install + build                |
| `cmc-cd`      | Changes into the project folder                                             |
| `cmc-help`    | Shows this list                                                             |

Recognized variables: `CMC_DIR` (root, inferred automatically), `CMC_LOG_DIR`
(default `$CMC_DIR/logs`), `CMC_URL` / `CMC_PORT` for the **API** (default
`http://127.0.0.1:4517`), `CMC_DEV_URL` / `CMC_DEV_PORT` for the **Vite UI** in
development mode (default `http://localhost:5173`).

## Functional guide

The UI has four tabs, **LIVE**, **TASKS**, **DASHBOARD** and **CONFIG**, which you
switch between from the header.

### Header (common)

- **`RUN` / `WAIT` / `IDLE` counters**: number of sessions per status. The
  `WAIT` counter switches to an alert state as soon as a session is waiting for input.
- **Plannotator indicator**: number of active Plannotator UIs (hover for the list and links).
- **Clock** and **uplink**: `UPLINK ONLINE` when the WebSocket is connected,
  `UPLINK LOST` otherwise (the UI tries to reconnect).
- **Notification bell**: state of the browser permission (`granted` / `denied` /
  `default`); hidden if the browser does not support notifications.

### Tab LIVE

**Fleet grid** (`FleetGrid` / `SessionCard`) — one card per session:

- **status**: `busy` (running), `waiting` (waiting for input, with the reason
  `waitingFor`), `idle`, `ended`, `missing` (the live registry has disappeared
  while the transcript still exists);
- project, `cwd`, **git branch**, models used, number of prompts, tokens,
  estimated cost;
- **sub-agent badge**: number of sub-agents (`Task`/`Agent`) launched in the
  session, and the share of the cost attributable to them;
- **remove button** on `missing` sessions: removes the card from the grid, **in
  server memory only** — no file is deleted on disk, and a server restart makes
  it reappear;
- clicking a card opens the detail panel.

**Detail panel** (`SessionDetail`):

- recent activity feed (prompts, responses, tool calls, results, system messages);
- **per sub-agent** breakdown: assigned agent type, extract of the task prompt,
  models, tokens, cost, first and last activity;
- Plannotator UIs attached to the session, with a direct link.

**Notifications**: when a session moves to `waiting`, the UI sends a browser
notification (titled "Session en attente" (session waiting), body = wait reason)
and shows a `[n WAITING]` badge in the tab title. Permission is requested on the
first transition, not on page load. If it was denied, the bell is crossed out:
you must unblock notifications for this site in the browser settings.

### Tab TASKS

A Kanban board of **headless** Claude Code sessions (`claude -p`), launched in
the background by the server. Columns: `TODO`, `IN PROGRESS`, `WAITING`, `DONE`,
plus an `ARCHIVED` state that is hidden by default (an "afficher archivées" (show
archived) checkbox and a `RESTORE` button).

- Form: title, prompt, working directory (an existing absolute path), optional
  model, permission mode (`manual`, `acceptEdits`, `plan`; `bypassPermissions` is
  deliberately refused).
- `START` runs `claude -p --output-format json … -- <prompt>`. When the process
  ends, the tile moves to `WAITING` with the last response. You reply in the tile
  (`Ctrl+Enter`): the server runs `claude --resume <session_id>` with that
  message. `MARK DONE` closes the task.
- Denied tools (`permission_denials` in the JSON output) are listed in the tile.
  `AUTORISER + RELANCER` (grant + restart) adds them to `allowedTools` (`PATCH`),
  then sends "continue" (`--resume` with the updated list). Scope: this task only.
- Process error or unreadable output: the tile stays in `WAITING` with the error
  displayed (`RELANCER` (restart) if no session has been created yet). When the
  server restarts, `IN PROGRESS` tasks (lost process) move to `WAITING` with the
  error "interrompue par redémarrage du serveur" (interrupted by server restart).
- Tasks are persisted in the SQLite `tasks` table. The `claude` binary is resolved
  via `PATH`.
- Security: these routes execute `claude`. The local `Host`/`Origin` rule applies
  to the whole API and to the WebSocket; mutations additionally require
  `Content-Type: application/json`. Inputs are validated (cwd, mode, model, sizes, id).

### Tab DASHBOARD

Panel titles are shown in French in the UI (e.g. `01 CORE · COÛT` = core cost).
The dashboard has two sections. **Real time** (`MetricsBar`), computed from the
transcripts being scanned:

| Panel                          | Content                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `01 CORE · COÛT`               | Gauge of today's cost relative to the 7-day daily average (deviation in %), 7-day cost, sessions |
| `02 FLUX TOKENS · AUJOURD'HUI` | Today's I/O tokens, split into IN / OUT / CACHE READ / CACHE WRITE, cache hit rate               |
| `03 TÉLÉMÉTRIE · COÛT / HEURE` | Hourly bars over 24 h, peak and current hour; hover = cost and token detail for that hour        |
| `04 MODÈLES · SCAN`            | Cost per model over the scan window, output tokens, share of total                               |
| `05 PROJETS · SCAN`            | Top 5 projects by cost over the scan window, sessions, share of total                            |

**Archived history** (`HistoryPanels`), computed from the backup snapshots: a
period selector (`AUJOURD'HUI` (today), `7 JOURS` (7 days), `30 JOURS` (30 days),
`TOUT` (all)) and an account filter, which drive panels 06 to 09.

| Panel                  | Content                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `06 TOTAUX · PÉRIODE`  | Total cost, sessions, I/O tokens and the IN / OUT / CACHE split, cache hit rate                                                                                                                 |
| `07 COÛT / JOUR`       | Daily bars (days without activity shown at 0); hover = cost and tokens for the day                                                                                                              |
| `08 PAR COMPTE`        | Cost per account (dot in the account's color), sessions, share of total                                                                                                                         |
| `09 PROJETS · PÉRIODE` | Top 6 projects by cost, sessions, share of total                                                                                                                                                |
| `10 COÛT / REQUÊTE`    | Requests, average cost and average output tokens per model; its own granularity `JOUR` / `SEMAINE` / `MOIS` (day / week / month) (30 d / 12 wk / 12 months), independent of the period selector |

### Tab CONFIG

Configuration only — no consumption metrics (see DASHBOARD).

- **Backup run**: an immediate trigger button, with live tracking
  (`running` / `done` / `error`) pushed over the WebSocket.
- **Accounts**: create/delete accounts (label, email, organization, color).
- **Project → account mapping**: **manual** assignment of each `project_slug` to
  an account; there is no automatic assignment. This mapping feeds the per-account
  cost breakdown.
- **Scheduler configuration**: enable/disable, cron expression, retention in days.
  Persisted in the database and applied without a restart.
- **Archive browser** per project (all archived projects): path, raw size → gzip,
  sha256, archive date. Downloading the `.jsonl.gz` from the UI is not available yet.

## Data sources

| Source                                 | Usage                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `~/.claude/sessions/<pid>.json`        | Live registry of sessions (status `busy`/`waiting`/`idle`, PID, cwd)                       |
| `~/.claude/projects/<slug>/*.jsonl`    | Transcripts: token usage per turn, model, activity                                         |
| `<slug>/<sessionId>/subagents/*.jsonl` | Sub-agent transcripts (`Task`), aggregated per session                                     |
| `~/.plannotator/sessions/<pid>.json`   | Registry of active Plannotator UIs (optional)                                              |
| `$CMC_DATA_DIR/cmc.db`                 | Local SQLite database: runs, session snapshots, archives, accounts, config                 |
| `$CMC_DATA_DIR/archives/`              | Archived transcripts (gzip, deduplicated by sha256)                                        |

Transcripts are read as an **incremental tail** (offsets kept in memory): after
the initial scan, a file is never fully re-parsed. Directories are watched with
`chokidar`, with a fallback poll every 3 s to detect stale registries (killed
processes). A missing or unreadable directory is logged as a warning and does
not stop the server.

Model pricing is embedded (source [LiteLLM](https://github.com/BerriAI/litellm))
and refreshed at startup if the network is available; otherwise the embedded
table is used.

### Plannotator (optional)

Plannotator provides a UI for annotating plans and reviewing code. If it is
installed, Mission Control shows the active UIs: a counter in the header, a
panel, and a direct link on the card of the relevant session. A UI is attached
to a Claude session only when the link is **certain** (PID lineage); otherwise
the UI is still counted but not attached. An `in_progress` task whose `claude`
process owns a Plannotator UI shows a "PLANNOTATOR" link (derived field
`plannotatorUrl` from the WS snapshot, never persisted).

Without Plannotator, everything works normally: the counter stays at zero and
`/api/plannotator` returns an empty list. If its data directory is not
`~/.plannotator`, declare it with `CMC_PLANNOTATOR_DIR` (or with Plannotator's own
`PLANNOTATOR_DATA_DIR` variable, which is recognized as a fallback).

#### Avoiding session cutoff

A `plannotator annotate` launched by Claude's Bash tool moves to the background
after 120 s. The harness kills it at 10 min ("background time limit"). The
assistant often ends its turn without waiting, so the annotation is never read.

**Option D: plan hook (recommended).** The hook does not go through Bash, so the
10-minute cap does not apply. A hook's `timeout` field is in **seconds** (default
600 for `command`). The matcher filters on the tool name; `ExitPlanMode` is a
valid tool name. Example (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "plannotator", "timeout": 345600 }]
      }
    ]
  }
}
```

Not verified against the Claude Code docs: that `PermissionRequest` fires for
`ExitPlanMode` (otherwise use `PreToolUse`, which lists it explicitly), and the
exact Plannotator hook command (see its documentation). Check with `/hooks` or
`claude --debug`.

**Option E: detached launch + active wait.** For `/plannotator-annotate`:

```bash
setsid nohup plannotator annotate plan.md > /tmp/pn.out 2>&1 &
```

Then wait for the output with `Monitor` (or an `until grep` loop). The turn must
not end before the result. Keep the commands simple (no `;` or `&&`) and
pre-allow `Bash(plannotator:*)` and `Bash(setsid:*)`. `Monitor` expires after at
most 30 min (tool cap): restart it on each expiry. This cap comes from the tool
description, not from the hooks documentation.

### SQLite schema

`$CMC_DATA_DIR/cmc.db` can be opened by an external tool (DB Browser for SQLite,
DuckDB, a Python script…) for recalculations or statistics the UI does not
cover. One row per table:

| Table                 | Granularity / key                                                                                          | Role                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_events`      | 1 row = 1 LLM request. Unique `(session_id, agent_id, dedupe_key)`                                         | **Fact table.** Tokens, cache, cost _and_ the rates applied at call time, per request. Basis of all per-period averages. **Not linked to `backup_runs`**: it survives a purge of runs/archives, by construction. `account_id` is frozen at write time (a later project→account remapping does not rewrite history). |
| `request_rollups`     | 1 row = month × model × project (`project_slug` NULL = all projects). Key `(bucket, model, project_slug)` | Compaction of a period purged from `request_events`: `requests` is kept as the denominator, so averages stay exact after compaction. Empty as long as purging is disabled (current setting: infinite retention).                                                                                                              |
| `purge_watermark`     | 1 fixed row (`id = 1`)                                                                                     | Marks the date before which `request_events` may be incomplete (compacted into `request_rollups`). Absent = no purge has happened yet, `request_events` is complete.                                                                                                                                                              |
| `session_snapshots`   | 1 row per backup run × session                                                                             | Cumulative snapshot of a session at the time of a run. Serves the per-session / project / account views of the CONFIG tab. `rate_*` / `pricing_source` are filled only when the session used a single model (otherwise `pricing_source = "mixed"` and the rate is NULL — no average rate is fabricated).                       |
| `archives`            | 1 row per archived `.jsonl` file, unique per `sha256`                                                      | Index of the gzipped transcripts (`archives/`): original path, archive path, sizes, date. Deduplicates by content.                                                                                                                                                                                                               |
| `backup_runs`         | 1 row per backup run (manual or scheduled)                                                                 | Execution log: volume, duration, error if any.                                                                                                                                                                                                                                                                                    |
| `accounts`            | 1 row per declared account                                                                                 | Claude accounts entered manually (label, email, organization, color).                                                                                                                                                                                                                                                             |
| `project_account_map` | 1 row per mapped project, key `project_slug`                                                               | Project → account assignment, entered by hand in the CONFIG tab.                                                                                                                                                                                                                                                                  |
| `backup_config`       | Key/value                                                                                                  | Backup configuration: enabled, cron, retention (days, `0` = infinite), directory.                                                                                                                                                                                                                                                 |

**Ready-to-use query** — average cost and average output tokens per request, per
model, over the last 30 days (same result as what `/api/metrics/periods` serves):

```sql
SELECT
  strftime('%Y-%m-%d', ts, 'localtime') AS jour,
  model,
  COUNT(*)                              AS requetes,
  SUM(cost_usd) / COUNT(*)              AS cout_moyen_usd,
  SUM(output_tokens) / COUNT(*)         AS tokens_out_moyen
FROM request_events
WHERE ts >= datetime('now', '-30 days')
GROUP BY jour, model
ORDER BY jour, model;
```

For a purged period (before `purge_watermark.purged_before`), the same average is
recalculated at month granularity from `request_rollups`:
`SUM(cost_usd) / SUM(requests)` and `SUM(output_tokens) / SUM(requests)`.

## Configuration

Everything is configured through environment variables, passed to the server.

| Variable              | Default                     | Description                                                                              |
| --------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `CMC_PORT`            | `4517`                      | Server port (always bound to `127.0.0.1`). Positive integer required.                    |
| `CMC_CLAUDE_DIR`      | `~/.claude`                 | Root of the Claude Code data (`projects/` and `sessions/` derive from it).               |
| `CMC_SCAN_DAYS`       | `7`                         | Transcript scan window, in days. Positive integer required.                              |
| `CMC_DATA_DIR`        | `~/.claude-mission-control` | CMC data directory (`cmc.db` + `archives/`).                                             |
| `CMC_PLANNOTATOR_DIR` | `~/.plannotator`            | Plannotator data directory. Falls back to `PLANNOTATOR_DATA_DIR`. `~` is handled.        |

A non-integer or negative value for `CMC_PORT` / `CMC_SCAN_DAYS` makes startup
fail with an explicit message, rather than silently falling back to the default.

Example:

```bash
CMC_PORT=4600 CMC_SCAN_DAYS=30 CMC_DATA_DIR=~/backups/cmc yarn start
```

**Non-configurable constants** (in `server/src/config.ts`), useful for
interpreting UI latency:

| Constant              | Value     | Role                                              |
| --------------------- | --------- | ------------------------------------------------- |
| `registryPollMs`      | 3,000 ms  | Fallback poll of the session registries           |
| `broadcastDebounceMs` | 500 ms    | Batching of WebSocket broadcasts                  |
| WS heartbeat          | 10,000 ms | Refreshes the relative counters on the client     |

**Settings persisted in the database** (`backup_config` table, editable from the
CONFIG tab): `enabled` (default `false`), `cron` (default `0 * * * *`, i.e. every
hour), `retentionDays` (default `0` = infinite retention), `backupDir`.

## REST API & WebSocket

All routes are served on `http://127.0.0.1:$CMC_PORT`.

All `/api/*` routes (GET and mutations) and the `/ws` WebSocket require a local
`Host` (`127.0.0.1` or `localhost`, any port). If an `Origin` is present, it must
be local and identical to the `Host`. Otherwise: `403` with
`{ "error": "forbidden host" }` or `{ "error": "forbidden origin" }` (handshake
refused for `/ws`). Clients without an `Origin` (curl, `cmc-*` aliases) work as
long as they target `127.0.0.1` or `localhost`.

### Live monitoring

| Method | Route                        | Response                                                                 |
| ------ | ---------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/api/health`                | `{ ok: true }`                                                           |
| `GET`  | `/api/snapshot`              | Fleet + metrics + Plannotator in one call (what the WS pushes)           |
| `GET`  | `/api/fleet`                 | Sessions only                                                            |
| `GET`  | `/api/metrics`               | Global metrics (day, 7 days, per project, per model, timeline)           |
| `GET`  | `/api/sessions/:id/activity` | Recent activity. `?limit=` between 1 and 300 (default 80)                |
| `POST` | `/api/sessions/:id/dismiss`  | Removes a non-live session from the grid. `409` if it is live            |
| `GET`  | `/api/plannotator`           | Active Plannotator UIs, with session attribution                         |

Session IDs are validated (`[0-9a-fA-F-]{8,64}`); an invalid value returns `400`.

### Backup & history

| Method   | Route                  | Role                                                                                                                                                                 |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/backup/run`      | Triggers a manual run                                                                                                                                                |
| `GET`    | `/api/backup/runs`     | List of runs                                                                                                                                                         |
| `GET`    | `/api/backup/history`  | Aggregated history (`?period=today\|7d\|30d\|all`)                                                                                                                    |
| `GET`    | `/api/metrics/periods` | Average cost and average output tokens per request, per model (`?bucket=day\|week\|month&from=&to=&model=&project=`) — **estimated** cost, see [SQLite schema](#sqlite-schema) |
| `GET`    | `/api/backup/config`   | Scheduler configuration                                                                                                                                              |
| `PUT`    | `/api/backup/config`   | Updates enable / cron / retention                                                                                                                                    |
| `GET`    | `/api/accounts`        | List of accounts                                                                                                                                                     |
| `POST`   | `/api/accounts`        | Creates an account                                                                                                                                                   |
| `DELETE` | `/api/accounts/:id`    | Deletes an account                                                                                                                                                   |
| `GET`    | `/api/project-map`     | Project → account mapping                                                                                                                                            |
| `PUT`    | `/api/project-map`     | Updates the mapping                                                                                                                                                  |
| `GET`    | `/api/archives`        | Archive metadata                                                                                                                                                     |

### Tasks (Kanban)

| Method  | Route                    | Role                                                                                                                                                                                  |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/tasks`             | List of tasks                                                                                                                                                                         |
| `POST`  | `/api/tasks`             | Creates a `todo` task (`title`, `prompt`, `cwd`, `model?`, `permissionMode`, `allowedTools?`: list for `--allowedTools`; absent = all)                                               |
| `POST`  | `/api/tasks/:id/start`   | Starts the task. `409` if it is already running or already started                                                                                                                    |
| `POST`  | `/api/tasks/:id/reply`   | `{ message }`: resumes the session. `409` if the task is not `waiting`                                                                                                                |
| `PATCH` | `/api/tasks/:id`         | `title`, `prompt`, `allowedTools` (same validation as at creation), `status` ∈ `todo` (restore), `done`, `archived`                                                                   |

Mutations: in addition to the general `Host`/`Origin` rule above,
`Content-Type: application/json` is required (`415` otherwise).

### WebSocket

Single channel on `/ws`. The server sends a full snapshot on connection, then one
after each change (500 ms debounce) and every 10 s:

| Message         | Content                                                         |
| --------------- | --------------------------------------------------------------- |
| `snapshot`      | `{ fleet, metrics, plannotator, tasks, generatedAt }`           |
| `backup_status` | `{ status: running\|done\|error, run?, message?, generatedAt }` |

## Operations

### Manual backup

From the UI (button in the CONFIG tab) or from the command line, without starting
the HTTP server:

```bash
yarn backup
```

The command loads the configuration, opens `cmc.db`, scans the transcripts of the
`CMC_SCAN_DAYS` window, performs a `manual` run and prints a summary (run id,
sessions, archived files, raw size → gzip, duration, error if any).
**Exit code: `0` on success, `1` if the run has an error or the command fails** —
usable from an external cron.

### Scheduled backup

Internal scheduler based on `node-cron`, which can be enabled from the CONFIG tab
(cron expression + retention). The configuration is persisted in the database and
reloaded at startup.

### Retention

`retentionDays = 0` means **infinite retention** (no purge). Beyond that, archives
older than the threshold are deleted (database rows + `.gz` files), then orphaned
`session_snapshots` and `backup_runs` are purged. File deletions are confined to
`backupDir`: a path outside it is never touched.

### Deduplication

Content that is already archived (same sha256) is never archived again. The
uniqueness constraint is carried by the `archives.sha256` column.

### Inspecting the database

```bash
sqlite3 ~/.claude-mission-control/cmc.db '.tables'
sqlite3 ~/.claude-mission-control/cmc.db \
  'SELECT id, mode, sessions_count, files_archived, error FROM backup_runs ORDER BY id DESC LIMIT 5;'
```

Tables: `backup_runs`, `session_snapshots`, `archives`, `accounts`,
`project_account_map`, `backup_config`. The database uses WAL mode.

### Logs

The server writes to standard output. With `cmc-start`, everything is redirected
to `logs/app.log` (use `cmc-logs` to follow it). Otherwise, redirect the process
output yourself.

## Security

- The server is bound to `127.0.0.1` and has **no authentication**. Do not expose
  it on a network or put it behind a reachable reverse proxy: anyone who reaches
  the port can read all your transcripts.
- The data read (prompts, responses, project paths) may be confidential.
  `CMC_DATA_DIR` (database + archives) stays strictly local and is never included
  in a distribution zip.
- URLs provided by Plannotator are filtered: only the `http:` and `https:` schemes
  are rendered on the client side.
- The app is **read-only** on `~/.claude/`: it never writes to Claude Code's data.
  Removing a session from the grid is an in-memory state, not a deletion.
- All `/api/*` routes and `/ws` reject a non-local `Host` or `Origin`. This blocks
  DNS rebinding (a web page reading the API through a rebound domain) and
  cross-site WebSocket hijacking (a page open in the same browser reading the live
  snapshot, since WebSockets bypass CORS). This is not authentication: still never
  expose the port.
- Reporting a vulnerability: see [SECURITY.md](./SECURITY.md) (private report, never a public issue).

## Troubleshooting

| Symptom                                   | Probable cause                                                               | Check / fix                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ERR_MODULE_NOT_FOUND` at startup         | `node` launched without the Yarn PnP runtime                                 | Use `yarn start` (or `yarn node server/dist/server.js`)                              |
| `yarn: command not found`                 | Corepack not enabled                                                         | `npm install -g corepack`, then `corepack enable`, then `yarn -v` (must print `4.x`) |
| `EADDRINUSE` on 4517                      | An instance is already running, or the port is taken                         | `cmc-status`, `ss -tlnp \| grep 4517`, or change `CMC_PORT`                          |
| `UPLINK LOST` in the header               | Server stopped, or UI open on the wrong port                                 | In dev, open `:5173` (not `:4517`); check `cmc-status`                               |
| No session displayed                      | Wrong `CMC_CLAUDE_DIR`, or scan window too short                             | `ls ~/.claude/projects`; increase `CMC_SCAN_DAYS`                                    |
| No notifications                          | Permission denied for the site                                               | Crossed-out bell = `denied`: unblock it in the browser settings                      |
| `better-sqlite3` install fails            | No prebuilt binary for the platform                                          | `sudo apt install build-essential python3`, then `yarn install`                      |
| Plannotator counter always at zero        | Plannotator absent, or non-standard data directory                           | Optional by nature; otherwise set `CMC_PLANNOTATOR_DIR`                              |
| Costs look wrong                          | Pricing table not refreshed (offline at startup)                             | Logs show `[pricing] refreshed N claude models`; otherwise the local table is used   |
| `403 forbidden host` / `forbidden origin` | Access via a host name other than `127.0.0.1`/`localhost` (alias, IP, proxy) | Open `http://127.0.0.1:4517` (or `:5173` in dev)                                     |

## Tests & quality

```bash
yarn test         # vitest: JSONL parsing, pricing, aggregation, backup, plannotator
yarn typecheck    # tsc --noEmit on both workspaces
```

## Architecture

```
server/                       Node + TypeScript + Hono
  src/
    server.ts                 REST API, WebSocket, static file serving
    config.ts                 loading of environment variables
    sessions.ts               live registry (~/.claude/sessions)
    transcripts.ts            incremental tail of transcripts + sub-agents
    metrics.ts                fleet aggregation and global metrics
    pricing.ts                pricing table (embedded + LiteLLM refresh)
    plannotator.ts            Plannotator UI registry + PID attribution
    proc.ts                   /proc reading, PID lineage
    local-guard.ts            local Host/Origin guard (REST API + WebSocket)
    tasks/                    TASKS tab: API, claude -p runner, persistence
    backup/                   db, service, scheduler, archiving, retention, CLI, API
  test/                       vitest

web/                          React 19 + Vite
  src/
    App.tsx                   composition of the LIVE / DASHBOARD / CONFIG views
    components/               Header, MetricsBar, HistoryPanels, HudPanel, CostBars,
                              FleetGrid, SessionCard, SessionDetail,
                              PlannotatorPanel, backup/ (CONFIG view)
    lib/                      useSnapshot (WS), useBackup, useNotifications, format
    styles/                   tokens, global, hud, metrics, backup

scripts/
  package.sh                  builds the distributable zip
  cmc-aliases.sh              cmc-* shell aliases
```

## Distribution

Each published version is attached to a [GitHub release](https://github.com/Tibeno88/mission-control-for-claude-code/releases) with its sha256 checksum. To build the zip locally:

```bash
yarn package                        # dist-pkg/mission-control-for-claude-code-<version>.zip
bash scripts/package.sh --worktree  # also includes uncommitted changes
```

The zip is built from git: nothing untracked or ignored can end up in it. The
script also strips the internal content (`BACKLOG.md`, `docs/`, `.claude/`,
`.github/`, `package-lock.json`, any `*.local.*`), generates an `INSTALL.md`, then
**checks the actual contents of the archive** and deletes it if a forbidden
pattern appears. Finally, it prints the size and the sha256 to send along with
the file.

Contents: the `server/` and `web/` sources, manifests, `yarn.lock`, Yarn PnP
artifacts, `scripts/`, `README.md`, `README.fr.md`, `LICENSE`, `SECURITY.md`,
`CONTRIBUTING.md`, `INSTALL.md`. No dependencies, no build, no data.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md). Planned work and bugs are tracked in [GitHub issues](https://github.com/Tibeno88/mission-control-for-claude-code/issues).

## License

[MIT](./LICENSE). The embedded pricing table comes from [LiteLLM](https://github.com/BerriAI/litellm) (MIT license).
