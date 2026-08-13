// Deterministic browser-side classification primitives. Interest terms come
// exclusively from the confirmed AccountProfile snapshot; this module has no
// built-in product or topic persona.

const textOf = (raw) => [raw?.title, raw?.caption, raw?.text, raw?.author]
  .map((value) => String(value || "").toLowerCase())
  .join("\n");

const uniqueTerms = (terms) => [...new Set(
  (terms || []).map((term) => String(term).trim()).filter(Boolean),
)];

const matchTerms = (text, terms) => uniqueTerms(terms).filter((term) => text.includes(term.toLowerCase()));

export function classifyRecommendation(raw, profile) {
  if (!profile || !Array.isArray(profile.positive_topics) || profile.positive_topics.length === 0) {
    throw new Error("分类前必须提供已确认账号画像的 positive_topics");
  }
  const text = textOf(raw);
  const positive = matchTerms(text, profile.positive_topics);
  const priority = matchTerms(text, profile.high_priority_topics || []);
  const negative = matchTerms(text, profile.negative_topics || []);
  const matched = uniqueTerms([...positive, ...priority]);
  const relevant = matched.length > 0 && negative.length === 0;
  const highMatchCount = Math.max(1, Number(profile.classification?.high_match_count || 2));
  const high = relevant && (priority.length > 0 || matched.length >= highMatchCount);
  return {
    relevant,
    high,
    matched,
    excluded: negative,
    level: high ? "high" : (relevant ? "medium" : "none"),
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
