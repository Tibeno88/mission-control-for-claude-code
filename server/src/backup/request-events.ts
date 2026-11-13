import type Database from "better-sqlite3";
import type { RequestEvent } from "../transcripts.js";
import { resolveAccountId } from "./db.js";

const insertStmts = new WeakMap<Database.Database, Database.Statement>();

function getInsertStmt(db: Database.Database): Database.Statement {
  let stmt = insertStmts.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT INTO request_events
         (session_id, agent_id, project_slug, account_id, model, ts,
          input_tokens, output_tokens, cache_read_tokens,
          cache_write_5m_tokens, cache_write_1h_tokens, cost_usd,
          rate_input, rate_output, rate_cache_read, rate_cache_write_5m,
          rate_cache_write_1h, pricing_source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id, dedupe_key) DO UPDATE SET
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_5m_tokens = excluded.cache_write_5m_tokens,
         cache_write_1h_tokens = excluded.cache_write_1h_tokens,
         cost_usd = excluded.cost_usd,
         rate_input = excluded.rate_input,
         rate_output = excluded.rate_output,
         rate_cache_read = excluded.rate_cache_read,
         rate_cache_write_5m = excluded.rate_cache_write_5m,
         rate_cache_write_1h = excluded.rate_cache_write_1h,
         pricing_source = excluded.pricing_source`,
    );
    insertStmts.set(db, stmt);
  }
  return stmt;
}

/**
 * Persists one billable LLM request as a fact row. account_id is resolved and
 * frozen at write time — a later project_account_map edit must not rewrite
 * historical cost. Upserts on the (session_id, agent_id, dedupe_key) unique
 * constraint: a streamed message re-emitted with its final usage replaces the
 * partial row, while account_id and ts keep their first-write values.
 */
export function insertRequestEvent(
  db: Database.Database,
  event: RequestEvent,
): void {
  const accountId = resolveAccountId(db, event.projectSlug);
  getInsertStmt(db).run(
    event.sessionId,
    event.agentId ?? "",
    event.projectSlug,
    accountId,
    event.model,
    event.ts,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cacheReadTokens,
    event.usage.cacheWrite5mTokens,
    event.usage.cacheWrite1hTokens,
    event.costUSD,
    event.rateInput ?? null,
    event.rateOutput ?? null,
    event.rateCacheRead ?? null,
    event.rateCacheWrite5m ?? null,
    event.rateCacheWrite1h ?? null,
    event.pricingSource ?? null,
    event.dedupeKey,
  );
}
