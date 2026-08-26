import fs from "node:fs/promises";
import path from "node:path";

// 配额随机器只负责实验分组与审计，不负责点击页面，也不包含任何
// 绕过验证码、访问限制或平台安全措施的逻辑。

export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  version: "2.0.0",
  seed: "no-swipe-safe-policy-v2",
  highInteraction: {
    blockSize: 100,
    rates: {
      like_only: 0,
      favorite_only: 0,
      like_and_favorite: 0,
      none: 1,
    },
  },
  mediumInteraction: {
    blockSize: 100,
    rates: { like_only: 0, favorite_only: 0, like_and_favorite: 0, none: 1 },
  },
  completion: {
    blockSize: 100,
    rates: { complete: 0, not_complete: 1 },
  },
  comment: {
    blockSize: 100,
    rates: { comment: 0, not_comment: 1 },
  },
  follow: {
    blockSize: 100,
    rates: { candidate: 0, not_candidate: 1 },
  },
  notInterested: {
    blockSize: 100,
    rates: { apply: 0, none: 1 },
  },
  completionMaxDurationSeconds: 180,
  minimumRepeatHighCreatorCount: 2,
  stopPageStates: [
    "captcha",
    "verification",
    "rate_limited",
    "access_restricted",
    "login_required",
    "unreliable_page",
  ],
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const mergeConfig = (base, overrides = {}) => ({
  ...clone(base),
  ...clone(overrides),
  highInteraction: {
    ...clone(base.highInteraction),
    ...clone(overrides.highInteraction || {}),
    rates: {
      ...clone(base.highInteraction.rates),
      ...clone(overrides.highInteraction?.rates || {}),
    },
  },
  mediumInteraction: {
    ...clone(base.mediumInteraction),
    ...clone(overrides.mediumInteraction || {}),
    rates: {
      ...clone(base.mediumInteraction.rates),
      ...clone(overrides.mediumInteraction?.rates || {}),
    },
  },
  completion: {
    ...clone(base.completion),
    ...clone(overrides.completion || {}),
    rates: {
      ...clone(base.completion.rates),
      ...clone(overrides.completion?.rates || {}),
    },
  },
  comment: {
    ...clone(base.comment),
    ...clone(overrides.comment || {}),
    rates: {
      ...clone(base.comment.rates),
      ...clone(overrides.comment?.rates || {}),
    },
  },
  follow: {
    ...clone(base.follow),
    ...clone(overrides.follow || {}),
    rates: {
      ...clone(base.follow.rates),
      ...clone(overrides.follow?.rates || {}),
    },
  },
  notInterested: {
    ...clone(base.notInterested),
    ...clone(overrides.notInterested || {}),
    rates: {
      ...clone(base.notInterested.rates),
      ...clone(overrides.notInterested?.rates || {}),
    },
  },
});

const seedToUint32 = (seed) => {
  const text = String(seed ?? DEFAULT_QUOTA_CONFIG.seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 0x6d2b79f5;
};

class SeededRandom {
  constructor(seed, restoredState = null) {
    this.state = restoredState === null ? seedToUint32(seed) : (Number(restoredState) >>> 0);
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x100000000;
  }
}

const validateRates = (name, rates) => {
  const entries = Object.entries(rates || {});
  if (entries.length === 0) throw new Error(`${name}: rates 不能为空`);
  for (const [label, rate] of entries) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(`${name}: ${label} 的比例必须在0到1之间`);
    }
  }
  const total = entries.reduce((sum, [, rate]) => sum + rate, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`${name}: 各分组比例之和必须等于1，当前为${total}`);
  }
};

const apportionCounts = (rates, blockSize) => {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`blockSize 必须是正整数，当前为${blockSize}`);
  }
  const entries = Object.entries(rates);
  const allocations = entries.map(([label, rate]) => {
    const exact = rate * blockSize;
    return { label, exact, count: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = blockSize - allocations.reduce((sum, item) => sum + item.count, 0);
  allocations.sort((left, right) => right.fraction - left.fraction || left.label.localeCompare(right.label));
  for (let index = 0; index < remaining; index += 1) {
    allocations[index % allocations.length].count += 1;
  }
  return Object.fromEntries(allocations.map(({ label, count }) => [label, count]));
};

const shuffled = (values, random) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

class ShuffleBagAllocator {
  constructor({ name, blockSize, rates, random, state = null }) {
    validateRates(name, rates);
    this.name = name;
    this.blockSize = blockSize;
    this.rates = clone(rates);
    this.random = random;
    this.targetCountsPerBlock = apportionCounts(this.rates, this.blockSize);
    this.bag = state?.bag ? [...state.bag] : [];
    this.position = Number(state?.position || 0);
    this.cycles = Number(state?.cycles || 0);
    this.eligibleCount = Number(state?.eligibleCount || 0);
    this.actualCounts = Object.fromEntries(Object.keys(this.rates).map((label) => [label, 0]));
    for (const [label, count] of Object.entries(state?.actualCounts || {})) {
      this.actualCounts[label] = Number(count || 0);
    }
  }

  refill() {
    const values = [];
    for (const [label, count] of Object.entries(this.targetCountsPerBlock)) {
      for (let index = 0; index < count; index += 1) values.push(label);
    }
    this.bag = shuffled(values, this.random);
    this.position = 0;
    this.cycles += 1;
  }

  next() {
    if (this.position >= this.bag.length) this.refill();
    const label = this.bag[this.position];
    this.position += 1;
    this.eligibleCount += 1;
    this.actualCounts[label] = (this.actualCounts[label] || 0) + 1;
    return {
      pool: this.name,
      label,
      eligibleIndex: this.eligibleCount,
      blockNumber: this.cycles,
      positionInBlock: this.position,
      blockSize: this.blockSize,
      targetCountsPerBlock: clone(this.targetCountsPerBlock),
    };
  }

  summary() {
    const realizedRates = Object.fromEntries(
      Object.entries(this.actualCounts).map(([label, count]) => [
        label,
        this.eligibleCount ? count / this.eligibleCount : 0,
      ]),
    );
    return {
      pool: this.name,
      blockSize: this.blockSize,
      eligibleCount: this.eligibleCount,
      completedBlocks: Math.floor(this.eligibleCount / this.blockSize),
      partialBlockSize: this.eligibleCount % this.blockSize,
      targetRates: clone(this.rates),
      targetCountsPerBlock: clone(this.targetCountsPerBlock),
      actualCounts: clone(this.actualCounts),
      realizedRates,
    };
  }

  snapshot() {
    return {
      bag: [...this.bag],
      position: this.position,
      cycles: this.cycles,
      eligibleCount: this.eligibleCount,
      actualCounts: clone(this.actualCounts),
    };
  }
}

const normalizeRelevance = (event) => {
  const explicit = String(event.relevance || "").toLowerCase();
  if (["high", "medium", "none"].includes(explicit)) return explicit;
  if (event.high === true) return "high";
  if (event.relevant === true || event.isRelevant === true) return "medium";
  return "none";
};

const emptyDecision = (reason, pageState = "ok") => ({
  policyVersion: DEFAULT_QUOTA_CONFIG.version,
  stopRequired: false,
  stopReason: "",
  pageState,
  relevance: "none",
  interactionBucket: "none",
  plannedActions: {
    like: false,
    favorite: false,
    watchToEnd: false,
    comment: false,
    follow: false,
    notInterested: false,
  },
  completionEligible: false,
  followCandidate: false,
  followCandidateNewlyAssigned: false,
  commentCandidate: false,
  confirmationRequired: {
    follow: false,
    comment: false,
  },
  noProfileNavigation: true,
  reason,
  quotaFeedback: {},
});

export class DouyinQuotaPolicy {
  constructor(options = {}) {
    const snapshot = options.snapshot || null;
    this.config = snapshot?.config
      ? mergeConfig(DEFAULT_QUOTA_CONFIG, snapshot.config)
      : mergeConfig(DEFAULT_QUOTA_CONFIG, options.config || {});
    this.rng = new SeededRandom(this.config.seed, snapshot?.rngState ?? null);
    const random = () => this.rng.next();
    const allocatorState = snapshot?.allocators || {};
    this.allocators = {
      highInteraction: new ShuffleBagAllocator({
        name: "high_interaction",
        ...this.config.highInteraction,
        random,
        state: allocatorState.highInteraction,
      }),
      mediumInteraction: new ShuffleBagAllocator({
        name: "medium_interaction",
        ...this.config.mediumInteraction,
        random,
        state: allocatorState.mediumInteraction,
      }),
      completion: new ShuffleBagAllocator({
        name: "high_short_completion",
        ...this.config.completion,
        random,
        state: allocatorState.completion,
      }),
      comment: new ShuffleBagAllocator({
        name: "high_comment",
        ...this.config.comment,
        random,
        state: allocatorState.comment,
      }),
      follow: new ShuffleBagAllocator({
        name: "repeat_high_creator_follow_candidate",
        ...this.config.follow,
        random,
        state: allocatorState.follow,
      }),
      notInterested: new ShuffleBagAllocator({
        name: "unrelated_not_interested",
        ...this.config.notInterested,
        random,
        state: allocatorState.notInterested,
      }),
    };
    this.contentAssignments = new Map(Object.entries(snapshot?.contentAssignments || {}));
    this.creatorFollowAssignments = new Map(Object.entries(snapshot?.creatorFollowAssignments || {}));
  }

  decide(event = {}) {
    const pageState = String(event.pageState || "ok").toLowerCase();
    if (this.config.stopPageStates.includes(pageState)) {
      return {
        ...emptyDecision("页面出现验证、访问限制或无法可靠识别的状态，必须停止。", pageState),
        policyVersion: this.config.version,
        stopRequired: true,
        stopReason: pageState,
      };
    }

    const contentKey = String(event.awemeId || event.observationId || "").trim();
    if (contentKey && this.contentAssignments.has(contentKey)) {
      return {
        ...clone(this.contentAssignments.get(contentKey)),
        reusedAssignment: true,
      };
    }

    const relevance = normalizeRelevance(event);
    const contentType = String(event.contentType || "video").toLowerCase();
    const durationSeconds = Number(event.durationSeconds);
    let interactionAllocation = null;
    if (relevance === "high") interactionAllocation = this.allocators.highInteraction.next();
    if (relevance === "medium") interactionAllocation = this.allocators.mediumInteraction.next();
    const interactionBucket = interactionAllocation?.label || "none";

    const completionEligible = relevance === "high"
      && contentType === "video"
      && Number.isFinite(durationSeconds)
      && durationSeconds > 0
      && durationSeconds <= this.config.completionMaxDurationSeconds;
    const completionAllocation = completionEligible ? this.allocators.completion.next() : null;
    const watchToEnd = completionAllocation?.label === "complete";
    const commentAllocation = relevance === "high" ? this.allocators.comment.next() : null;
    const commentCandidate = commentAllocation?.label === "comment";
    const notInterestedEligible = relevance === "none"
      && !["live", "ad"].includes(contentType)
      && event.notInterestedEligible !== false;
    const notInterestedAllocation = notInterestedEligible ? this.allocators.notInterested.next() : null;
    const notInterested = notInterestedAllocation?.label === "apply";

    const author = String(event.author || "").trim();
    const repeatHighCreatorCount = Number(event.repeatHighCreatorCount || 0);
    const feedFollowVisible = event.feedFollowVisible === true;
    const alreadyFollowed = event.alreadyFollowed === true;
    const followEligible = relevance === "high"
      && author.length > 0
      && repeatHighCreatorCount >= this.config.minimumRepeatHighCreatorCount
      && feedFollowVisible
      && !alreadyFollowed;
    let followAllocation = null;
    let followCandidateNewlyAssigned = false;
    if (followEligible) {
      if (!this.creatorFollowAssignments.has(author)) {
        this.creatorFollowAssignments.set(author, this.allocators.follow.next());
        followCandidateNewlyAssigned = true;
      }
      followAllocation = this.creatorFollowAssignments.get(author);
    }
    const followCandidate = followAllocation?.label === "candidate";
    followCandidateNewlyAssigned = followCandidate && followCandidateNewlyAssigned;

    const like = interactionBucket === "like_only" || interactionBucket === "like_and_favorite";
    const favorite = interactionBucket === "favorite_only" || interactionBucket === "like_and_favorite";
    const decision = {
      policyVersion: this.config.version,
      stopRequired: false,
      stopReason: "",
      pageState,
      relevance,
      interactionBucket,
      plannedActions: {
        like,
        favorite,
        watchToEnd,
        comment: commentCandidate,
        // 关注只是候选；实际动作由运行开始时封存的一次性分组确认授权，
        // 执行前仍需核验入口与上限，因此计划位始终为false。
        follow: false,
        notInterested,
      },
      completionEligible,
      followCandidate,
      followCandidateNewlyAssigned,
      commentCandidate,
      confirmationRequired: {
        follow: followCandidate,
        comment: commentCandidate,
      },
      noProfileNavigation: true,
      reason: relevance === "none"
        ? "非相关内容不分配互动或完播。"
        : "按相关性进入配额池，动作位置由种子随机打散。",
      quotaFeedback: {
        interaction: interactionAllocation,
        completion: completionAllocation,
        comment: commentAllocation,
        follow: followAllocation,
        notInterested: notInterestedAllocation,
        followEligible,
        actualActionsMustBeRecordedAfterExecution: true,
      },
      reusedAssignment: false,
    };

    if (contentKey) this.contentAssignments.set(contentKey, clone(decision));
    return decision;
  }

  summary() {
    const planned = {
      assignedContent: this.contentAssignments.size,
      likes: 0,
      favorites: 0,
      watchToEnd: 0,
      uniqueFollowCandidates: 0,
      comments: 0,
      notInterested: 0,
    };
    for (const decision of this.contentAssignments.values()) {
      planned.likes += Number(decision.plannedActions?.like === true);
      planned.favorites += Number(decision.plannedActions?.favorite === true);
      planned.watchToEnd += Number(decision.plannedActions?.watchToEnd === true);
      planned.comments += Number(decision.plannedActions?.comment === true);
      planned.notInterested += Number(decision.plannedActions?.notInterested === true);
    }
    planned.uniqueFollowCandidates = [...this.creatorFollowAssignments.values()]
      .filter((assignment) => assignment?.label === "candidate").length;
    return {
      policyVersion: this.config.version,
      planned,
      pools: {
        highInteraction: this.allocators.highInteraction.summary(),
        mediumInteraction: this.allocators.mediumInteraction.summary(),
        completion: this.allocators.completion.summary(),
        comment: this.allocators.comment.summary(),
        follow: this.allocators.follow.summary(),
        notInterested: this.allocators.notInterested.summary(),
      },
      uniqueFollowAssignments: this.creatorFollowAssignments.size,
    };
  }

  snapshot() {
    return {
      policyVersion: this.config.version,
      savedAt: new Date().toISOString(),
      config: clone(this.config),
      rngState: this.rng.state,
      allocators: {
        highInteraction: this.allocators.highInteraction.snapshot(),
        mediumInteraction: this.allocators.mediumInteraction.snapshot(),
        completion: this.allocators.completion.snapshot(),
        comment: this.allocators.comment.snapshot(),
        follow: this.allocators.follow.snapshot(),
        notInterested: this.allocators.notInterested.snapshot(),
      },
      contentAssignments: Object.fromEntries(this.contentAssignments),
      creatorFollowAssignments: Object.fromEntries(this.creatorFollowAssignments),
    };
  }

  async saveState(filePath) {
    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const temporaryPath = `${resolvedPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, resolvedPath);
    return resolvedPath;
  }

  static fromSnapshot(snapshot) {
    return new DouyinQuotaPolicy({ snapshot });
  }
}

export const createDouyinQuotaPolicy = (options = {}) => new DouyinQuotaPolicy(options);

export const loadDouyinQuotaPolicy = async (filePath) => {
  const snapshot = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
  return DouyinQuotaPolicy.fromSnapshot(snapshot);
};
