// 精选的门槛。第一段标准在 prompts/selection-score.md；学界第二段标准在 prompts/selection-dims.md。
// 每篇资料先独立打两次分（0–100）；业界沿用两次之和 ≥ 2 × 门槛，学界过粗筛线后用五维分数决定。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些；学界和业界可以各定一套。改了门槛或评分提示词，
// 用 scripts/eval-selection.ts 在你自己标注的样本上重跑一遍，再决定上线（见 docs/selection.md）。

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   */
  thresholds: { T1: 60, T1_5: 65, T2: 76 } as Record<string, number>,
  /**
   * 学界、业界各自的门槛，写了的分级覆盖上面的数字。视角看条目的类别（taxonomy.ts 的 track），类别还
   * 没定时看信源的视角。数字要等标注样本攒够了再校准（docs/selection.md），没校准之前两边都沿用上面的。
   */
  trackThresholds: { academic: {}, industry: {} } as Record<string, Record<string, number>>,
  /**
   * 学界第二段：旧评分均分至少 30，再用思考模型按五维各打 1–4 分，等权相加后线性换算到 0–100。
   * 门槛来自 2026-10-29 上线交接：T1 五维和至少 14，T1_5、T2 至少 15。关闭后恢复旧规则，
   * 已有五维结果保留；业界不走这一段。
   */
  academicDims: {
    enabled: true,
    gate: 30,
    thresholds: { T1: 60, T1_5: 65, T2: 67 },
  } as { enabled: boolean; gate: number; thresholds: Record<string, number> },
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由、标签）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
} as const;

/**
 * 热点榜。心理学的一项研究通常只有一本期刊发表，媒体跟进又常常晚几周到几个月，很少能在两天内
 * 凑齐多个独立信源，所以这里放宽了窗口，并把评分算进热度：
 *   热度 = 质量 × 各独立参与方之和。每个参与方（同一机构的多个渠道算一个）在窗口内只算一次，
 *   按半衰期衰减；质量 = 这件事里最高的评分 ÷ 100，没有评分按 50 算。
 * 被多家报道的研究自然排在前面；只有一家报道的，要进了精选才上榜，按评分和新旧排。
 */
export const HOT = {
  /** 统计多长时间内的报道（小时）。 */
  windowHours: 7 * 24,
  /** 热度每过多少小时减半。 */
  halfLifeHours: 72,
  /** 只有一个参与方时，是否进了精选就能上榜（false 时至少要两个独立参与方）。 */
  singleSourceIfSelected: true,
  /**
   * 互动数据（小红书、公众号的点赞、收藏、评论、转发）给参与方加权：互动多说明讨论的人多。
   * 每个参与方的权重 = 1 + log10(1 + 点赞 + 2×收藏 + 3×评论 + 3×转发) / scale，最多 maxWeight；
   * 没有互动数据的参与方权重是 1（和以前一样）。上榜要求的参与方个数不变，互动再多也不能一个人撑起一个热点。
   */
  engagement: { scale: 4, maxWeight: 2 },
} as const;

/** 24 的整数倍写成“N 天”，否则写“N 小时”（页面上说明热点规则时用）。 */
export function hoursLabel(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
}
