import type Database from 'better-sqlite3';

/**
 * Records older than the retention window, except those whose session (same Agent category)
 * still has a record inside the window. The active set is computed once per query, so the cost
 * is linear in the record count instead of quadratic in the size of long-running sessions;
 * maintenance runs this inside a write transaction and must keep the lock short.
 * Requires the `agent_category` SQL function on the connection.
 */
export function expiredRecordIds(db: Database.Database, days: number, options: { limit?: number; contentOnly?: boolean } = {}): number[] {
  const { limit = 100, contentOnly = false } = options;
  return (db.prepare(`WITH cutoff(at) AS MATERIALIZED (SELECT datetime('now', '-' || ? || ' days')),
    active(session_id, category) AS MATERIALIZED (
      SELECT DISTINCT session_id, agent_category(agent_name) FROM records
      WHERE session_id NOT IN ('', 'unknown') AND datetime(created_at) >= (SELECT at FROM cutoff))
    SELECT id FROM records r
    WHERE datetime(created_at) < (SELECT at FROM cutoff) ${contentOnly ? 'AND content_expired = 0' : ''}
      AND NOT EXISTS (SELECT 1 FROM active a WHERE a.session_id = r.session_id AND a.category = agent_category(r.agent_name))
    ORDER BY id LIMIT ?`).all(days, limit) as { id: number }[]).map(row => row.id);
}
