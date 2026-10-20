// Retained to make old deployment commands fail safely instead of restoring paid account polling.
throw new Error("Fixed WeChat accounts use WeRSS. Run migrations/seed; use scripts/discover-wechat.ts only for candidate discovery.");
export {};
