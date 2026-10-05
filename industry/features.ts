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
} as const;
