# 全部动态与 Bluesky 精简：实施与接续记录

状态：已完成生产上线（PR #19，合并提交 `c92bf35`）。PsyArXiv 已设置 40 分池下限，58 个经审计的 T2 Bluesky 账号已停用；文章、publication 和历史热度记录均保留。预印本定向分类仍是后续功能。

## 2026-10-25 执行结果

- 生产只读审计时间：2026-10-25 13:56（台北）。PsyArXiv 近 14 日 357 条公开记录，350 条原本在池中，193 条低于 40 分；58 个建议停用的 T2 Bluesky 账号全部有本地采集文章，但历史 `story_signals` 为 0。
- 第 0 项历史修正已完成：55 条非 editorial 信号记录改为 `signal`，审计 actor 为 `ops:2026-10-24-signal-kinds`，热点榜已重算。
- 线上配置事务审计 actor 为 `ops:2026-10-25-pool-bluesky-prune`：`json-psyarxiv.poolMinScore=40`，以及 58 个 T2 Bluesky 源的 `enabled=false`。没有删除文章、publication、分析或热度记录。
- PsyArXiv 重发布结果：`total=641`、`changed=356`、`reduced=356`、`signalsChanged=355`。重发布后文章 675、publication 641、热度记录 623 仍全部存在；近 14 日池为 157 条，低于 40 分的 193 条已从池中排除。
- 最终生产 smoke：30/30 通过；当前服务器检出 `main`，提交 `c92bf35`。回滚点和审计文件在服务器 `~/backups/2026-10-25-pool-bluesky-live/`。

## 基线与范围

- 基于 GitHub main `c92bf35e18fa934ef6edfb108ce4eed33580f7ba`；独立 worktree `AIHOT-pool-bluesky`，分支 `fix/pool-bluesky-prune`，已通过 PR #19 合并。
- 生产配置使用线上审计事务写入；后续预印本分类应在读取层增加，不要用删除记录或恢复低分池条目的方式实现。
- 交接提供的历史基线：全部动态每天约 70 条，PsyArXiv 约 26.9 条；Bluesky 121 个账号（T1 12、T2 109），每天 100–170 帖。这些不是本次重新查询的生产结果。
- 本地配置确认 Bluesky 共 121 个信源；PsyArXiv 的 ID 是 `json-psyarxiv`。
- 未调整精选门槛或评分提示词；Bluesky 参与方式仍为 `hot_signal`。未改 X 信源配置和 X 采集逻辑。

## 已完成

1. `republishSource` 在重发文章后，按信源当前参与方式同步历史 `story_signals.kind`；非 editorial 变 signal，恢复 editorial 时仅 eligible 文章恢复为报道。即使旧记录没有对应 publication，也能降为 signal。
2. 返回 `signalsChanged`；后台任务即使没有文章进一步缩小可见范围，只要旧热度记录发生变化也会重算榜单。
3. `config.poolMinScore` 校验为 0–100 的有限数字，所有信源类型均支持。发布层使用最终有效评分（包括管理员覆盖值）判断，缺评分不满足下限，等于下限可进入。不设下限保持旧行为。
4. 后台添加、删除或更改该下限会自动排队重新发布；其他抓取配置的修改不会仅因为 config 变化就整源重发。
5. `scripts/bluesky-follower-audit.ts`：数据库只读事务，读取全部 Bluesky 账号和近 30 天热度记录；公开免费 getProfiles 每批最多 25 个 DID，输出 UTF-8 BOM CSV。T1、粉丝 ≥5000 或近 30 天有记录者建议保留。缺少 DID、API 失败或粉丝数缺失时中止，不把未知当零，不生成错误停用名单。
6. `scripts/psyarxiv-pool-audit.ts`：数据库只读快照；近 14 天按 timeline_at 分桶，含 30–34、35–39、40–44、45–49 各桶当前池内最多 5 条标题/中文摘要，按稳定的 article ID 哈希顺序抽取。另输出不同候选下限的保留量、上海日期的全部动态/PsyArXiv 数量，以及 Bluesky 新发现文章数。首尾可能是不完整自然日；公开已发布条件与列表一致。

## 已核对的页面影响

- `/all` 和站内搜索都依赖 `eligible`，下限会同时生效；搜索索引在重新发布时移除低分条目。
- 主题页 `publication/topics.ts` 使用 `selectedCondition`，只列精选，本来就没有这些低分预印本。
- 详情页不以 eligible 为进入条件，editorial 条目仍按既有参与方式/可见性规则提供。
- 其他读取 eligible 的公开池出口及事件报道视图也可能缩小；不新增字段绕开这一规则。下限应低于现有精选门槛，不能把任意高下限宣称为绝不会影响精选。

## 验证记录

- `npm ci --offline --ignore-scripts --no-audit --no-fund` 成功，无新增依赖。
- `npm run typecheck` 通过。
- `npm run build -w @aihot/web` 通过。
- 新增纯逻辑测试 7/7 通过。将 `>=` 暂时变成 `>` 的边界变异会使测试失败，恢复后通过。
- 热度数据库回归用例覆盖降级、来源名称、只有信号时退出候选、只修旧记录时仍要求重算、重发幂等，以及仅合格文章恢复 editorial。
- 发布数据库用例覆盖后台改配置排队、低分与缺分退出池/搜索、边界分保留、详情仍可读、高分精选保留。
- 数据库回归测试没能运行：连接新命名的 `psyhot_pool_bluesky_test` 时返回 `connect EPERM 127.0.0.1:5432`，没有碰现有库。
- 网页测试执行结果 7 通过、9 失败；9 个失败均因 HTTP stub 无法监听，报 `listen EPERM 127.0.0.1`。不能记成网页测试全过。
- Docker socket 也被拒绝；未启动站点、未运行 smoke。待 GitHub CI 用新建空 `_ci` 库跑完整检查。

## 后续观察

- 未来 3 个完整自然日统计每日全部动态与 PsyArXiv 入池量，记录滚动窗口和首尾不完整日期。
- 一周后复核 Bluesky 采集量与热点榜前 10 的覆盖情况；不把停用后的预期变化提前写成实测结果。
- 预印本定向分类另立需求和读取层设计，沿用现有 publication 数据，不删除历史低分记录。

## 恢复后的执行顺序

1. 核对最新 main 并 rebase，冲突停止；将本地各项独立提交放入同一个草稿 PR，跑现有 GitHub Check（新建空 PostgreSQL 库、后端测试、网页测试、build、smoke、Docker）。全部通过后才安排上线。
2. 先备份数据库、配置和容器镜像并记录回滚点，按 10-22 上线流程部署已审核代码。此次没有新数据库迁移。不得重跑旧的历史去重修复方案。
3. 先做以下只读导出；输出目录自行替换为该次备份目录，不把生产材料提交 Git：

   ```bash
   cd ~/psyhot
   docker compose exec -T worker node scripts/psyarxiv-pool-audit.ts > /private/backup/psyarxiv-pool.json
   docker compose exec -T worker node scripts/bluesky-follower-audit.ts > /private/backup/bluesky-followers.csv
   ```

4. 第 0 项可在备份后独立修正。下面事务对旧 kind 写审计，保留每条被改记录的身份，随后必须手动执行 `computeHotRanking()`：

   ```sql
   BEGIN;
   WITH changed AS (
     UPDATE story_signals ss SET kind = 'signal'
     FROM sources s
     WHERE s.id = ss.source_id AND s.participation_mode <> 'editorial' AND ss.kind = 'editorial'
     RETURNING ss.story_id, ss.article_id, ss.source_id
   )
   INSERT INTO audit_log (actor, action, subject, reason, before, after)
   SELECT 'ops:2026-10-24-signal-kinds', 'story_signals.reclassify', 'sources:non-editorial',
          'Sync historical heat evidence with source participation',
          jsonb_build_object('kind', 'editorial', 'records', coalesce(jsonb_agg(to_jsonb(changed)), '[]'::jsonb)),
          jsonb_build_object('kind', 'signal', 'count', count(*))
   FROM changed;
   COMMIT;
   ```

5. 核对 story 608 的新榜单 `sourceNames` 没有小红书关键词信源；保留 before/after 和 smoke 结果。
6. 把近 14 天分布、各桶样本交给站长确认下限，再修改 `industry/sources.json` 的 PsyArXiv 配置；线上配置变更写 audit_log、重新发布。未确认前不赋值。
7. 把 Bluesky CSV 交给站长确认具体名单，再改本地配置和线上 enabled。先备份这些 source 行，线上审计 actor 用 `ops:2026-10-24-bluesky-prune`；不删账号、文章或热度记录。
8. 已补公开日志和根目录本地详细日志；后续只记录真实观察到的 3 日动态量和一周热点覆盖，不提前报告未来指标。

## 公开日志待上线文案

- 热点榜的来源显示更准确，讨论信号不再误显示为正式报道。
- 只有下限真正应用后增加：全部动态和搜索不再列出未达到收录下限的预印本。
- 不写“仍可在主题页和搜索中找到”。当前未更新 `industry/changelog.json` 和 latestVersion，避免把尚未上线的效果发布给读者。
