// Shared admin vocabulary.
export const KIND_LABEL: Record<string, string> = { rss: "RSS", web_list: "网页列表", json_list: "JSON", x_search: "X", mp_account: "公众号", external: "外部上报" };
export const MODE_LABEL: Record<string, string> = { editorial: "精选", hot_signal: "氛围", isolated: "隔离" };
export const HEALTH_LABEL: Record<string, string> = { ok: "正常", degraded: "不稳定", failing: "失败", paused: "已暂停", unknown: "未检查" };
export const VISIBILITY_LABEL: Record<string, string> = { public: "公开", "summary-only": "仅摘要", withdrawn: "已下架" };
export const FEEDBACK_STATUS: Record<string, string> = { new: "新反馈", triaged: "处理中", replied: "已回复", resolved: "已解决", spam: "垃圾信息" };
export const TIER_LABEL: Record<string, string> = { T1: "T1", T1_5: "T1.5", T2: "T2", EXCLUDE_MP: "排除公众号" };
export const TRACK_LABEL: Record<string, string> = { academic: "学界", industry: "业界", mixed: "两边都有" };
export const REGION_LABEL: Record<string, string> = { domestic: "国内", international: "国际" };
