// 可选模块。它们只对 AI 行业有意义：做别的行业时两项都设为 false，或者按 docs/customize.md 整块删掉。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。

export const FEATURES = {
  /** 模型榜：汇总公开评测，按公开方法 v15 计算共识排名（/leaderboard）。每天抓 4 次评测来源。 */
  leaderboard: false,
  /** Codex 重置监控：盯 OpenAI Codex 负责人在 X 上的额度重置公告（/codex-reset）。需要 SocialData。 */
  codexResetMonitor: false,
  /**
   * 邮件订阅日报：日报页底部出现订阅框，确认页和退订页可用。发信还要在 .env 里配好
   * EMAIL_ENABLED、EMAIL_SMTP_*、EMAIL_FROM（见 docs/deploy.md“邮件订阅”），没配好时订阅框会提示暂未开放。
   */
  emailDigest: true,
  /**
   * 学界 / 业界视角开关（docs/plans/tracks-academic-industry.md）。关着时网站和对外出口看起来和以前一样：
   * 四个业界类别在筛选栏、角标、RSS、API 和 MCP 里合并成原来的“行业”（key 仍是 industry）。
   */
  tracks: true,
  /**
   * 业界按五类从业者角色浏览：打开后网页的业界视角用“全部 + 五个角色”（?role=）代替四个业界类别，卡片角标显示影响类型，
   * 站内接口、公开 API 和 MCP 的条目多出 roles、impact 两个字段，各出口都接受 role 参数。关着时网站和所有对外出口
   * 与没有这个功能时完全一样（role 参数当作未知参数）。角色和影响类型来自结构理解，打开前要先有足够的标注。
   */
  industryRoles: false,
} as const;
