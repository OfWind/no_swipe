import { randomUUID } from "node:crypto";
import { classifyRecommendation } from "./browser_rules.mjs";
import { insertObservation } from "./collector.ts";

type Evidence = {
  creatorFollowerCount?: number | null;
  creatorRecentLikesStable?: boolean | null;
  isRecentlyPublished?: boolean | null;
};

export function runStep(input: {
  dbPath: string;
  runConfig: Record<string, unknown>;
  page: Record<string, unknown>;
  evidence?: Evidence | null;
  record_id?: string;
  action_results?: Record<string, unknown>;
}) {
  const profile = (input.runConfig.interest_profile ?? input.runConfig.profile) as Record<string, unknown>;
  const recordId = input.record_id || randomUUID();
  const raw = {
    title: input.page.title,
    caption: input.page.caption,
    text: input.page.text,
    author: input.page.author,
    live: input.page.contentType === "live",
    durationSeconds: input.page.duration_seconds ?? input.page.durationSeconds,
    likeCount: input.page.like_count ?? input.page.likeCount,
    ...input.evidence,
  };
  const classification = classifyRecommendation(raw, profile);
  const evidenceMissing = classification.needsCreatorProfile && input.evidence == null;
  if (evidenceMissing) {
    return {
      status: "needs_evidence",
      record_id: recordId,
      required: ["creatorFollowerCount", "creatorRecentLikesStable", "isRecentlyPublished"],
      classification,
    };
  }

  const forceSkip = input.page.contentType === "live" || input.page.contentType === "ad" || classification.directSkip;
  const observedRelevant = classification.relevant && !forceSkip;
  const observation = {
    ...input.page,
    observation_id: recordId,
    record_id: recordId,
    run_id: input.runConfig.run_id,
    account_ref: input.runConfig.account_ref,
    config_hash: input.runConfig.config_hash,
    is_relevant: observedRelevant,
    decision: observedRelevant ? "keep" : "skip",
    action: observedRelevant ? "watch_then_next" : (classification.notInterestedEligible ? "not_interested" : "direct_skip"),
    matched_keywords: classification.matched,
    interest_score: classification.high ? 9 : (classification.relevant ? 6 : 1),
    user_action_result: input.action_results ?? {},
    rpa_feedback: { classification, evidence: input.evidence ?? null },
  };
  const committed = insertObservation(input.dbPath, observation);
  return {
    status: "committed",
    record_id: recordId,
    planned_actions: {
      like: Boolean(observedRelevant && classification.high),
      favorite: Boolean(observedRelevant && classification.high),
      follow: false,
      not_interested: Boolean(!observedRelevant && classification.notInterestedEligible),
      next: true,
    },
    classification,
    ...committed,
  };
}
