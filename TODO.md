# TODO

## Comparison with walodayeet/hindsight-pi

Compared against `@walodayeet/hindsight-pi` 0.4.x. Their behavior changes; pin a
version if this comparison is used for a decision.

### Ours

- Recall: `before_agent_start`, first successful recall per session (re-armed by
  compaction/resume), `recall_timeout` (default 10s) per bank. A missing bank is
  retried on later runs when no other bank answers; failed recalls get up to 3
  attempts across runs.
- Retain: `agent_settled` (messages stashed on `agent_end`), async by default
  with `Promise.allSettled`.
- Retain payload: last user prompt + assistant messages + non-operational
  `tool_use` names/inputs; no tool results or earlier user turns; capped at 50k
  chars. Written with `document_id` + `update_mode: append`.
- Tools: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`.
- Commands: `/hindsight [status|stats|settings|doctor|prune]`.
- Config: flat `key = value` lines in `~/.hindsight/config` (no sections and no
  inline comments).
- Banks: optional global bank + one project bank per directory (namespaced when
  `bank_namespace` is set); or one session bank per session with
  `bank_scope = session`.
- Per-prompt: `#nomem`/`#skip` at the start; `#global`/`#me`; custom `#tags`;
  trivial-prompt skip; project-level `recall_enabled`/`retain_enabled`.

### Theirs (walodayeet/hindsight-pi)

- Recall modes: `hybrid`, `context`, `tools`, `off`.
- Recall types: `observation`, `experience`, `world`; configurable per-type
  count (`recallPerType`), plus `recallTags`/scopes.
- Display: `grouped` or `unified`; injection frequency `every-turn` (default)
  or `first-turn` (continue-style prompts).
- Retain modes: `response`, `step-batch`, `both`, `off`.
- Write frequencies: `turn`, `async`, `session`, or numeric batch.
- Bank strategies: `per-directory`, `git-branch`, `pi-session`, `per-repo`,
  `global`, `manual`; recommends one bank + tags/scopes.
- Config: JSON (`.json`, also reads `.toml`) with global + project hierarchy.
- Commands: 22 registered in their extension code; 13 are documented in their
  README (setup, status, doctor, where, profile, tag, remove-tag,
  toggle-retain, popup, flush, parse-session, parse-and-upsert-session,
  prune-recall-messages). The rest include config, connect, stats, mode, sync,
  map, settings, inspect-last-recall, and upsert-historical-sessions.
- Tools: `hindsight_search`, `hindsight_context`, `hindsight_retain`,
  `hindsight_bank_profile`.
- Per-prompt: `#nomem`/`#skip` anywhere; `#global`/`#me`; `/hindsight:tag`;
  automatic `source:`/`workspace:`/`bank:`/`kind:`/`origin:` tags.
- Retain writes: credential sanitization, queued `retainBatch`, one 1.5s retry.

### They do better

- **`recallMode: tools`** — skips auto-injection entirely; recall only via
  explicit tool call. Fixes cold-start latency.
- **Fresh recall per prompt** — `every-turn` injection, at the cost of
  repeating context; `first-turn` is the cache-friendly alternative.
- **Retain batching** — `session` and N-turn batches reduce server load; a
  flush queue covers shutdown/switch/fork.
- **Credential sanitization** — strips API keys/tokens/secrets before retain.
- **Config inspection and setup** — `/hindsight:where` shows which file won;
  `/hindsight:setup` is a wizard; `/hindsight:doctor` is a preflight check.
- **`hindsight_bank_profile`** — inspect bank identity/metadata.
- **Persisted recall inspection** — `/hindsight:popup` and
  `/hindsight:prune-recall-messages`.

### We do better

- **Single-file, zero-dependency client** — raw `fetch`, one `index.ts`, no SDK
  dependency.
- **Per-machine project banks** — `bank_namespace` prevents the same project
  name on two machines from sharing a bank when it is set (this fork).
- **Per-project opt-out** — `recall_enabled`/`retain_enabled` in
  `.hindsight/config` or `/hindsight settings`.
- **Custom tag extraction** — `#tags` in the prompt are attached to the memory
  item; they have an explicit `/hindsight:tag` command instead.
- **Richer retain payload** — tool names and inputs for non-operational tools,
  not just a user+assistant summary; `document_id` + append keeps session
  continuity.
- **`hindsight_reflect`** — server-side synthesis from the current bank.
- **Performance docs** — benchmarks, latency analysis, Supabase index guide.

### Shared, not differentiators

- `#nomem`/`#skip` opt-out and `#global`/`#me` routing: both support them.
- Trivial-prompt skip: both.
- Project-level config overrides: both.
- Auto-recall / auto-retain / chat indicators / manual tools: both.
