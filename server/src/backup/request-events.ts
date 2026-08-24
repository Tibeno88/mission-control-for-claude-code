import type Database from "better-sqlite3";
import type { RequestEvent } from "../transcripts.js";
import { resolveAccountId } from "./db.js";

const insertStmts = new WeakMap<Database.Database, Database.Statement>();

function getInsertStmt(db: Database.Database): Database.Statement {
  let stmt = insertStmts.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT OR IGNORE INTO request_events
         (session_id, agent_id, project_slug, account_id, model, ts,
          input_tokens, output_tokens, cache_read_tokens,
          cache_write_5m_tokens, cache_write_1h_tokens, cost_usd,
          rate_input, rate_output, rate_cache_read, rate_cache_write_5m,
          rate_cache_write_1h, pricing_source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertStmts.set(db, stmt);
  }
  return stmt;
}

/**
 * Persists one billable LLM request as a fact row. account_id is resolved and
 * frozen at write time — a later project_account_map edit must not rewrite
 * historical cost. Idempotent via the (session_id, agent_id, dedupe_key)
 * unique constraint, so re-ingesting from byte offset 0 after a restart is
 * harmless.
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
