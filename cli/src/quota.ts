import type { Database } from "bun:sqlite";
import { quotaConfigFromRunConfig } from "./config.mjs";
import { DouyinQuotaPolicy } from "./quota_policy.mjs";

// Wraps the seeded quota policy with the runner-era side state that lived
// outside the policy object: verified-action counters (caps), repeat-high
// creator counts (follow eligibility), and SQLite persistence.

export type QuotaWrapper = {
  policy: DouyinQuotaPolicy;
  counters: { follows: number; notInterested: number; comments: number };
  creatorHighCounts: Record<string, number>;
};

type QuotaRow = { config_hash: string; snapshot: string };

export function loadQuota(db: Database, sessionId: string, runConfig: Record<string, unknown>): QuotaWrapper {
  const expected = quotaConfigFromRunConfig(runConfig);
  const row = db.query("SELECT config_hash, snapshot FROM quota_state WHERE session_id=?")
    .get(sessionId) as QuotaRow | null;
  if (row && row.config_hash === String(runConfig.config_hash)) {
    const saved = JSON.parse(row.snapshot);
    return {
      policy: DouyinQuotaPolicy.fromSnapshot(saved.policy),
      counters: {
        follows: Number(saved.counters?.follows || 0),
        notInterested: Number(saved.counters?.notInterested || 0),
        comments: Number(saved.counters?.comments || 0),
      },
      creatorHighCounts: saved.creator_high_counts || {},
    };
  }
  // New session or a resealed config: rebuild the policy exactly like the
  // runner-era loadOrCreateQuotaPolicy did when runConfigHash changed.
  return {
    policy: new DouyinQuotaPolicy({ config: expected }),
    counters: { follows: 0, notInterested: 0, comments: 0 },
    creatorHighCounts: {},
  };
}

export function saveQuota(db: Database, sessionId: string, runConfig: Record<string, unknown>, wrapper: QuotaWrapper) {
  db.query(`
    INSERT INTO quota_state(session_id, config_hash, snapshot, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      config_hash=excluded.config_hash,
      snapshot=excluded.snapshot,
      updated_at=excluded.updated_at
  `).run(
    sessionId,
    String(runConfig.config_hash),
    JSON.stringify({
      policy: wrapper.policy.snapshot(),
      counters: wrapper.counters,
      creator_high_counts: wrapper.creatorHighCounts,
    }),
    Date.now() / 1000,
  );
}

export function quotaSummary(wrapper: QuotaWrapper) {
  const summary = wrapper.policy.summary() as Record<string, unknown>;
  return { ...summary, verified_counters: { ...wrapper.counters } };
}
