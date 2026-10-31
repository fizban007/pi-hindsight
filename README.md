# pi-hindsight

*Memory that compounds, not clutters.*

Persistent memory for Pi, backed by a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Install it, point it at your server, and memory works automatically from the first session.

**Best fit for:**
- Self-hosted Hindsight users who want full data control
- Long-lived repo work where context carries across sessions, including cross-project memory via a shared global bank
- Users who want per-prompt memory controls (`#nomem`, `#global`, `#tags`)
- Anyone who prefers a minimal, single-file extension with zero extra dependencies

## Requirements

Node.js 22 or later is required.

This extension is a thin client. It does not bundle or manage Hindsight — you run the server (or point at Hindsight Cloud) yourself.

Hindsight needs three things beyond itself:

- **An LLM** for fact extraction and reflect. Without one, Hindsight can still run in chunk-only mode (`HINDSIGHT_API_LLM_PROVIDER=none`): retain stores chunks and recall still works, but no facts or observations are extracted and reflect returns HTTP 400.
- **An embedding model** — local by default, or one of the supported remote providers.
- **Postgres with pgvector** (or Oracle AI Database for enterprise), unless you use an embedded or managed deployment. Hindsight ships a bundled single-node Postgres (`pg0`) for local use, so "self-hosted server" does not strictly mean a separate database — but this extension assumes a reachable HTTP endpoint either way.

Supported deployments: Docker, pip/bare metal, Helm, the Python/Node embedded server, or Hindsight Cloud. See the [Hindsight quick start](https://hindsight.vectorize.io/developer/api/quickstart) for the current options, then come back here.

## Install

```bash
pi install git:github.com/fizban007/pi-hindsight
```

That is this fork. `pi install npm:pi-hindsight` and `pi install git:github.com/anh-chu/pi-hindsight` install upstream, which does **not** have the per-machine project banks, session scope, or `bank_namespace` described here.

## Quick start

1. **Install** the extension (see above).

2. **Configure** your Hindsight server in `~/.hindsight/config`:
   ```toml
   api_url = "http://your-hindsight-server:8888"
   api_key = "<API_KEY>"
   bank_namespace = "<machine-name>"
   global_bank = "optional-global-bank-id"
   ```

   `bank_namespace` is not optional if several machines share the server; see [FORK.md](FORK.md).

3. **Verify** in Pi:
   ```
   /hindsight status
   ```

That's it. Memory is automatic from here: recall on the first run of a session (and again after compaction or resume), retain when a run settles.

## Features

### Automatic memory lifecycle

- **Auto-recall:** On the first run of a session, relevant memories from your project or session bank and the configured global bank are injected into the prompt. Later runs skip recall (the `recallDone` flag) until the session is compacted or resumed, so the injected block is not repeated or re-paid for. A bank that does not exist yet is treated as empty rather than a failure; when no configured bank answers, recall is retried on later runs.
- **Auto-retain:** When the run settles (`agent_settled`), the run's last user prompt and assistant messages (including non-operational tool calls) are appended to a per-session memory document via `document_id` + `update_mode: append`. Tool results and earlier user turns are not included, and the payload is capped at 50,000 characters. Hindsight reprocesses only the new delta, so the session is not re-extracted each turn.
- **Feedback loop prevention:** Memory blocks are stripped from retained content. No recursive memory bloat.
- **Noise filtering:** Operational tool calls are dropped from the retained transcript — `bash`, `nu`, `process`, `read`, `write`, `edit`, `grep`, `ast_grep_search`, `ast_grep_replace`, `lsp_navigation`. Conversation and all other tool usage are kept.

### Per-prompt controls

- `#nomem` or `#skip`: skip retain for this turn (sensitive or throwaway prompts).
- `#global` or `#me`: also retain this turn to your global bank (cross-project learnings).
- `#architecture`, `#bug`, etc.: custom tags extracted and attached to memory for filtering.

### Project-level opt-out

Disable memory for specific projects by setting `recall_enabled` and `retain_enabled` to `false` in a project-level `.hindsight/config`:

```toml
recall_enabled = false
retain_enabled = false
```

Or use the interactive `/hindsight settings` command.

Manual tools (`hindsight_recall`, `hindsight_retain`, `hindsight_reflect`) remain available regardless.

### Session isolation (`bank_scope = session`)

By default (`bank_scope = project`) every session in a directory shares one bank, so concurrent sessions read each other's turns. Set `bank_scope = session` for true isolation: each Pi session gets its own bank, and recall can only ever see that session's own memory.

```toml
bank_scope = "session"
```

Session banks are named `sess-<namespace>-<project>-<session-tail>`, for example `sess-alexchenhplaptop-pi-de30d68730cd`. The namespace is your hostname unless you set `bank_namespace`, which is what keeps two machines that share one Hindsight server from deriving the same bank id for the same session. Resuming a session keeps its id, so its bank and memory survive restarts; forking gets a new id and a new bank. The bank is created by the first retain. If it is the only bank, a missing-bank recall is retried on later runs; if a global bank answers instead, that global recall completes the session's auto-recall, so use `hindsight_recall` for the session bank until the next resume or compaction.

With session scope:

- Retain writes only to the session bank. `#global`/`#me` still publishes to the global bank.
- Recall reads the session bank, plus `global_bank` if you configured one — that bank is shared on purpose. Leave `global_bank` unset for complete isolation.
- `homedir_project` no longer applies: home is just another project slug.
- Session banks are ephemeral. `/hindsight prune` deletes ones that have been idle for a while.

Use `hindsight_recall` with its `bank` argument to read another bank deliberately (a project bank, a sibling session, the global bank).

### Home directory handling

When Pi runs from your home directory, the global config (`~/.hindsight/config`) and local config (`.hindsight/config` in CWD) are the same file. This means a `project-home` (or `project-<namespace>-home`) bank is created alongside your global bank, so home gets its own project memory in addition to the global bank. Retain still writes only the project bank unless the prompt is tagged `#global`/`#me`.

To fix this, set `homedir_project = false` in your global config:

```toml
homedir_project = false
```

With this set, recall from the home directory uses only the global bank, and automatic retain is skipped entirely unless the prompt contains `#global` or `#me`. `hindsight_retain` writes to `global_bank` when one is configured. All other project directories are unaffected.

### In-chat visibility

| Event | What you see |
|-------|-------------|
| Recall | 🧠 Hindsight recalled N memories + snippet |
| Retain (success) | `Memorized: X/Y` status badge; `retain_feedback = "message"` or `"both"` also shows 💾 Hindsight saved turn to memory → bank-name |
| Retain (failure) | 💾 Hindsight retain failed, use hindsight_retain to save manually (suppressed by `retain_feedback = "none"`) |

### Manual tools

- `hindsight_recall`: Pull additional context from memory on demand. Pass `bank` to search one specific bank instead of the banks recall reads by default (the project or session bank, plus a configured global bank).
- `hindsight_retain`: Force-save a specific insight.
- `hindsight_reflect`: Ask Hindsight to synthesize an answer from the current project or session bank (server-side reasoning). It does not read the global bank.

## Configuration

### Global config: `~/.hindsight/config`

```toml
api_url          = "http://localhost:8888"
api_key          = "your-api-key"
bank_namespace   = "machine-name"
global_bank      = "sil"
recall_types     = "observation"
recall_budget    = "mid"
recall_max_tokens = 800
async_retain     = true
```

### Project override: `.hindsight/config`

Place a `.hindsight/config` file in the directory you run Pi from to override global settings. Local values win. The global config must still exist: the extension only reads project overrides after it has loaded `~/.hindsight/config`.

```toml
recall_types     = "observation,experience"
recall_budget    = "low"
recall_max_tokens = 512
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `recall_types` | `observation` | Memory types to search: `observation`, `world`, `experience`. Comma-separated. Each type runs the full retrieval pipeline independently. |
| `recall_budget` | `mid` | Retrieval depth: `low`, `mid`, `high`. Higher = more coverage but added latency. |
| `recall_max_tokens` | Server default (4096) | Max tokens for injected memories. Lower values reduce context noise. Recommended: `800`. |
| `recall_timeout` | `10000` | Per-request timeout in milliseconds, also used by `hindsight_reflect`. A bank that misses it is treated as empty for that run rather than blocking indefinitely; 429 backoff retries can extend the wait. Lower it when the server is remote and slow. |
| `async_retain` | `true` | Fire-and-forget retain. Set `false` to wait for the server to accept the write before the run settles. Hindsight still processes the retain asynchronously either way; extraction failures are not reported by this extension. |
| `retain_feedback` | `status` | How retain results are reported: `status` (badge only), `message` (chat message only), `both`, or `none` (suppresses both success and failure messages). |
| `project_bank_id` | _(none)_ | Pins one flat bank for every project on this machine (project scope). Overrides the `project-<slug>` derivation. In session scope it becomes the session-bank root (`sess-<project_bank_id>-<tail>`). Prefer `bank_namespace` unless you really want all projects sharing one vault. |
| `recall_enabled` | `true` | Enable automatic recall before agent turns. Set `false` to disable auto-recall for this project. Manual `hindsight_recall` tool still works. |
| `retain_enabled` | `true` | Enable automatic retain after agent turns. Set `false` to disable auto-retain for this project. Manual `hindsight_retain` tool still works. |
| `homedir_project` | `true` | Treat home directory as a project. Set `false` to prevent creating a `project-home` bank when running Pi from your home directory. Recall then uses only `global_bank`, and automatic retain is skipped unless the prompt contains `#global`/`#me`. Ignored when `bank_scope = session`. |
| `bank_scope` | `project` | `project` shares one bank per directory. `session` gives every Pi session its own bank, so concurrent sessions never read each other's memory. |
| `bank_namespace` | hostname for session banks; unset for project banks | Machine identity embedded in bank ids. Set it explicitly to get `project-<namespace>-<slug>` project banks. With no value, project banks keep the legacy `project-<slug>` name and machines sharing a server can collide. Set it to an empty string to omit the namespace from session banks too (only safe if one machine uses the server). |
| `session_bank_ttl_days` | `30` | Default age for `/hindsight prune` when no day count is given. |
| `global_bank` | _(none)_ | Bank ID for cross-project memory. When set, it is queried on the first successful recall of a session (and by manual `hindsight_recall`), alongside the project or session bank. Turns tagged `#global` or `#me` are also retained here. `hindsight_reflect` does not read it. Leave unset if you only want per-project memory. |

### Environment variable overrides

Banks can also be steered from the environment, using the same variables omp reads (env beats config). This lets launchers and wrappers pick a memory bank per agent without writing config files.

| Variable | Effect |
|----------|--------|
| `HINDSIGHT_BANK_ID` | Replaces the bank root. With `bank_scope = session` it is the root that session banks are derived from (`sess-<root>-<tail>`); with `bank_scope = project` it is the exact bank. Also overrides any `project_bank_id` config key. |
| `HINDSIGHT_BANK_SCOPE` | `session` or `project` — overrides `bank_scope`. |
| `HINDSIGHT_BANK_NAMESPACE` | Overrides `bank_namespace`. |
| `HINDSIGHT_SCOPING=global` | Additionally replaces `global_bank` with `HINDSIGHT_BANK_ID`, collapsing recall + retain into one flat bank per agent (same semantics as omp's `global` scoping). Also pins the exact bank, disabling session scope. |
| `HINDSIGHT_SCOPING=per-project` / `per-project-tagged` | Pins project scoping; the configured `global_bank` stays in the recall mix. pi-hindsight has no tag-scoped scoping, so omp's per-project-tagged behavior (same bank with project tags) is approximated, not replicated. |
| `HINDSIGHT_RETAIN_EVERY_N_TURNS` | Ignored — omp-only. Retention runs at `agent_settled` on every settled turn. |

Precedence: environment > project config > global config > `project-<slug>` default. Without `HINDSIGHT_BANK_ID` the environment still applies `HINDSIGHT_BANK_SCOPE` / `HINDSIGHT_BANK_NAMESPACE`; other config-driven setups are unaffected. `HINDSIGHT_DEBUG=1` turns on debug logging (see below).

An explicit `HINDSIGHT_BANK_ID` is also active in the home directory, even when `homedir_project` is `false`.

## Commands

### `/hindsight status`
Full health check: server reachability, auth, bank access, hook state, debug log tail.

```
URL:    http://localhost:8888
Server: ✓ online
Scope:  session (session 01a18aa6-cf2c-71a6-8b67-de30d68730cd)
Bank:   sess-alexchenhplaptop-pi-de30d68730cd
  ✓ auth ok
Global: global-bank
Project: project-alexchenhplaptop-pi (used only with bank_scope = project)

Hooks this session:
  session_start:      ✓ ok
  recall:             ✓ ok (3 memories)
  retain:             ✓ ok (sess-alexchenhplaptop-pi-de30d68730cd)

Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)
```

### `/hindsight stats`
Memory, link, document, observation, and operation counts for all active banks.

### `/hindsight doctor`
Checks your config files for legacy key names, and offers to rename them in place. Values are preserved; only the key names change. Run it after upgrading from an older version, since a renamed key that is silently ignored looks identical to a feature that does not work.

### `/hindsight prune [days] [--yes]`
Lists session banks (matching this config's namespace) that have been idle for more than `days` (default `session_bank_ttl_days`, 30), and deletes them only with `--yes`. It never touches the global bank, the project bank, or the current session's bank, and it refuses to run when session banks cannot be identified safely. Idleness comes from the bank list's last-write/last-document timestamps; on a Hindsight version that omits them, the extension falls back to the bank creation time.

### `/hindsight settings`
Interactive settings menu. View all current settings with their source (global, project, or default), toggle boolean settings, edit text values, and choose where to save (project or global config). When running from the home directory, saves go to global config only.

Use this to opt out a project from memory:
```
/hindsight settings
→ Auto-Recall: true [default]  →  toggle Off  →  save to Project
→ Auto-Retain: true [default]  →  toggle Off  →  save to Project
```

Or to disable home directory as a project:
```
/hindsight settings
→ Home Dir as Project: true [default]  →  toggle Off
```

## Banks

### Project bank

Named `project-<slug>`, where the slug is the current directory's basename, lowercased, reduced to `[a-z0-9-]`, and truncated to 32 characters (`/home/alex/.pi` → `pi`; the home directory itself → `home`). The bank is created on the first retained turn, not by recall. All turns are retained here by default, so each project builds its own isolated memory over time — but two different directories with the same basename on one machine share a bank, while a repository's worktrees and subdirectories get separate banks.

When `bank_namespace` is set explicitly, the name becomes `project-<namespace>-<slug>` so machines sharing a server do not collide. With `bank_scope = session`, the project bank is not written to; it is only readable via `hindsight_recall`'s `bank` argument.

### Session bank

With `bank_scope = session`, each session owns `sess-<namespace>-<project>-<session-tail>`. Nothing else writes there, and recall never leaves it (except for a configured `global_bank`). The bank is created on the first retained turn. Use `/hindsight prune` to clean up old ones — a long-lived setup accumulates one bank per session.

### Global bank

Optional. Set `global_bank = <bank-id>` in your config to enable it. The global bank is meant for knowledge that applies across projects: preferred patterns, personal conventions, people and teams you work with, recurring tools.

On the first successful recall of a session, both banks are queried in parallel and their results are merged into a single injection. You get project-specific context and cross-project context together, with no duplicated queries. `hindsight_reflect` reads only the project or session bank.

Turns are retained to the global bank only when you explicitly tag the prompt with `#global` or `#me`. Everything else goes to the project bank only, keeping global memory intentional.

## Debug logging

Set `HINDSIGHT_DEBUG=1` to enable verbose logging to `~/.hindsight/debug.log`. Log tail is shown inline in `/hindsight status`.

## Performance

Recall latency depends primarily on your database indexes and hosting tier. With HNSW indexes on Supabase free tier, the benchmark setup used ~4s for a parallel global + project bank recall; that measurement used a remote Gemini embedding model, so local embeddings remove the embedding-API portion of the wait.

For benchmarks, latency analysis, recommended settings, and a Supabase index checklist, see **[docs/performance.md](docs/performance.md)**.

## What Hindsight stores (and what it does not)

Worth knowing before you rely on it, because the mental model is not "a log of your chats":

- **Retain does not store the conversation as a conversation.** Hindsight splits the content into **chunks**, keeps those chunks (the original text is preserved and retrievable via `include_chunks` or a document fetch), and normally uses an LLM to extract typed **facts** — world facts and experiences — with entities, times, and links. A server in chunk-only mode skips the fact extraction and keeps just the searchable chunks.
- **Facts are consolidated in the background.** A worker deduplicates related facts into **observations**, each carrying supporting quotes and a proof count. Observations are *refined* rather than overwritten when new evidence arrives, and their history is kept.
- **Observations roll up further.** **Mental models** are standing answers to a question you define once, rewritten as the bank learns. **Knowledge pages** are the same idea as living documents organized in folders.
- **What is not modelled:** tool calls, file paths, subagent trees, and workflows have no schema of their own. They survive only as prose inside a chunk that some fact was extracted from. If you need "which files did this touch", this is the wrong tool — an index over raw transcripts is.

In the default extraction modes, retain costs tokens and latency per write, and what you get back is an interpretation of the transcript rather than the transcript. That is the trade: retrieval quality over verbatim audit.

## Why Hindsight over other memory approaches

| Approach | Typical tradeoff | Hindsight + this extension |
|---|---|---|
| Markdown/file-based memory | Human-readable, but nothing consolidates or deduplicates it | Facts consolidate into observations automatically; chunks keep the original text recoverable |
| Custom vector DB (ChromaDB, etc.) | Flexible, but requires ongoing tuning, and similarity alone misses keyword and time questions | Multi-strategy recall (semantic + BM25 + graph + temporal), fused by rank and cross-encoder reranked |
| Raw transcript index (grep/SQL over session logs) | Exact and cheap to build, but no semantic recall and nothing is ever inferred | Semantic recall plus consolidated beliefs, at the cost of per-retain LLM work |

On the first successful recall of a session, your project or session bank and your global bank (if configured) are queried in parallel. Project memories cover the current codebase; global memories carry patterns and preferences you've built across all your projects.

Recall runs four searches in parallel — semantic, BM25 keyword, graph (entity/temporal/causal links), and temporal range filtering — merges them by reciprocal rank so no single arm's scoring scale dominates, re-ranks the merged set with a cross-encoder, then trims to your token budget. Recency is handled by the temporal arm and by freshness checks during consolidation, not by a blanket "newer wins" rule.

## Comparison with [@walodayeet/hindsight-pi](https://github.com/walodayeet/hindsight-pi)

Two Hindsight extensions for Pi are compared here. Both connect to a Hindsight server and provide auto-recall and auto-retain. They share the same core goal but differ in philosophy: this extension optimizes for simplicity and per-prompt control, while `@walodayeet/hindsight-pi` optimizes for configurability and operational tooling.

This compares the current fork with `@walodayeet/hindsight-pi` 0.4.x. This section aims to help you pick the right one. Both are good.

### At a glance

| Dimension | **pi-hindsight** (this fork) | **@walodayeet/hindsight-pi** |
|---|---|---|
| Install | `pi install git:github.com/fizban007/pi-hindsight` | `pi install npm:@walodayeet/hindsight-pi` |
| Backend required | Hindsight server + LLM (or chunk-only mode) + embedding model + Postgres/pgvector (or pg0/Oracle) | Same |
| Extra dependencies | None (raw `fetch`) | `@vectorize-io/hindsight-client` SDK |
| Config format | Flat `key = value` lines (no sections or inline comments) | JSON (`~/.hindsight/config.json`), also reads TOML |
| Codebase | Single file, about 1,700 lines | Multi-file, about 3,500 lines in `extensions/` |

### Recall

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `before_agent_start`; first successful recall per session | `before_agent_start` and `context` hook; fresh recall per prompt |
| Injection frequency | Implicit: once per session, re-armed by compaction/resume | Explicit: `every-turn` (default) or `first-turn` for continue-style prompts |
| Recall modes | Auto-inject + manual tools; auto-recall can be disabled per project | `hybrid`, `context`, `tools`, or `off` |
| Banks | Project or session bank, plus `global_bank` when configured | Primary bank + optional `globalBankId`, tags/scopes, linked hosts |
| Recall types / budget | `recall_types` (default `observation`), `recall_budget`, `recall_max_tokens` | `recallTypes` + `recallPerType`, `searchBudget`, `contextTokens` |
| Retry on failure | Up to 3 failed attempts across runs; a missing bank is retried when no other bank answers | No recall retry |

**What the differences mean:**

- **Recall modes.** `@walodayeet/hindsight-pi` lets you set `recallMode: tools` to skip auto-injection entirely. This extension always auto-injects unless you set `recall_enabled = false` for the project; manual `hindsight_recall` remains available either way.
- **Bank model.** This extension uses one bank per project (or per session), plus an optional global bank. `@walodayeet/hindsight-pi` recommends one bank with tags and observation scopes, and supports multiple banks for hard boundaries. Both can query cross-project memory, but the configuration model differs.
- **Injection frequency.** This extension recalls once per session (again after compaction or resume). `@walodayeet/hindsight-pi` defaults to fresh recall on every prompt; its `first-turn` setting mainly affects continue-style follow-ups. The behavior is not identical.
- **Retry logic.** This extension retries a failed recall across runs. `@walodayeet/hindsight-pi` does not retry recall, but retries retain writes once after 1.5 seconds.

### Retain

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `agent_settled`, async by default | `message_end` queue with `retainBatch`, flushed at `agent_end` and session lifecycle events |
| Write scheduling | Immediate after each settled run; async fire-and-forget or await server acceptance | `turn`, `async`, `session`, or N-turn batch |
| Retain modes | One mode: append to a per-session document | `response`, `step-batch`, `both`, or `off` |
| Content retained | Last user prompt + assistant messages + non-operational tool calls (names and inputs); no tool results | User + assistant turn summary |
| Document strategy | Append mode with a stable `document_id` per session | Stable session documents with append |
| Credential sanitization | No | Yes (strips API keys, tokens, secrets) |
| Session lifecycle | State resets on `session_start`/`session_compact`; no pending write queue | Flushes on shutdown, switch, compact, and fork |

**What the differences mean:**

- **Write scheduling.** `@walodayeet/hindsight-pi` can batch all writes until session end or flush every N turns, reducing server load. This extension writes immediately after each settled run and has no session/N-turn batching or flush queue. If Pi exits mid-write, that write can be lost.
- **Retain content.** This extension includes tool names and inputs for non-operational tools, but not tool results or earlier user turns. `@walodayeet/hindsight-pi` retains a user+assistant text summary, which is lighter but loses tool-use context.
- **Append mode.** Both use stable document ids. This extension uses `document_id` + `update_mode: append`, so Hindsight reprocesses only the new delta.
- **Credential sanitization.** `@walodayeet/hindsight-pi` strips API keys, bearer tokens, and secrets before sending content. This extension does not, so secrets in conversation may end up in your Hindsight memory. If you work with credentials in chat, this matters.
- **Session lifecycle.** This extension has no queued writes to flush; it resets its state when the session starts or compacts.

### Per-prompt controls

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Opt-out | `#nomem`/`#skip` at the start of a prompt; `recall_enabled`/`retain_enabled` per project | `#nomem`/`#skip` anywhere in a prompt |
| Global bank routing | `#global` or `#me` per prompt | `#global` or `#me` per prompt |
| Custom tags | `#hashtags` in the prompt attached to memory | `/hindsight:tag` plus automatic `source:`, `workspace:`, `bank:`, `kind:`, and `origin:` tags |
| Trivial prompt skip | Yes | Yes |
| Meta-memory query filtering | No | Yes |

**What the differences mean:**

- **Opt-out.** Both extensions support per-prompt opt-out. This extension requires the tag at the start of the prompt and also offers project-level `recall_enabled`/`retain_enabled`.
- **Global bank routing.** Both support per-prompt `#global`/`#me`; this is not a differentiator.
- **Custom tags.** This extension extracts user-defined `#hashtags` from prompts. `@walodayeet/hindsight-pi` uses an explicit `/hindsight:tag` command and automatic metadata tags instead.
- **Trivial prompt skip.** Both skip short/trivial prompts. `@walodayeet/hindsight-pi` also has a dedicated meta-memory filter, which this extension does not.

### Tooling and setup

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Config format | Flat `key = value` lines (`~/.hindsight/config`) | JSON (`~/.hindsight/config.json`), also reads TOML |
| Config inspection | `/hindsight settings` shows values with their source (global, project, default) | `/hindsight:where` and `/hindsight:config` |
| Setup experience | Manual: edit config, run `/hindsight status` | Interactive `/hindsight:setup` wizard |
| Diagnostics | `/hindsight status` (health + hooks + log tail), `/hindsight doctor` (legacy-key migration) | `/hindsight:doctor` (preflight), `/hindsight:status` (runtime), `/hindsight:where` |
| Manual tools | `hindsight_recall`, `hindsight_retain`, `hindsight_reflect` | `hindsight_search`, `hindsight_context`, `hindsight_retain`, `hindsight_bank_profile` |
| Commands | 5 subcommands (`status`, `stats`, `settings`, `doctor`, `prune`) | 20+ (`setup`, `status`, `doctor`, `where`, `profile`, `flush`, `popup`, `tag`, ...) |
| Performance docs | Benchmarks, latency analysis, Supabase index guide | Not included |

**What the differences mean:**

- **Setup.** `@walodayeet/hindsight-pi` has an interactive setup wizard. This extension requires manually editing a config file. If you are comfortable with config files, this is fine.
- **Diagnostics.** Both have status commands. This extension shows hook state and debug log tail inline in `/hindsight status`, lists effective values with their source in `/hindsight settings`, and offers `/hindsight doctor` to find and rename legacy config keys. `@walodayeet/hindsight-pi` adds `/hindsight:where` to show exactly which config file contributed each value, which this extension does not do.
- **Tools.** This extension includes `hindsight_reflect` for server-side memory synthesis. `@walodayeet/hindsight-pi` includes `hindsight_context` (also backed by reflect) and `hindsight_bank_profile` for inspecting bank metadata.
- **Performance documentation.** This extension includes latency benchmarks, analysis of what causes slow recall, and a Supabase index checklist.

### Backend requirements

Both extensions require the same backend:

- A reachable [Hindsight](https://github.com/vectorize-io/hindsight) server — self-hosted or Hindsight Cloud
- An **LLM** for fact extraction and reflect (or chunk-only mode for retain/recall without one)
- An **embedding model** — local by default, or Gemini/OpenAI/Cohere/TEI; the benchmark used Gemini `gemini-embedding-001`
- Postgres with pgvector, Oracle AI Database, or the embedded `pg0` deployment
- Usable recall indexes: HNSW is the default; DiskANN and vchord are alternatives

Neither extension bundles or manages the backend. You deploy Hindsight separately and point the extension at it via config.

This extension uses raw `fetch` calls against the Hindsight REST API, with no SDK dependency. `@walodayeet/hindsight-pi` uses the official `@vectorize-io/hindsight-client` SDK, which adds a dependency but tracks API changes automatically.

### When to choose this extension

- You want a single-file, low-overhead setup with minimal config.
- You want per-machine project banks via `bank_namespace` (this fork).
- Per-project opt-out matters: disable memory via config or `/hindsight settings`.
- Per-prompt memory controls matter: `#nomem` to skip, `#global` to route, `#tags` to annotate.
- You prefer append-mode document retention with tool-call context over turn summaries.
- You want `hindsight_reflect` for server-side memory synthesis.
- You want documented performance benchmarks and Supabase index guidance.
- You prefer zero extra dependencies beyond Pi itself.

### When to choose @walodayeet/hindsight-pi

- You want granular recall control: `tools`-only mode eliminates auto-injection.
- Flexible retain scheduling matters: `session`, `async`, or N-turn batching.
- You want a setup wizard, config-source inspection, and richer diagnostics.
- Credential sanitization in retained content is important to you.
- You prefer JSON config with a richer settings hierarchy.
- You want the official Hindsight client SDK for automatic API compatibility.
- You prefer a one-bank-plus-tags model, persisted-recall inspection, and session tags.

### Shared strengths

Both extensions:

- Auto-recall relevant memories before agent runs
- Auto-retain conversation after agent runs
- Query a global bank plus a project/session bank when configured
- Show visible recall/retain indicators in chat
- Provide manual tools for explicit memory operations
- Skip trivial prompts to reduce noise
- Support project-level config overrides
- Work with any self-hosted Hindsight server

## Running tests

```bash
npm test                      # lifecycle + bank resolution
npx vitest run                # mission setup and mission hook
npm run test:mission          # mission setup only
```
