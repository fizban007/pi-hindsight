# Performance Tuning

## Recall latency benchmarks

Tested against a self-hosted Hindsight server (2 vCPU / 8 GB RAM) backed by Supabase free tier (shared CPU, pgvector). The benchmark configured a global bank and a project bank, so Pi queries two banks in parallel on the first successful recall of a session. These numbers were measured on an earlier Hindsight release; newer versions can use different vector backends or defaults.

**Setup:**
- Hindsight server: 2 vCPU / 8 GB RAM, local network (~50ms RTT)
- Database: Supabase free tier, session pooler mode
- Embedding: Gemini `gemini-embedding-001` (remote API)
- Banks: 68 memory units (global), 182 memory units (project)
- Query pattern: 2 parallel recall requests (global + project bank)

**Results after HNSW index on `memory_units`:**

| budget | max_tokens | avg wall time | notes |
|---|---|---|---|
| `mid` | `512` | ~3.97s | most consistent |
| `mid` | `1024` | ~4.02s | fine |
| `mid` | `4096` | ~3.98s | returns all memories |
| `high` | `512` | ~7.42s | unstable, spiked to 18s |
| `high` | `1024` | ~4.00s | no benefit over mid |
| `high` | `4096` | ~4.03s | no benefit over mid |

**Recommended settings:**

```toml
# ~/.hindsight/config
# high adds instability with no latency benefit
recall_budget = mid
# reduces context injection noise; no latency impact
recall_max_tokens = 512
```

## What causes recall latency

In order of impact:

1. **Missing HNSW index on `memory_units`** — the biggest factor. Without it, every recall is a full sequential cosine scan across all rows. Hindsight creates these indexes itself as part of schema setup; pgvector with HNSW is the default vector backend, and DiskANN (pgvectorscale/pg_diskann) and vchord are alternatives (see the Hindsight storage docs). The indexes are partial, per `bank_id` + `fact_type`, roughly:
   ```sql
   -- shape of one bank+type index; let Hindsight create it unless you are repairing an old DB
   CREATE INDEX ON memory_units USING hnsw (embedding vector_cosine_ops)
     WHERE fact_type = 'observation' AND bank_id = 'your-bank';
   ```
   If they are missing on an older or hand-migrated database, check the table and index names against your installed version before running DDL by hand, and prefer letting the server's own setup recreate them.

2. **Supabase free tier CPU** — shared, severely throttled. Even with HNSW, expect 3–5s per parallel pair. Concurrent pgvector queries compete for CPU. Upgrading to a paid tier drops this significantly.

3. **Remote embedding API latency** — in this setup, Gemini added ~0.5–1s fixed cost per recall request. This is avoidable: Hindsight's default local embedding model removes the remote call.

4. **Parallel vs sequential queries** — Pi queries both banks in parallel. Pre-index, this caused severe contention (17–36s). Post-index, parallel is faster than sequential (~4s wall vs ~6s sequential) because Supabase can handle two HNSW queries concurrently once the index is in place.

5. **`max_tokens` does not affect latency** — the server does the same work regardless of how many results it returns. Lower `max_tokens` only reduces context injection size.

## Supabase index checklist

Run in Supabase SQL editor to verify your setup:

```sql
-- confirm HNSW indexes exist on memory_units
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'memory_units' AND indexdef LIKE '%hnsw%';

-- look for a redundant full-table HNSW index; do not drop anything until you
-- have confirmed your Hindsight version expects only per-bank partial indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'memory_units';

-- confirm chunks FK indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename = 'chunks';
-- expected index names vary by Hindsight version; check the foreign-key
-- indexes for bank_id/document_id are present
```
