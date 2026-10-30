# 小红书事件反查试探

目标只有一个：拿站内事件去小红书搜索，是否能找到讨论同一件事的笔记。真实付费试搜由审查方在线上执行；本地只用空测试库和 HTTP stub 验证脚本。召回与相关性尚未评估，规则命中不代表人工相关。

脚本不接调度、不调用模型、不取笔记详情、不写文章或 `story_signals`，也不改变预算、信源和热度公式。付费请求只写现有标准回执与 attempts，使用 `DISCOVERY_POOL`（`everyinfra:discovery`），同时遵守 EveryInfra 总预算。

## 固定样本与查询

建计划在同一个只读、可重复读的数据库快照里执行：

- 事件未合并，`latest_at` 在 `(计划时间 - 7 天, 计划时间]`。
- 至少一篇公开报道 `score >= 50` 或 `selected`。公开报道沿用 X 试探的可见边界：非重复材料、editorial 信源、`publications.visibility = 'public'`、`eligible`，精选已过 `visible_after`。
- 至少一篇非重复报道 `articles.language = 'zh'` 或原始标题含汉字。这项独立于公开报道门槛，低分、未进公开池或热度信号报道也可提供中文证据；翻译后的公开标题不算原始报道语言证据。
- 按公开报道最高分降序、事件 id 升序取最多 15 个。计划保存事件 id、标题、最高分、各篇非重复报道的原始标题、链接和语言，以及 `source_id LIKE 'xhs-%'` 的 `story_signals` 行数 `xhsParticipants`。这是指定的行数口径，不是去重作者数，也不限定信号时间。
- 事件标题有汉字时使用它；否则取第一篇中文报道的标题（报道按 article id 固定排序）。复用 `lookupQuery()` 清理，随后按 Unicode 字符截到 20 字。关键词随计划保存，续跑不重新取样或改写查询。仅 language 标成 zh 而标题没有汉字的报道仍按该语言标记处理，不额外翻译。

每个事件至多一个逻辑搜索请求：

```ts
everyInfraCall({
  platform: "xiaohongshu", action: "search",
  params: { keyword, sort: "newest", date_range: "last_7_days" },
  subject: `story:${id}`, purpose: "xhs_story_probe",
  window: planId, pool: DISCOVERY_POOL,
})
```

`docs/sources.md` 的小红书示例和 `industry/sources.json` 现有搜索均使用 `newest`；两处没有 `general` 的支持证据，因此本步采用 `newest`。`last_7_days` 是服务商在执行时解释的相对窗口，延后续跑的新请求不代表原计划时间的严格历史快照；每次响应仍保存在对应回执中。

## 执行和恢复

在已迁移的应用环境里先生成并预览，确认固定样本后由审查方执行：

```bash
node --env-file=.env scripts/probe-xhs-story-lookup.ts --plan .data/xhs-story-probe-2026-10-30.json
node --env-file=.env scripts/probe-xhs-story-lookup.ts --plan .data/xhs-story-probe-2026-10-30.json --run
```

- 不加 `--run` 只生成或预览计划，不收费；`--run` 要求计划已存在，不会顺便选样。已有计划不会被覆盖。
- 计划与结果只允许放在本仓库 `.data/`，拒绝指向该目录外的路径或符号链接。文件权限为 `0600`，不提交 Git。
- 计划内容的 SHA-256 前 24 位作为 `planId`。同一计划用 PostgreSQL 会话锁互斥，锁覆盖计次、请求及结果保存。
- 由于回执 subject 按要求是 `story:<id>`，计划上限通过计划中所有逻辑键关联 `receipt_attempts` 统计，累计最多 15 次实际尝试，失败也计入，不按运行次数或日期重置。完全相同的查询可复用同一回执，不会额外付费。
- 达到 15 次后仍能读取已有成功回执；没有成功回执的下一项会以预算停止状态正常结束。总预算或 discovery 份额耗尽同样保存进度、退出码为 0，不继续后面的事件。
- unknown、进行中的回执及其他错误立即停止，保存已完成进度并以非零退出码结束；脚本不自动重试，不重发 unknown。先检查回执状态再决定后续操作。明确失败的请求可在下次手动续跑中尝试，仍受累计 15 次限制。不要改计划或重新建计划绕过上限。
- 每条成功查询先把结果原子写到 `<计划>.results.json`，再完成回执。重跑从已存回执重建结果文件；人工填写 `review` 时请使用另一个 `.data/` 副本，以免被覆盖。

## 结果和人工复核

每个事件记录 `keyword`、服务商原始返回条数 `received`、`receiptId`、`reused`、`receiptCostUsd` 与 `newCostUsd`。复用时新增费用为 0，服务商没报告费用时保留 null。

保持服务商顺序，最多保存 20 条身份有效的笔记样本：note id、无签名参数的规范链接、标题、正文前 200 个 Unicode 字符、作者名和 id、服务商提供的发布时间、点赞／收藏／评论数、带货标记、`ruleMatch` 与 `review: null`。链接身份复用 `xhsNoteIdFromUrl()`；不安全地址或 id 与地址不一致的条目不展示为样本，原始返回条数不变，原始响应仍在回执里。互动数复用 `json-list.ts` 的 `engagementOf()`，缺失或无效值为 null；缺失带货标记也为 null。带货笔记保留并标出，供人工判断。

`ruleMatch` 是纯函数，满足任一条件即为 true：

1. 查询词去除常见泛词后，笔记完整标题和正文里出现至少两个不同、互不重叠的连续汉字片段，每段至少两字。实现用二字片段；查询和笔记中都不将重叠片段重复计数，也不越过标点拼字。泛词表包括心理学、心理健康、研究、发现、最新等，完整列表随纯函数源码固定。
2. 笔记标题与任一报道原始标题的字符二元组 Dice 重合度至少 0.3，复用 `titleOverlap()`。

规则在截短正文前执行。样本不按规则命中或带货标记过滤，也不额外请求展开短链、补全正文或查询互动数。

人工逐条填写是否在讨论同一事件，再比较：已执行事件数、有返回的事件数、人工确认相关的事件和笔记数、相关比例、已有小红书信号数与费用。没有执行完的事件不能计为零召回。是否继续这条路线由真实试搜和人工复核决定，本脚本不作生产接入结论。

## 本地验收

新建空的 `*_test` 库后，使用本地 PostgreSQL 与 HTTP stub：

```bash
export DATABASE_URL=postgres://psyhot:psyhot@127.0.0.1:55432/psyhot_xhs_probe_verify_20261030_test
node scripts/migrate.ts
npm run typecheck
node --test --test-concurrency=1 --test-timeout=120000 tests/xhs-story-probe*.test.ts tests/x-story-*.test.ts
npm test
node scripts/probe-xhs-story-lookup.ts --help
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
```

测试覆盖取样边界与只读快照、关键词清理、规则预判、20 条上限、带货标记、地址身份、费用记录、回执重放、预算中途停止和续跑、失败计次到第 15 次、会话锁以及 unknown 不重发。没有执行真实付费试搜。

2026-10-30 本地验收：52 个迁移应用到新建空库；小红书和 X 联合回归 27/27，随后在同一个库中运行完整后端测试 391/391；全项目 typecheck、新 CLI 独立 TypeScript 检查和 `--help` 通过。网页构建、网页测试 16/16，以及隔离端口 31471/31472 的本地站点 smoke 30/30 通过，临时站点进程已停止。日志在 `.data/xhs-probe-final-*.log`、`.data/xhs-probe-web-tests.log` 和 `.data/xhs-probe-smoke.log`。

验收中确认既有 X 数据库测试会留下 33 条模拟 attempts，导致紧接着运行全套测试时误触 EveryInfra 分钟预算。只在该测试的 finally 中补充按本次计划 subject 清理测试回执（attempts 随外键删除），没有修改 X 试探业务代码或预算规则。最终联合回归后接全量测试的顺序已通过。
