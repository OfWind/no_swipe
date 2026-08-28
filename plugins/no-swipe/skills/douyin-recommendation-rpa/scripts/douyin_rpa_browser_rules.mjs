// Deterministic browser-side classification primitives. Interest terms come
// exclusively from the confirmed AccountProfile snapshot; this module has no
// built-in product or topic persona.

const textOf = (raw) => [raw?.title, raw?.caption, raw?.text, raw?.author, raw?.creatorType]
  .map((value) => String(value || "").toLowerCase())
  .join("\n");

const uniqueTerms = (terms) => [...new Set(
  (terms || []).map((term) => String(term).trim()).filter(Boolean),
)];

const matchTerms = (text, terms) => uniqueTerms(terms).filter((term) => text.includes(term.toLowerCase()));

export function classifyRecommendation(raw, profile) {
  const selectionMode = profile?.selection_mode || "include";
  if (!profile || !Array.isArray(profile.positive_topics) || !Array.isArray(profile.negative_topics)) {
    throw new Error("分类前必须提供已确认的账号画像快照");
  }
  if (selectionMode === "include" && profile.positive_topics.length === 0) {
    throw new Error("include 画像必须提供 positive_topics");
  }
  const text = textOf(raw);
  const positive = matchTerms(text, profile.positive_topics);
  const priority = matchTerms(text, profile.high_priority_topics || []);
  const negative = matchTerms(text, [
    ...(profile.negative_topics || []),
    ...(profile.excluded_creator_types || []),
  ]);
  const matched = uniqueTerms([...positive, ...priority]);
  const relevant = negative.length === 0 && (selectionMode === "exclude_only" || matched.length > 0);

  const contentRules = profile.content_rules;
  const durationSeconds = Number(raw?.durationSeconds);
  const shortVideo = Boolean(
    contentRules?.short_video_max_duration_seconds
    && Number.isFinite(durationSeconds)
    && durationSeconds > 0
    && durationSeconds <= Number(contentRules.short_video_max_duration_seconds),
  );
  const likeCount = Number(raw?.likeCount);
  const belowMinimum = contentRules
    && Number.isFinite(likeCount)
    && likeCount < Number(contentRules.minimum_like_count);
  const recentException = belowMinimum
    && contentRules?.below_minimum_behavior === "skip_unless_recent"
    && raw?.isRecentlyPublished === true;
  const directSkip = Boolean(shortVideo || (belowMinimum && !recentException));
  const needsRecentEvidence = Boolean(
    belowMinimum
    && raw?.isRecentlyPublished !== true
    && raw?.isRecentlyPublished !== false
    && contentRules?.below_minimum_behavior === "skip_unless_recent",
  );

  const creatorRule = profile.creator_rules?.high_relevance;
  const followerCount = Number(raw?.creatorFollowerCount);
  const followerEvidence = Number.isFinite(followerCount);
  const stabilityEvidence = raw?.creatorRecentLikesStable === true || raw?.creatorRecentLikesStable === false;
  const creatorHigh = creatorRule
    ? followerEvidence
      && followerCount >= Number(creatorRule.follower_count_min)
      && followerCount <= Number(creatorRule.follower_count_max)
      && (!creatorRule.require_stable_recent_likes || raw?.creatorRecentLikesStable === true)
    : null;
  const highMatchCount = Math.max(1, Number(profile.classification?.high_match_count || 2));
  const keywordHigh = priority.length > 0 || matched.length >= highMatchCount;
  const high = relevant && !directSkip && (creatorRule ? creatorHigh : keywordHigh);
  const needsCreatorProfile = relevant && !shortVideo && (
    needsRecentEvidence
    || (creatorRule && (!followerEvidence || (creatorRule.require_stable_recent_likes && !stabilityEvidence)))
  );
  return {
    relevant,
    high,
    matched,
    excluded: negative,
    level: high ? "high" : (relevant && !directSkip ? "medium" : "none"),
    directSkip,
    shortVideo,
    recentException,
    needsCreatorProfile,
    notInterestedEligible: (
      shortVideo && contentRules?.short_video_behavior === "not_interested_or_skip"
    ) || negative.length > 0 || (selectionMode === "include" && !relevant),
  };
}

export function sampleTruncatedNormal(mean, standardDeviation, minimum, maximum, random = Math.random) {
  if (![mean, standardDeviation, minimum, maximum].every(Number.isFinite)) {
    throw new Error("正态停留参数必须是有限数值");
  }
  if (minimum > maximum || standardDeviation < 0) throw new Error("正态停留参数范围无效");
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const left = Math.max(Number.EPSILON, random());
    const right = Math.max(Number.EPSILON, random());
    const standard = Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
    const sample = mean + standard * standardDeviation;
    if (sample >= minimum && sample <= maximum) return sample;
  }
  return Math.min(maximum, Math.max(minimum, mean));
}

export function normalizeAuthorName(raw) {
  return String(raw || "").replace(/^@+/, "").replace(/\s+/g, " ").trim();
}

export function selectAuthorProfileHref(links, author) {
  const candidates = (links || []).filter((link) => /\/user\//.test(String(link?.href || "")));
  const normalizedAuthor = normalizeAuthorName(author).toLowerCase();
  if (!normalizedAuthor) return "";
  const named = candidates.find((link) => {
    const text = normalizeAuthorName(link.text).toLowerCase();
    return Boolean(text) && (text === normalizedAuthor || text.includes(normalizedAuthor) || normalizedAuthor.includes(text));
  });
  return named?.href || "";
}

export function chooseDwellSeconds(raw, classification, random = Math.random, platformConfig = {}) {
  const dwell = platformConfig.dwell_seconds || {};
  const key = raw?.live ? "live_or_ad" : (classification?.high ? "high" : (classification?.relevant ? "medium" : "unrelated"));
  const fallback = {
    high: { mean: 8, standard_deviation: 2.5, minimum: 3, maximum: 18 },
    medium: { mean: 4, standard_deviation: 1.5, minimum: 1.5, maximum: 10 },
    unrelated: { mean: 0.9, standard_deviation: 0.45, minimum: 0.35, maximum: 2.2 },
    live_or_ad: { mean: 0.65, standard_deviation: 0.12, minimum: 0.4, maximum: 0.9 },
  }[key];
  const selected = dwell[key] || fallback;
  return sampleTruncatedNormal(
    Number(selected.mean),
    Number(selected.standard_deviation),
    Number(selected.minimum),
    Number(selected.maximum),
    random,
  );
}
