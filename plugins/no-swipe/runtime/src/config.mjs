import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "1.0.0";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SOURCE_DIR, "../..");
const RATE_KEYS = ["like_rate", "favorite_rate", "like_favorite_overlap_rate", "comment_rate", "completion_rate"];
const AUTHORIZATION_KEYS = ["like", "favorite", "comment", "follow", "not_interested", "profile_visit"];

export class ConfigValidationError extends Error {
  constructor(kind, issues) {
    super(`${kind} 配置无效：${issues.map((issue) => `${issue.path} ${issue.message}`).join("；")}`);
    this.name = "ConfigValidationError";
    this.kind = kind;
    this.issues = issues;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function mergeDecisionObject(base, override) {
  if (!isObject(override)) return clone(override);
  const merged = isObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(merged[key])
      ? mergeDecisionObject(merged[key], value)
      : clone(value);
  }
  return merged;
}

function applyDecisionMode(base, mode, input, scope) {
  if (!["preset", "extend", "replace"].includes(mode)) {
    throw new Error(`${scope} mode 必须是 preset、extend 或 replace`);
  }
  if (mode === "preset") {
    if (input !== undefined) throw new Error(`${scope} mode=preset 时不能提供 input`);
    return clone(base);
  }
  if (!isObject(input)) throw new Error(`${scope} mode=${mode} 时必须提供 JSON 对象 input`);
  return mode === "extend" ? mergeDecisionObject(base, input) : clone(input);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function accountDirectory(dataDir, accountRef) {
  if (typeof accountRef !== "string" || accountRef.trim() === "") throw new Error("account_ref 必须是非空字符串");
  const accountHash = crypto.createHash("sha256").update(accountRef).digest("hex");
  return path.resolve(dataDir, "accounts", accountHash);
}

export function computeConfigHash(config) {
  const payload = clone(config);
  delete payload.config_hash;
  return digest(payload);
}

export function createProfileSnapshot(profile) {
  validateAccountProfile(profile);
  const snapshot = {
    profile_id: profile.profile_id,
    account_ref: profile.account_ref,
    revision: profile.revision,
    name: profile.name,
    ...(profile.selection_mode ? { selection_mode: profile.selection_mode } : {}),
    ...(profile.audience ? { audience: [...profile.audience] } : {}),
    positive_topics: [...profile.positive_topics],
    high_priority_topics: [...(profile.high_priority_topics || [])],
    negative_topics: [...profile.negative_topics],
    ...(profile.excluded_creator_types ? { excluded_creator_types: [...profile.excluded_creator_types] } : {}),
    boundary_guidance: [...profile.boundary_guidance],
    ...(profile.content_rules ? { content_rules: clone(profile.content_rules) } : {}),
    ...(profile.creator_rules ? { creator_rules: clone(profile.creator_rules) } : {}),
    classification: clone(profile.classification || { high_match_count: 2 }),
  };
  return { ...snapshot, profile_hash: digest(snapshot) };
}

function add(issues, pathName, message) {
  issues.push({ path: pathName, message });
}

function requireObject(value, pathName, issues) {
  if (!isObject(value)) {
    add(issues, pathName, "必须是对象");
    return false;
  }
  return true;
}

function requireExactKeys(value, allowed, required, pathName, issues) {
  if (!requireObject(value, pathName, issues)) return false;
  for (const key of required) {
    if (!(key in value)) add(issues, `${pathName}.${key}`, "缺少必填字段");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(issues, `${pathName}.${key}`, "是不支持的字段");
  }
  return true;
}

function requireString(value, pathName, issues, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") add(issues, pathName, "必须是非空字符串");
}

function requireInteger(value, pathName, issues, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) add(issues, pathName, `必须是大于或等于 ${minimum} 的整数`);
}

function requireRate(value, pathName, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    add(issues, pathName, "必须是 0 到 1 之间的显式数值");
  }
}

function requireStringArray(value, pathName, issues, { minimum = 0 } = {}) {
  if (!Array.isArray(value)) {
    add(issues, pathName, "必须是字符串数组");
    return;
  }
  if (value.length < minimum) add(issues, pathName, `至少需要 ${minimum} 项`);
  if (value.some((item) => typeof item !== "string" || item.trim() === "")) add(issues, pathName, "只能包含非空字符串");
  if (new Set(value.map((item) => item.toLowerCase())).size !== value.length) add(issues, pathName, "不能包含重复项");
}

function requireDateTime(value, pathName, issues) {
  requireString(value, pathName, issues);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) add(issues, pathName, "必须是 ISO 8601 时间");
}

function validateContentRules(rules, pathName, issues) {
  const required = ["minimum_like_count", "below_minimum_behavior", "recent_evidence_sources", "recent_definition"];
  const keys = [...required, "short_video_max_duration_seconds", "short_video_behavior"];
  if (!requireExactKeys(rules, keys, required, pathName, issues)) return;
  requireInteger(rules.minimum_like_count, `${pathName}.minimum_like_count`, issues, 0);
  if (!["skip", "skip_unless_recent"].includes(rules.below_minimum_behavior)) add(issues, `${pathName}.below_minimum_behavior`, "必须是 skip 或 skip_unless_recent");
  requireStringArray(rules.recent_evidence_sources, `${pathName}.recent_evidence_sources`, issues, { minimum: 1 });
  for (const source of rules.recent_evidence_sources || []) {
    if (!["feed_published_at", "creator_profile_video_list"].includes(source)) add(issues, `${pathName}.recent_evidence_sources`, `不支持 ${source}`);
  }
  requireString(rules.recent_definition, `${pathName}.recent_definition`, issues);
  const hasShortVideoMax = rules.short_video_max_duration_seconds !== undefined;
  const hasShortVideoBehavior = rules.short_video_behavior !== undefined;
  if (hasShortVideoMax !== hasShortVideoBehavior) {
    add(issues, pathName, "短视频时长上限与处理方式必须同时提供");
  }
  if (hasShortVideoMax) {
    requireInteger(rules.short_video_max_duration_seconds, `${pathName}.short_video_max_duration_seconds`, issues, 1);
    if (!["skip", "not_interested_or_skip"].includes(rules.short_video_behavior)) {
      add(issues, `${pathName}.short_video_behavior`, "必须是 skip 或 not_interested_or_skip");
    }
  }
}

function validateCreatorRules(rules, pathName, issues) {
  if (!requireExactKeys(rules, ["high_relevance"], ["high_relevance"], pathName, issues)) return;
  const highPath = `${pathName}.high_relevance`;
  const keys = ["follower_count_min", "follower_count_max", "require_stable_recent_likes", "stability_definition", "evidence_source"];
  if (!requireExactKeys(rules.high_relevance, keys, keys, highPath, issues)) return;
  requireInteger(rules.high_relevance.follower_count_min, `${highPath}.follower_count_min`, issues, 0);
  requireInteger(rules.high_relevance.follower_count_max, `${highPath}.follower_count_max`, issues, 0);
  if (rules.high_relevance.follower_count_max < rules.high_relevance.follower_count_min) add(issues, highPath, "粉丝上限不能小于下限");
  if (typeof rules.high_relevance.require_stable_recent_likes !== "boolean") add(issues, `${highPath}.require_stable_recent_likes`, "必须是布尔值");
  requireString(rules.high_relevance.stability_definition, `${highPath}.stability_definition`, issues);
  if (rules.high_relevance.evidence_source !== "creator_profile") add(issues, `${highPath}.evidence_source`, "当前只支持 creator_profile");
}

export function validateAccountProfile(profile) {
  const issues = [];
  const required = [
    "schema_version", "profile_id", "platform", "account_ref", "revision", "name",
    "positive_topics", "negative_topics", "boundary_guidance", "created_at", "updated_at",
  ];
  const allowed = [
    ...required, "selection_mode", "audience", "high_priority_topics", "excluded_creator_types",
    "content_rules", "creator_rules", "classification",
  ];
  if (requireExactKeys(profile, allowed, required, "$", issues)) {
    if (profile.schema_version !== CONTRACT_VERSION) add(issues, "$.schema_version", `仅支持 ${CONTRACT_VERSION}`);
    if (profile.platform !== "douyin") add(issues, "$.platform", "当前仅支持 douyin");
    requireString(profile.profile_id, "$.profile_id", issues);
    requireString(profile.account_ref, "$.account_ref", issues);
    requireInteger(profile.revision, "$.revision", issues, 1);
    requireString(profile.name, "$.name", issues);
    const selectionMode = profile.selection_mode || "include";
    if (!["include", "exclude_only"].includes(selectionMode)) add(issues, "$.selection_mode", "必须是 include 或 exclude_only");
    requireStringArray(profile.audience || [], "$.audience", issues);
    requireStringArray(profile.positive_topics, "$.positive_topics", issues, { minimum: selectionMode === "include" ? 1 : 0 });
    requireStringArray(profile.high_priority_topics || [], "$.high_priority_topics", issues);
    requireStringArray(profile.negative_topics, "$.negative_topics", issues, { minimum: selectionMode === "exclude_only" ? 1 : 0 });
    requireStringArray(profile.excluded_creator_types || [], "$.excluded_creator_types", issues);
    requireStringArray(profile.boundary_guidance, "$.boundary_guidance", issues);
    if (profile.content_rules !== undefined) validateContentRules(profile.content_rules, "$.content_rules", issues);
    if (profile.creator_rules !== undefined) validateCreatorRules(profile.creator_rules, "$.creator_rules", issues);
    requireDateTime(profile.created_at, "$.created_at", issues);
    requireDateTime(profile.updated_at, "$.updated_at", issues);
    if (profile.classification !== undefined) {
      if (requireExactKeys(profile.classification, ["high_match_count"], ["high_match_count"], "$.classification", issues)) {
        requireInteger(profile.classification.high_match_count, "$.classification.high_match_count", issues, 1);
      }
    }
  }
  if (issues.length) throw new ConfigValidationError("AccountProfile", issues);
  return profile;
}

function validateProfileSnapshot(profile, issues) {
  const required = ["profile_id", "account_ref", "revision", "profile_hash", "name", "positive_topics", "negative_topics", "boundary_guidance"];
  const allowed = [
    ...required, "selection_mode", "audience", "high_priority_topics", "excluded_creator_types",
    "content_rules", "creator_rules", "classification",
  ];
  if (!requireExactKeys(profile, allowed, required, "$.interest_profile", issues)) return;
  requireString(profile.profile_id, "$.interest_profile.profile_id", issues);
  requireString(profile.account_ref, "$.interest_profile.account_ref", issues);
  requireInteger(profile.revision, "$.interest_profile.revision", issues, 1);
  requireString(profile.name, "$.interest_profile.name", issues);
  const selectionMode = profile.selection_mode || "include";
  if (!["include", "exclude_only"].includes(selectionMode)) add(issues, "$.interest_profile.selection_mode", "必须是 include 或 exclude_only");
  requireStringArray(profile.audience || [], "$.interest_profile.audience", issues);
  requireStringArray(profile.positive_topics, "$.interest_profile.positive_topics", issues, { minimum: selectionMode === "include" ? 1 : 0 });
  requireStringArray(profile.high_priority_topics || [], "$.interest_profile.high_priority_topics", issues);
  requireStringArray(profile.negative_topics, "$.interest_profile.negative_topics", issues, { minimum: selectionMode === "exclude_only" ? 1 : 0 });
  requireStringArray(profile.excluded_creator_types || [], "$.interest_profile.excluded_creator_types", issues);
  requireStringArray(profile.boundary_guidance, "$.interest_profile.boundary_guidance", issues);
  if (profile.content_rules !== undefined) validateContentRules(profile.content_rules, "$.interest_profile.content_rules", issues);
  if (profile.creator_rules !== undefined) validateCreatorRules(profile.creator_rules, "$.interest_profile.creator_rules", issues);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(profile.profile_hash || ""))) {
    add(issues, "$.interest_profile.profile_hash", "必须是 sha256 摘要");
  }
  const snapshotPayload = clone(profile);
  delete snapshotPayload.profile_hash;
  if (profile.profile_hash && profile.profile_hash !== digest(snapshotPayload)) {
    add(issues, "$.interest_profile.profile_hash", "与画像快照内容不一致");
  }
  if (profile.classification !== undefined) {
    if (requireExactKeys(profile.classification, ["high_match_count"], ["high_match_count"], "$.interest_profile.classification", issues)) {
      requireInteger(profile.classification.high_match_count, "$.interest_profile.classification.high_match_count", issues, 1);
    }
  }
}

function validateGoal(goal, issues) {
  if (!requireExactKeys(goal, ["observed_target", "relevant_target"], ["observed_target", "relevant_target"], "$.goal", issues)) return;
  requireInteger(goal.observed_target, "$.goal.observed_target", issues, 1);
  if (goal.relevant_target !== null) requireInteger(goal.relevant_target, "$.goal.relevant_target", issues, 0);
}

function validateInteractionPolicy(policy, authorization, issues) {
  const keys = ["rules", "comment", "follow", "not_interested", "profile_sampling"];
  if (!requireExactKeys(policy, keys, keys, "$.interaction_policy", issues)) return;
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    add(issues, "$.interaction_policy.rules", "至少需要一条明确的相关性规则");
  } else {
    const seen = new Set();
    policy.rules.forEach((rule, index) => {
      const base = `$.interaction_policy.rules[${index}]`;
      const ruleKeys = ["eligible_relevance", ...RATE_KEYS, "block_size"];
      if (!requireExactKeys(rule, ruleKeys, ruleKeys, base, issues)) return;
      if (!Array.isArray(rule.eligible_relevance) || rule.eligible_relevance.length === 0) {
        add(issues, `${base}.eligible_relevance`, "必须包含 high 或 medium");
      } else {
        for (const level of rule.eligible_relevance) {
          if (!["high", "medium"].includes(level)) add(issues, `${base}.eligible_relevance`, `不支持 ${level}`);
          if (seen.has(level)) add(issues, `${base}.eligible_relevance`, `${level} 不能由多条规则重复定义`);
          seen.add(level);
        }
      }
      RATE_KEYS.forEach((key) => requireRate(rule[key], `${base}.${key}`, issues));
      requireInteger(rule.block_size, `${base}.block_size`, issues, 1);
      if (Number.isFinite(rule.like_favorite_overlap_rate)) {
        if (rule.like_favorite_overlap_rate > rule.like_rate) add(issues, `${base}.like_favorite_overlap_rate`, "不能大于点赞率");
        if (rule.like_favorite_overlap_rate > rule.favorite_rate) add(issues, `${base}.like_favorite_overlap_rate`, "不能大于收藏率");
      }
      const union = rule.like_rate + rule.favorite_rate - rule.like_favorite_overlap_rate;
      if (Number.isFinite(union) && union > 1 + 1e-9) add(issues, base, "点赞与收藏去重后的合计比例不能超过 1");
      if (rule.comment_rate > 0 && !rule.eligible_relevance.includes("high")) {
        add(issues, `${base}.comment_rate`, "contract 1.0.0 仅允许对 high 相关内容分配评论");
      }
    });
  }

  if (requireExactKeys(policy.comment, ["max_total", "approval_mode", "guidance"], ["max_total", "approval_mode", "guidance"], "$.interaction_policy.comment", issues)) {
    requireInteger(policy.comment.max_total, "$.interaction_policy.comment.max_total", issues, 0);
    if (!["per_run", "per_item"].includes(policy.comment.approval_mode)) add(issues, "$.interaction_policy.comment.approval_mode", "必须是 per_run 或 per_item");
    if (typeof policy.comment.guidance !== "string") add(issues, "$.interaction_policy.comment.guidance", "必须是字符串");
  }
  if (requireExactKeys(policy.follow, ["eligible_relevance", "rate", "max_total", "minimum_repeat_creator_count", "block_size"], ["eligible_relevance", "rate", "max_total", "minimum_repeat_creator_count", "block_size"], "$.interaction_policy.follow", issues)) {
    if (!Array.isArray(policy.follow.eligible_relevance) || policy.follow.eligible_relevance.length !== 1 || policy.follow.eligible_relevance[0] !== "high") add(issues, "$.interaction_policy.follow.eligible_relevance", "contract 1.0.0 必须是 [\"high\"]");
    requireRate(policy.follow.rate, "$.interaction_policy.follow.rate", issues);
    requireInteger(policy.follow.max_total, "$.interaction_policy.follow.max_total", issues, 0);
    requireInteger(policy.follow.minimum_repeat_creator_count, "$.interaction_policy.follow.minimum_repeat_creator_count", issues, 0);
    requireInteger(policy.follow.block_size, "$.interaction_policy.follow.block_size", issues, 1);
  }
  if (requireExactKeys(policy.not_interested, ["rate", "max_total", "block_size"], ["rate", "max_total", "block_size"], "$.interaction_policy.not_interested", issues)) {
    requireRate(policy.not_interested.rate, "$.interaction_policy.not_interested.rate", issues);
    requireInteger(policy.not_interested.max_total, "$.interaction_policy.not_interested.max_total", issues, 0);
    requireInteger(policy.not_interested.block_size, "$.interaction_policy.not_interested.block_size", issues, 1);
  }
  if (requireExactKeys(policy.profile_sampling, ["rate", "max_total"], ["rate", "max_total"], "$.interaction_policy.profile_sampling", issues)) {
    requireRate(policy.profile_sampling.rate, "$.interaction_policy.profile_sampling.rate", issues);
    requireInteger(policy.profile_sampling.max_total, "$.interaction_policy.profile_sampling.max_total", issues, 0);
  }

  const positive = {
    like: policy.rules?.some((rule) => rule.like_rate > 0),
    favorite: policy.rules?.some((rule) => rule.favorite_rate > 0),
    comment: policy.rules?.some((rule) => rule.comment_rate > 0),
    follow: policy.follow?.rate > 0,
    not_interested: policy.not_interested?.rate > 0,
    profile_visit: policy.profile_sampling?.rate > 0,
  };
  for (const [action, hasPositiveRate] of Object.entries(positive)) {
    if (hasPositiveRate && authorization?.[action] !== true) add(issues, `$.authorization.${action}`, "存在正比例时必须明确授权为 true");
  }
  if (positive.comment && policy.comment?.max_total < 1) add(issues, "$.interaction_policy.comment.max_total", "评论率大于 0 时必须设置正的总上限");
  if (positive.comment && !String(policy.comment?.guidance || "").trim()) add(issues, "$.interaction_policy.comment.guidance", "评论率大于 0 时必须提供本轮评论要求");
  if (positive.follow && policy.follow?.max_total < 1) add(issues, "$.interaction_policy.follow.max_total", "关注率大于 0 时必须设置正的总上限");
  if (positive.not_interested && policy.not_interested?.max_total < 1) add(issues, "$.interaction_policy.not_interested.max_total", "不感兴趣率大于 0 时必须设置正的总上限");
  if (positive.profile_visit && policy.profile_sampling?.max_total < 1) add(issues, "$.interaction_policy.profile_sampling.max_total", "主页抽样率大于 0 时必须设置正的总上限");
}

function validateAuthorization(authorization, issues) {
  if (!requireExactKeys(authorization, AUTHORIZATION_KEYS, AUTHORIZATION_KEYS, "$.authorization", issues)) return;
  for (const key of AUTHORIZATION_KEYS) {
    if (typeof authorization[key] !== "boolean") add(issues, `$.authorization.${key}`, "必须是显式布尔值");
  }
}

function validateVersions(versions, issues) {
  const keys = ["adapter", "classifier", "policy", "contract"];
  if (!requireExactKeys(versions, keys, keys, "$.versions", issues)) return;
  for (const key of keys) requireString(versions[key], `$.versions.${key}`, issues);
  if (versions.contract !== CONTRACT_VERSION) add(issues, "$.versions.contract", `仅支持 ${CONTRACT_VERSION}`);
}

export function validateRunConfig(config, { requireConfirmed = false } = {}) {
  const issues = [];
  const required = ["schema_version", "run_id", "account_ref", "interest_profile", "goal", "interaction_policy", "authorization", "versions", "status"];
  const allowed = [...required, "confirmed_at", "confirmed_by", "config_hash"];
  if (requireExactKeys(config, allowed, required, "$", issues)) {
    if (config.schema_version !== CONTRACT_VERSION) add(issues, "$.schema_version", `仅支持 ${CONTRACT_VERSION}`);
    requireString(config.run_id, "$.run_id", issues);
    requireString(config.account_ref, "$.account_ref", issues);
    validateProfileSnapshot(config.interest_profile, issues);
    if (config.interest_profile?.account_ref !== config.account_ref) add(issues, "$.interest_profile.account_ref", "必须与 RunConfig.account_ref 一致");
    validateGoal(config.goal, issues);
    validateAuthorization(config.authorization, issues);
    validateInteractionPolicy(config.interaction_policy, config.authorization, issues);
    validateVersions(config.versions, issues);
    if (!["draft", "waiting_for_confirmation", "confirmed"].includes(config.status)) add(issues, "$.status", "必须是 draft、waiting_for_confirmation 或 confirmed");
    if (requireConfirmed && config.status !== "confirmed") add(issues, "$.status", "运行前必须是 confirmed");
    if (config.status === "confirmed") {
      requireDateTime(config.confirmed_at, "$.confirmed_at", issues);
      requireString(config.confirmed_by, "$.confirmed_by", issues);
      if (!/^sha256:[a-f0-9]{64}$/.test(String(config.config_hash || ""))) add(issues, "$.config_hash", "confirmed 配置必须包含 sha256 摘要");
      if (config.config_hash && config.config_hash !== computeConfigHash(config)) add(issues, "$.config_hash", "与当前配置内容不一致");
    } else if (config.config_hash !== undefined || config.confirmed_at !== undefined || config.confirmed_by !== undefined) {
      add(issues, "$", "未确认配置不能携带 confirmation 字段或 config_hash");
    }
  }
  if (issues.length) throw new ConfigValidationError("RunConfig", issues);
  return config;
}

export function confirmRunConfig(config, { confirmedBy, confirmedAt = new Date().toISOString() }) {
  if (typeof confirmedBy !== "string" || confirmedBy.trim() === "") throw new Error("confirmedBy 必须是非空字符串");
  const draft = clone(config);
  delete draft.config_hash;
  delete draft.confirmed_at;
  delete draft.confirmed_by;
  if (draft.status === "confirmed") draft.status = "waiting_for_confirmation";
  validateRunConfig(draft);
  draft.status = "confirmed";
  draft.confirmed_at = confirmedAt;
  draft.confirmed_by = confirmedBy;
  draft.config_hash = computeConfigHash(draft);
  return validateRunConfig(draft, { requireConfirmed: true });
}

export function quotaConfigFromRunConfig(runConfig) {
  validateRunConfig(runConfig, { requireConfirmed: true });
  const cleanRate = (value) => Number(Number(value).toFixed(12));
  const ruleFor = (level) => runConfig.interaction_policy.rules.find((rule) => rule.eligible_relevance.includes(level));
  const interaction = (level) => {
    const rule = ruleFor(level);
    if (!rule) return { blockSize: 100, rates: { like_only: 0, favorite_only: 0, like_and_favorite: 0, none: 1 } };
    const both = rule.like_favorite_overlap_rate;
    const likeOnly = cleanRate(rule.like_rate - both);
    const favoriteOnly = cleanRate(rule.favorite_rate - both);
    return {
      blockSize: rule.block_size,
      rates: {
        like_only: likeOnly,
        favorite_only: favoriteOnly,
        like_and_favorite: both,
        none: cleanRate(1 - likeOnly - favoriteOnly - both),
      },
    };
  };
  const highRule = ruleFor("high");
  const policy = runConfig.interaction_policy;
  return {
    version: "2.0.0",
    seed: runConfig.run_id,
    runConfigHash: runConfig.config_hash,
    highInteraction: interaction("high"),
    mediumInteraction: interaction("medium"),
    completion: {
      blockSize: highRule?.block_size || 100,
      rates: { complete: highRule?.completion_rate || 0, not_complete: cleanRate(1 - (highRule?.completion_rate || 0)) },
    },
    comment: {
      blockSize: highRule?.block_size || 100,
      rates: { comment: highRule?.comment_rate || 0, not_comment: cleanRate(1 - (highRule?.comment_rate || 0)) },
    },
    follow: {
      blockSize: policy.follow.block_size,
      rates: { candidate: policy.follow.rate, not_candidate: cleanRate(1 - policy.follow.rate) },
    },
    notInterested: {
      blockSize: policy.not_interested.block_size,
      rates: { apply: policy.not_interested.rate, none: cleanRate(1 - policy.not_interested.rate) },
    },
    completionMaxDurationSeconds: 180,
    minimumRepeatHighCreatorCount: policy.follow.minimum_repeat_creator_count,
  };
}

function validatePresetShape(preset) {
  const issues = [];
  const keys = ["schema_version", "preset_id", "display_name", "user_facing_copy", "confirmation_notice", "profile", "run_defaults"];
  if (requireExactKeys(preset, keys, keys, "$", issues)) {
    if (preset.schema_version !== CONTRACT_VERSION) add(issues, "$.schema_version", `仅支持 ${CONTRACT_VERSION}`);
    for (const key of ["preset_id", "display_name", "user_facing_copy", "confirmation_notice"]) requireString(preset[key], `$.${key}`, issues);
    requireObject(preset.profile, "$.profile", issues);
    requireObject(preset.run_defaults, "$.run_defaults", issues);
  }
  if (issues.length) throw new ConfigValidationError("OnboardingPreset", issues);
}

export function materializeOnboardingPreset(preset, {
  accountRef,
  profileId,
  runId,
  revision,
  timestamp = new Date().toISOString(),
  profileMode = "preset",
  profileInput,
  runMode = "preset",
  runInput,
} = {}) {
  validatePresetShape(preset);
  for (const [name, value] of Object.entries({ accountRef, profileId, runId })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 必须是非空字符串`);
  }
  const profileDecision = applyDecisionMode(preset.profile, profileMode, profileInput, "profile");
  const runDecision = applyDecisionMode(preset.run_defaults, runMode, runInput, "run");
  // 已有账号通过 profile-input 传入当前画像时，保留其 revision 和 created_at，
  // 避免物化结果回退到 revision 1。
  const profile = {
    ...profileDecision,
    schema_version: CONTRACT_VERSION,
    profile_id: profileId,
    platform: "douyin",
    account_ref: accountRef,
    revision: revision ?? profileDecision.revision ?? 1,
    created_at: profileDecision.created_at ?? timestamp,
    updated_at: profileDecision.updated_at ?? timestamp,
  };
  validateAccountProfile(profile);
  const runConfig = {
    ...runDecision,
    schema_version: CONTRACT_VERSION,
    run_id: runId,
    account_ref: accountRef,
    interest_profile: createProfileSnapshot(profile),
    status: "waiting_for_confirmation",
  };
  validateRunConfig(runConfig);
  return {
    preset_id: preset.preset_id,
    application: { profile_mode: profileMode, run_mode: runMode },
    profile,
    run_config: runConfig,
  };
}

export function validateOnboardingPreset(preset) {
  materializeOnboardingPreset(preset, {
    accountRef: "douyin:preset-validation",
    profileId: "profile-preset-validation",
    runId: "run-preset-validation",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  return preset;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

export async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, resolved);
  return resolved;
}

export async function resolveAccountProfile(accountRef, { dataDir = ".no-swipe" } = {}) {
  const currentPath = path.join(accountDirectory(dataDir, accountRef), "current.json");
  try {
    const profile = await readJson(currentPath);
    validateAccountProfile(profile);
    if (profile.account_ref !== accountRef) throw new Error("画像目录与 account_ref 不一致");
    return profile;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listAccountProfiles({ dataDir = ".no-swipe" } = {}) {
  const accountsDir = path.resolve(dataDir, "accounts");
  let entries;
  try {
    entries = await fs.readdir(accountsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const currentPath = path.join(accountsDir, entry.name, "current.json");
    const profile = await readJson(currentPath);
    validateAccountProfile(profile);
    if (accountDirectory(dataDir, profile.account_ref) !== path.join(accountsDir, entry.name)) {
      throw new Error(`账号目录 ${entry.name} 与 current.json 的 account_ref 不一致`);
    }
    profiles.push(profile);
  }
  return profiles.sort((left, right) => left.account_ref.localeCompare(right.account_ref));
}

export async function bindAccountProfile(profile, { dataDir = ".no-swipe" } = {}) {
  validateAccountProfile(profile);
  const existing = await resolveAccountProfile(profile.account_ref, { dataDir });
  if (existing) throw new Error(`账号 ${profile.account_ref} 已绑定画像 ${existing.profile_id} revision ${existing.revision}`);
  if (profile.revision !== 1) throw new Error("首次绑定的画像 revision 必须为 1");
  const directory = accountDirectory(dataDir, profile.account_ref);
  const revisionPath = path.join(directory, "revisions", "1.json");
  await writeJsonAtomic(revisionPath, profile);
  await writeJsonAtomic(path.join(directory, "current.json"), profile);
  return { currentPath: path.join(directory, "current.json"), revisionPath, profile };
}

export async function updateAccountProfile(profile, { dataDir = ".no-swipe" } = {}) {
  validateAccountProfile(profile);
  const existing = await resolveAccountProfile(profile.account_ref, { dataDir });
  if (!existing) throw new Error(`账号 ${profile.account_ref} 尚未绑定画像，请先 bind`);
  if (existing.profile_id !== profile.profile_id) throw new Error("一个账号只能维护一个逻辑 profile_id");
  if (profile.revision !== existing.revision + 1) throw new Error(`新 revision 必须为 ${existing.revision + 1}`);
  if (profile.created_at !== existing.created_at) throw new Error("画像更新不得改写 created_at");
  const directory = accountDirectory(dataDir, profile.account_ref);
  const revisionPath = path.join(directory, "revisions", `${profile.revision}.json`);
  try {
    await fs.access(revisionPath);
    throw new Error(`revision ${profile.revision} 已存在，拒绝覆盖`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(revisionPath, profile);
  await writeJsonAtomic(path.join(directory, "current.json"), profile);
  return { currentPath: path.join(directory, "current.json"), revisionPath, profile };
}

export async function loadPlatformConfig(adapter = "douyin.v1") {
  if (!/^[a-z0-9.-]+$/.test(adapter)) throw new Error(`不安全的 adapter 名称：${adapter}`);
  return readJson(path.join(PLUGIN_DIR, "config", "platforms", `${adapter}.json`));
}
