import { randomUUID } from "node:crypto";
import { chooseDwellSeconds, classifyRecommendation, normalizeAuthorName } from "./browser_rules.mjs";
import { activeSession, insertObservation } from "./collector.ts";
import { buildAdvancePlan, buildExecutionPlan } from "./feed_actions.ts";
import { loadQuota, saveQuota } from "./quota.ts";
import { openDb } from "./store.ts";

const PLAN_STALE_SECONDS = 15 * 60;

type Evidence = {
  creatorFollowerCount?: number | null;
  creatorRecentLikesStable?: boolean | null;
  isRecentlyPublished?: boolean | null;
};

type ActionOutcome = { attempted?: boolean; success?: boolean } | undefined;

type ActionResults = {
  like?: ActionOutcome;
  favorite?: ActionOutcome;
  follow?: ActionOutcome;
  comment?: ActionOutcome;
  not_interested?: ActionOutcome;
  completion?: { actual?: boolean; max_position_seconds?: number };
  dwell_seconds?: number;
};

function relevanceText(classification: { high: boolean; relevant: boolean }) {
  if (classification.high) return "high";
  if (classification.relevant) return "medium";
  return "none";
}

function succeeded(outcome: ActionOutcome) {
  return outcome?.success === true;
}

export function runStep(input: {
  dbPath: string;
  runConfig: Record<string, unknown>;
  page: Record<string, unknown>;
  evidence?: Evidence | null;
  record_id?: string;
  action_results?: ActionResults;
}) {
  const db = openDb(input.dbPath);
  const session = activeSession(db);
  if (!session) throw new Error("no active session; run start first");
  const sessionId = String(session.session_id);
  const runConfig = input.runConfig;
  if (runConfig?.status !== "confirmed" || typeof runConfig.config_hash !== "string") {
    throw new Error("runConfig must be the sealed run-config.confirmed.json");
  }
  db.query("DELETE FROM plans WHERE created_at < ?").run(Date.now() / 1000 - PLAN_STALE_SECONDS);

  // Phase 2: a plan exists for this record — persist the executed outcome.
  if (input.record_id) {
    const planRow = db.query("SELECT payload FROM plans WHERE record_id=? AND session_id=?")
      .get(input.record_id, sessionId) as { payload: string } | null;
    if (planRow) {
      return commitPlanned(db, input.dbPath, sessionId, runConfig, input.record_id, JSON.parse(planRow.payload), input.action_results || {});
    }
  }

  // Phase 1: classify, quota-decide, and either commit (nothing to execute)
  // or persist a plan for the agent to execute.
  const recordId = input.record_id || randomUUID();
  const page = input.page || {};
  const profile = (runConfig.interest_profile ?? runConfig.profile) as Record<string, unknown>;
  const authorization = (runConfig.authorization ?? {}) as Record<string, boolean>;
  const limits = (runConfig.interaction_policy ?? {}) as Record<string, { max_total?: number }>;

  const stopText = typeof page.stop_text_hit === "string" && page.stop_text_hit ? page.stop_text_hit : null;
  if (stopText) {
    return { status: "stop_required", record_id: recordId, reason: stopText };
  }

  const lastAweme = db.query(
    "SELECT aweme_id FROM observations WHERE session_id=? ORDER BY feed_index DESC LIMIT 1",
  ).get(sessionId) as { aweme_id?: string } | null;
  const awemeId = String(page.aweme_id || "");
  if (awemeId && lastAweme?.aweme_id && awemeId === lastAweme.aweme_id) {
    return {
      status: "duplicate_page",
      record_id: recordId,
      aweme_id: awemeId,
      reason: "当前内容与上一条已记录内容相同，推荐流未切换；先完成切换再重试。",
    };
  }

  const author = normalizeAuthorName(page.author as string);
  const contentType = String(page.content_type ?? page.contentType ?? "video").toLowerCase();
  const raw = {
    title: page.title,
    caption: page.caption,
    text: page.text,
    author,
    contentType,
    live: contentType === "live",
    durationSeconds: page.duration_seconds ?? page.durationSeconds,
    likeCount: page.like_count ?? page.likeCount,
    ...input.evidence,
  };
  const classification = classifyRecommendation(raw, profile);
  if (classification.needsCreatorProfile && input.evidence == null) {
    return {
      status: "needs_evidence",
      record_id: recordId,
      required: ["creatorFollowerCount", "creatorRecentLikesStable", "isRecentlyPublished"],
      classification,
    };
  }

  const forceSkip = contentType === "live" || contentType === "ad" || classification.directSkip;
  const observedRelevant = classification.relevant && !forceSkip;
  const wrapper = loadQuota(db, sessionId, runConfig);
  const repeatHighCreatorCount = wrapper.creatorHighCounts[author] || 0;
  if (classification.high && author) wrapper.creatorHighCounts[author] = repeatHighCreatorCount + 1;

  const decision = wrapper.policy.decide({
    awemeId: awemeId || recordId,
    relevance: forceSkip ? "none" : relevanceText(classification),
    contentType,
    durationSeconds: Number(raw.durationSeconds),
    author,
    repeatHighCreatorCount,
    feedFollowVisible: page.follow_visible === true,
    alreadyFollowed: (page.action_state as Record<string, unknown> | undefined)?.followed === true,
    notInterestedEligible: classification.notInterestedEligible,
    pageState: "ok",
  }) as Record<string, any>;
  if (decision.stopRequired) {
    return { status: "stop_required", record_id: recordId, reason: String(decision.stopReason || "quota_stop") };
  }

  // Authorization and verified-count caps clamp the sampled plan, exactly
  // like the runner applied them at action time.
  const planned = {
    like: decision.plannedActions.like === true && authorization.like === true,
    favorite: decision.plannedActions.favorite === true && authorization.favorite === true,
    watch_to_end: decision.plannedActions.watchToEnd === true,
    comment: decision.plannedActions.comment === true
      && authorization.comment === true
      && wrapper.counters.comments < Number(limits.comment?.max_total ?? 0),
    follow: decision.plannedActions.follow === true
      && authorization.follow === true
      && wrapper.counters.follows < Number(limits.follow?.max_total ?? 0),
    not_interested: decision.plannedActions.notInterested === true
      && authorization.not_interested === true
      && wrapper.counters.notInterested < Number(limits.not_interested?.max_total ?? 0),
  };

  const dwellRandom = () => (wrapper.policy as unknown as { rng: { next(): number } }).rng.next();
  const dwellSeconds = classification.directSkip
    ? 0
    : Number(chooseDwellSeconds(
      { ...raw, live: contentType === "live" || contentType === "ad" },
      observedRelevant ? classification : { relevant: false, high: false },
      dwellRandom,
    ).toFixed(3));

  saveQuota(db, sessionId, runConfig, wrapper);

  const anyAction = planned.like || planned.favorite || planned.watch_to_end
    || planned.comment || planned.follow || planned.not_interested;
  const executionPlan = buildExecutionPlan({ planned, page, dwellSeconds });
  const advancePlan = buildAdvancePlan(page);
  const base = {
    record_id: recordId,
    planned_actions: { ...planned, next: true },
    dwell_seconds: dwellSeconds,
    classification,
    relevance: forceSkip ? "none" : relevanceText(classification),
    quota: { interaction_bucket: decision.interactionBucket, reused_assignment: decision.reusedAssignment === true },
    execution_plan: executionPlan,
    advance_plan: advancePlan,
  };

  if (!anyAction) {
    const committed = commitObservation(input.dbPath, runConfig, recordId, {
      page,
      classification,
      decision,
      observedRelevant,
      dwellSeconds,
      contentType,
      author,
      planned,
      evidence: input.evidence ?? null,
    }, {});
    return { status: "committed", ...base, ...committed };
  }

  db.query("INSERT INTO plans(record_id, session_id, payload, created_at) VALUES (?, ?, ?, ?)").run(
    recordId,
    sessionId,
    JSON.stringify({ page, classification, decision, observedRelevant, dwellSeconds, contentType, author, planned, evidence: input.evidence ?? null }),
    Date.now() / 1000,
  );
  return {
    status: "planned",
    ...base,
    hint: "按 execution_plan 顺序执行（不要自造选择器），然后带同一 record_id 和 action_results 重调 step 落盘；committed 之后再执行 advance_plan。",
  };
}

function commitPlanned(
  db: ReturnType<typeof openDb>,
  dbPath: string,
  sessionId: string,
  runConfig: Record<string, unknown>,
  recordId: string,
  plan: Record<string, any>,
  results: ActionResults,
) {
  const wrapper = loadQuota(db, sessionId, runConfig);
  if (succeeded(results.follow)) wrapper.counters.follows += 1;
  if (succeeded(results.not_interested)) wrapper.counters.notInterested += 1;
  if (succeeded(results.comment)) wrapper.counters.comments += 1;
  saveQuota(db, sessionId, runConfig, wrapper);

  const committed = commitObservation(dbPath, runConfig, recordId, plan, results);
  db.query("DELETE FROM plans WHERE record_id=?").run(recordId);
  return {
    status: "committed",
    record_id: recordId,
    planned_actions: { ...plan.planned, next: true },
    dwell_seconds: results.dwell_seconds ?? plan.dwellSeconds,
    classification: plan.classification,
    execution_plan: buildExecutionPlan({
      planned: plan.planned,
      page: plan.page,
      dwellSeconds: Number(results.dwell_seconds ?? plan.dwellSeconds),
    }),
    advance_plan: buildAdvancePlan(plan.page),
    ...committed,
  };
}

function commitObservation(
  dbPath: string,
  runConfig: Record<string, unknown>,
  recordId: string,
  plan: Record<string, any>,
  results: ActionResults,
) {
  const { page, classification, decision, observedRelevant, dwellSeconds, contentType, author } = plan;
  let action = observedRelevant ? "watch_then_next" : "direct_skip";
  if (observedRelevant && plan.planned?.watch_to_end) action = "watch_to_end_then_next";
  if (!observedRelevant && succeeded(results.not_interested)) action = "not_interested";

  const observation = {
    ...page,
    observation_id: recordId,
    record_id: recordId,
    run_id: runConfig.run_id,
    account_ref: runConfig.account_ref,
    config_hash: runConfig.config_hash,
    content_type: contentType,
    author,
    is_relevant: observedRelevant,
    decision: observedRelevant ? "keep" : "skip",
    action,
    dwell_seconds: results.dwell_seconds ?? dwellSeconds,
    user_liked: succeeded(results.like),
    user_favorited: succeeded(results.favorite),
    user_commented: succeeded(results.comment),
    user_followed: succeeded(results.follow),
    matched_keywords: classification.matched,
    interest_score: classification.high ? 9 : (classification.relevant ? 6 : 1),
    user_action_result: {
      like: results.like ?? { attempted: false, success: false },
      favorite: results.favorite ?? { attempted: false, success: false },
      follow: results.follow ?? { attempted: false, success: false },
      comment: results.comment ?? { attempted: false, success: false },
      not_interested: results.not_interested ?? { attempted: false, success: false },
      completion: results.completion ?? null,
    },
    rpa_feedback: {
      content_type: contentType,
      classification,
      quota: {
        interaction_bucket: decision.interactionBucket,
        planned_actions: decision.plannedActions,
        reused_assignment: decision.reusedAssignment === true,
      },
      evidence: plan.evidence ?? null,
    },
  };
  return insertObservation(dbPath, observation);
}
