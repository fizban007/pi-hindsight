---
name: hindsight-docs
description: Hindsight architecture, APIs, configuration, and best practices, from a 0.5.2 documentation snapshot. Use this to learn Hindsight or answer questions about it.
---

# Hindsight Documentation Skill

Hindsight is an agent memory system. It takes content in, extracts typed facts from it with an LLM, consolidates those facts into beliefs over time, and answers queries over them. It is not a transcript index and not a vector store of raw text.

> **Version note:** `references/` is a snapshot of the upstream docs at **Hindsight 0.5.2**. A live server may be newer (1.x), where endpoints and features have changed. Some claims below come from newer releases; those are flagged where the difference matters. When this skill disagrees with the server or <https://hindsight.vectorize.io>, the server/site wins.

## When to Use This Skill

Use this skill when you need to:
- Understand Hindsight architecture and core concepts
- Learn about retain/recall/reflect operations
- Configure memory banks — missions, directives, disposition, templates
- Set up the Hindsight API server (Docker, Kubernetes, pip, embedded, Cloud)
- Integrate via Python/Node.js/Go SDKs, CLI, MCP, or plain HTTP
- Understand retrieval strategies (semantic, BM25, graph, temporal)
- Debug or optimize retain/recall latency
- Review API endpoints, parameters, and operation tracking

## Documentation Layout

All documentation is in `references/`. This is the actual tree — do not guess paths:

```
references/
├── best-practices.md        # START HERE — missions, tags, formats, anti-patterns
├── faq.md                   # Decisions and common questions
├── openapi.json             # Full OpenAPI spec — endpoint schemas, request/response models
├── developer/
│   ├── api/                 # main-methods, retain, recall, reflect, memory-banks,
│   │                        # mental-models, documents, operations, bank-templates,
│   │                        # webhooks, quickstart
│   ├── retain.md            # What extraction actually does
│   ├── retrieval.md         # The four retrieval arms and fusion
│   ├── reflect.md           # The agentic loop
│   ├── observations.md      # Background consolidation
│   ├── configuration.md     # Every HINDSIGHT_API_* variable, bank config API
│   ├── storage.md           # PostgreSQL/pgvector layout (index backends in configuration.md)
│   ├── models.md            # Supported LLM providers and models
│   ├── installation.md      # Docker, pip, Helm, embedded, air-gapped
│   ├── mcp-server.md        # Per-bank MCP endpoint
│   ├── performance.md       # Latency and tuning
│   ├── rag-vs-hindsight.md  # Conceptual comparison
│   └── monitoring.md, development.md, extensions.md, services.md,
│       multilingual.md, admin-cli.md, index.md
├── sdks/
│   ├── python.md, nodejs.md, go.md, cli.md
│   ├── embed.md               # Daemon / embedded server CLI
│   └── hindsight-all.md, hindsight-all-npm.md   # Embedded, no separate server
└── changelog/
    ├── index.md
    └── integrations/          # ag2, ai-sdk, autogen, chat, claude-code, codex,
                               # crewai, langgraph, litellm, llamaindex, openclaw,
                               # opencode, pydantic-ai, strands, ...
```

There is no `cookbook/` directory and no `sdks/integrations/` directory in this bundle. Integration notes live under `changelog/integrations/`.

## Start Here: Best Practices

Read the best practices guide before any API doc. It covers missions, tags, content formats, observation scopes, and anti-patterns — the fastest path to a correct integration.

```
references/best-practices.md
```

## Core Model

### The three operations

- **retain** — push content in. In the default extraction modes, an LLM extracts facts, temporal data, entities, and relationships, then normalizes them into canonical entities, time series, and search indexes. `chunks` mode skips the LLM and stores searchable chunks only.
- **recall** — retrieve matching memories. Runs four searches in parallel, fuses them, reranks, and trims to a token budget.
- **reflect** — reason over the bank and return an answer, not a result set. An agentic loop with its own tools, up to ten rounds, citing only memories it actually retrieved.

### What retain produces

This is the part most often misread, so state it precisely:

- Content is split into **chunks**. The chunks are **kept**, and the original text stays retrievable — pass `include_chunks` on recall, or fetch the document and read `original_text`.
- The LLM emits **facts**: *world facts* (claims it was told) and *experiences* (things the bank did).
- Facts are linked to the entities they mention and to other facts sharing them. That is what makes "where does Alice work?" answerable from facts never stored together.
- The conversation itself is **not** stored as a conversation. There is no message table, no turn order, no tool-call schema. Tool calls and file paths survive only as prose inside a chunk.

So: original text is recoverable at chunk/document granularity; conversation *structure* is not modelled.

### Memory types

- **World fact** — objective claim. "Alice works at Google."
- **Experience** — something the bank itself did. "I recommended Python to Bob."
- **Observation** — a belief consolidated in the background from many facts. Deduplicated, grounded in supporting quotes with a proof count, and *refined* rather than overwritten as evidence accumulates.
- **Mental model** — a standing answer to a question you define once, rewritten as the bank learns. Reading one is a plain database read: no retrieval, no LLM call.
- **Knowledge page** — mental models with the mechanics hidden; living documents in a folder tree, optionally projectable to disk as markdown. *(Newer than 0.5.2; not in the reference bundle.)*

### Banks

A bank is an isolated memory store — one brain per user, agent, or project. No cross-bank leakage. Banks carry:

- `retain_mission` — what extraction should pay attention to.
- `observations_mission` — what consolidation should treat as worth keeping.
- `reflect_mission`, `directives`, and **disposition** (skepticism, literalism, empathy, 1–5).

Disposition, `reflect_mission`, and directives shape **reflect only**. `retain_mission` steers extraction and `observations_mission` steers consolidation. `recall` returns the same memories regardless of who asks.

### Retrieval

`recall()` runs four arms in parallel:

- **Semantic** — vector similarity.
- **Keyword** — BM25 exact matching, several pluggable Postgres backends.
- **Graph** — entity, temporal, and causal links.
- **Temporal** — time expressions parsed into a window, then filled across the range rather than clustered at one end.

Results are fused **by rank** (reciprocal rank fusion), so no arm's scoring scale dominates; the fused set is reranked by a cross-encoder that reads query and memory together; then it is cut to a **token budget**, not a top-k. There is no blanket "newer ranks higher" rule — recency comes from the temporal arm and from freshness checks in consolidation.

## Using the Docs

Search for concepts by pattern:

```bash
pattern: "disposition"        # Bank personality configuration
pattern: "HINDSIGHT_API_"     # Environment variables
pattern: "document_id"        # Document identity, append vs replace
pattern: "update_mode"        # append / replace semantics on retain
pattern: "bank_templates"     # Declarative bank creation
```

Read whole files with the read tool, e.g.:

```
references/developer/api/retain.md
references/developer/api/documents.md
references/developer/retrieval.md
references/developer/observations.md
references/sdks/python.md
```

## Assumptions to Avoid

Check these before answering questions about Hindsight:

- **"It only stores extracted facts, so the original is gone."** Wrong. Chunks retain the original text, and `original_text` is fetchable per document.
- **"It's a transcript/log database."** Also wrong. It models facts and beliefs, not messages, tool calls, or subagents.
- **"recall is just vector search."** It is four arms plus rank fusion plus a cross-encoder.
- **"recall is affected by disposition."** Only `reflect` is.
- **"It needs a separate Postgres server."** Optional — embedded `pg0`, `hindsight-all`, and Hindsight Cloud all exist. Oracle AI Database support is newer than 0.5.2; see the live storage docs.
- **"It needs an LLM for everything."** Not quite. `HINDSIGHT_API_LLM_PROVIDER=none` runs chunk-only mode: retain stores chunks and semantic recall works, but there is no fact extraction, no observations, and reflect returns HTTP 400. Default fact extraction/reflect do require an LLM.

## Notes

- Configuration is `HINDSIGHT_API_*` environment variables plus per-bank config (`PATCH /v1/default/banks/{bank_id}/config`, body wrapped in `{"updates": {...}}`).
- Database migrations run automatically on startup.
- Multi-bank queries need client-side orchestration; a server ships one MCP endpoint per bank at `/mcp/{bank_id}/`.
- Use `document_id` plus `update_mode` to manage evolving documents: same `document_id` replaces, `append` concatenates and reprocesses only the new delta.
- This bundle is a **0.5.2 snapshot**, not current upstream documentation. Checked against the 1.1.0 spec, no path the bundle documents has been deleted from the spec, but 32 newer paths are missing (knowledge pages, memory history, timeseries, dry-run extraction, and more). Some retained paths are dead at runtime: `/v1/default/banks/{bank_id}/profile` is marked "removed — use GET …/config" and returns `410` on 1.1.0, so presence in a spec does not mean an endpoint works. If the bundle disagrees with <https://hindsight.vectorize.io> or the live server, the site/server wins — refresh the bundle rather than trusting a stale copy.
