# 精选与校准

## 一条资料怎么变成精选

1. **收进来**：同一网址、同一内容只留一份。只有标题或订阅摘要的，先抓原文页面再判断。
2. **预筛**（`prefilter.md`）：这是不是本行业的事。宽进，只拦明显无关的：`BLOCK` 的资料不出现在任何公开页面；`PASS` 和拿不准的 `UNKNOWN` 继续往下走。
3. **评分**：先按 `selection-score.md` 独立打两次分（0–100），与结构化同时进行。业界沿用两次之和 ≥ 2 × 分级门槛，显示两次平均分（向下取整）。学界条目在两次评分成功、均分 ≥30、不是推广时，再按 `selection-dims.md` 用思考模型打一次五维分；五维各 1–4，显示分为 `Math.round((五维和 − 5) / 15 × 100)`，按学界门槛判断。
4. **写标题摘要**：入选的和差一点入选的（分数高于 `understandFloor`），按 `content-understanding.md` 写中文标题、答案先行的摘要、推荐理由和标签；其余的按 `summarize-*.md` 写简短的标题摘要，进“全部动态”。走五维的用最终显示分，其余保留两次旧评分均分的边界。
5. **结构化**（`structure.md`）：分类、标签、主体公司、事实（谁、做了什么、对什么），和评分同时进行。主题页和事件归组靠它。
6. **归组**（`group-*.md`）：不同来源报道的同一件事归成一个事件，事件页有综述（`story-digest.md`），“热门”按事件排。入选的资料要等归组完成（最多 3 分钟）才出现在精选里，避免同一件事先冒出好几条。
7. **日报、周报、月报**（`report-*.md`）：每天 08:00 出日报（前一天 08:00 到当天 08:00 的精选候选），每周一 10:00 出上周周报，每月 1 日 10:30 出上月月报。资料进入站点后若跨过刊期边界才确定精选公开时间，便归入下一期候选池；截止前已确定公开时间、但仍在提交的发布事务，取稿会等它提交后再读取，避免漏过前后两期。最终刊载仍受同一事实去重和版面容量限制。

每一步的提示词都在 `industry/prompts/`，改提示词不用改代码。提示词的版本就是它内容的哈希：改了提示词，之后的新资料按新版判断，已经判过的不会重算。

## 门槛：`industry/selection.ts`

```ts
export const SELECTION = {
  thresholds: { T1: 60, T1_5: 65, T2: 76 },   // 两次评分的平均至少要到这个数
  academicDims: {
    enabled: true,                            // 关闭后恢复旧规则，已有结果保留
    gate: 30,
    thresholds: { T1: 60, T1_5: 65, T2: 67 }, // 五维和分别至少 14、15、15
  },
  understandFloor: 50,
};
```

官方一手信源（T1）门槛低一些，媒体和个人（T2）门槛高一些：同样一件事，官方原文更值得先看。没有门槛的分级（`EXCLUDE_MP`）不参与精选。

旧规则的分级门槛来自框架原配置。学界五维门槛由站长在 2026-10-29 上线交接中批准；模型、数据记录、回滚和来源见 [学界五维评分](academic-dims-scoring.md)。没有过粗筛线、推广、评分被拒绝和关闭开关时均保留原规则。

## 业界角色评分与热点通道

`FEATURES.industryRoleScoring` 默认 `false`；关闭时沿用现有精选、筛选和展示。打开后，业界非推广条目在结构理解和两次旧评分之后，用 `selection-roles.md` 一次评估五个角色，不以旧分做粗筛。学界、推广、预筛 BLOCK 和只有标题的材料不跑这一步。

角色分 = `rel + act + nov + 3 × 结论分`，范围 3–18；`must`、`maybe`、`skip` 的结论分分别为 2、1、0。角色入选须结论不是 `skip` 且达到门槛：咨询与治疗（counselor）11、精神科医护（psychiatry）12、青少年心理（school）10、社工与热线（community）10、机构与产品（operator）11。任一角色入选，且通过原有相关性和发布门，即进入业界精选；`selected_roles` 只记录实际入选的角色。数字来自 **2026-11-08 导师标注与近四周离线测试**，目标是每个角色每周约 1–2 条。提示词和这些门槛均已固定。

`analyses.score` / `publications.score` 仍保留两次旧评分均分，用于热度质量、报道查找与排序。浏览标签改为 `rel >= 2` 的角色，按角色分降序，同分按 `ROLE_KEYS` 顺序，最多三个；有角色入选或旧均分高于 `understandFloor` 时使用精选写法。没有新步骤结果的条目沿用结构理解的浏览标签。开关打开时，业界卡片与详情隐藏 AI 评分，学界照旧；按角色看精选用 `selected_roles`，全部动态用 `roles`。新 `hotPick`、`selectedRoles` 字段只给站内接口，公开 v1 / MCP 不加字段。

热点通道在每次定时计算热榜之后运行，不改热榜排序或报道查找条件，也不调用模型：首次报道在最近 **7 天**、且没有任何已入选发布（角色精选、学界精选都算）的事件，在 `HOT.windowHours`（当前为 7 天）内达到 **8 个独立参与方**，且至少有一个 editorial 参与方时，若有业界、非推广、公开、eligible、尚未入选的发布，其角色评分最大 `rel >= 2`、通用 `nov >= 2`，则选最大 rel 最高、同分最早的一条重新发布。参与方按 `story_signals.participant_key` 去重，排除 `articles.duplicate_of` 非空的报道。每个事件最多一次，热度回落后保留；热点入选不增加 `selected_roles`，沿用已有写法，卡片显示“热点”。

`0060_industry_role_scoring.sql` 只增加默认空的 `selected_roles`、默认 false 的 `hot_pick` 和热点入选记录表，不回填。启用后的历史处理使用 `scripts/rerun-role-scores.ts`，默认 `--days 28 --concurrency 3 --tag role-scores-2026-11`，可传 `--limit`；先用 `--dry-run` 查看范围。线上评分和脚本都记录 `output.roleScoring.promptVersion`，脚本只重跑版本缺失或不同的条目；版本相同的条目无论是否有 `rerunTag`、tag 是否相同都跳过。脚本只跑角色评分，合并最新分析并重新发布，最后执行一次热点通道；报告已入选但没有精选写法的数量，不自动补写。开关关闭时包括 dry-run 在内都拒绝运行。

## 校准

### 1. 准备样本集

从你自己的信源里挑 100–200 条资料，一条一条标“该选 / 不该选”，存成 `.data/gold.jsonl`（`.data/` 不进 Git）。每行一条：

```json
{"caseId":"law-001","material":{"title":"原文标题","originalTitle":null,"publishedAt":"2026-10-01T09:00:00+08:00","sourceName":"信源名称","bodyZh":null,"bodyOriginal":"正文……"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"zh"},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"regulation"},"gold":{"decision":"select"}}
```

| 字段 | 说明 |
|---|---|
| `caseId` | 唯一编号 |
| `material` | 标题、原标题、发布时间、信源名、正文（中文正文放 `bodyZh`，原文放 `bodyOriginal`，有一个就行） |
| `sourceFacts` | 信源类型、分级、是否一手、语言，可选的 `track`（`academic` / `industry`，条目属于哪一边）。分级和视角决定用哪个门槛 |
| `samplingContext` | 可选。`benchmarkSplit` 分开发集和留出集，`samplingStratum` 是你自己的分组（比如“新规”“判决”“营销”），看错在哪一类 |
| `gold.decision` | `select` 该选，`reject` 不该选，`either` 两可（不计入准确率） |

`industry/gold.example.jsonl` 有两条示例。

也可以在后台标：内容详情页有“该选 / 不该选 / 两可”，“标注”页是待标注队列（`scripts/sample-labels.ts` 从真实条目里抽样放进去，之后每周一自动补一批复核样本：被识别为推广的、预筛拦掉的、分数在门槛附近的）。标注页可以导出成上面的格式，存成 `.data/gold.jsonl` 直接评测。

几条建议：

- 多放**难例**：差一点就该选、差一点就不该选的。一眼就能判断的放太多，准确率会虚高。
- 分出一部分做**留出集**（`benchmarkSplit: "holdout"`），调提示词只看开发集，最后再用留出集检查一遍，免得把提示词调成只会做这几道题。
- 标注的人最好就是以后读这个站的人，或者和他们口味一致的人。

### 2. 跑评测

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "第一版评分标准"
```

对每条样本跑一遍预筛和两次评分，输出：

- 准确率、查准率（选出来的有多少是对的）、查全率（该选的有多少选上了）；
- 门槛从 40 到 90 每隔 2 分，各自会得到什么结果；
- 判错的条目，完整报告写到 `.data/eval/`，同时导入后台 SelectBench。

**评测范围**：`scripts/eval-selection.ts` 和 SelectBench 的 `stages: "selection"` 仍然只覆盖第一段，暂未覆盖学界五维第二段，后续单独处理。

默认不传 `--models` 时，评测跟随当前 production 的“精选评分”模型路由（后台切换、`SCORE_MODEL` 或默认模型）；`--models default,deepseek-flash` 可显式比较几个模型。其他常用参数：`--n 200` 最多抽多少条，`--split holdout` 只跑留出集。

同次评测中，若不同标注样本渲染出完全相同的评分输入，只共享模型评分结果，各样本仍按自己的预筛结果、信源分级门槛和 gold 独立计分；失败结果也在该次运行内共享，避免并发首跑和缓存重跑得到不同的评测覆盖。重复运行会复用已有回执。报告的 token usage 与平均 latency 按相关回执的全部 provider attempts 汇总，因此解析失败后的重试不会漏计；缓存重跑显示的是这些回执的累计历史用量，不代表本次新增费用。

### 3. 看错例，改标准，再跑

在后台 SelectBench 里逐条看判错的资料和模型给的理由：

- 该选没选上，多半是评分标准里没说清它为什么重要：在 `selection-score.md` 里把这类价值写进“必须正常评价”的部分，给出例子。
- 不该选却选上了，多半是噪声没压住：写进“必须压住”的部分。
- 整体偏松或偏紧，而判错的条目分数都贴着门槛，再调 `industry/selection.ts` 的门槛。

先改标准，再动门槛：门槛只能整体移动，解决不了“哪一类判错了”。每改一次跑一遍，SelectBench 里能看到每一版的对比。

## 换模型

后台“模型与评测”页能看到每一步当前用哪个模型、近期的成功率、耗时和 token 用量，也能直接切换（只影响之后的新任务）。换评分模型之前，先用 `--models` 在同一批样本上比一比。

## 后台标注队列的快照与并发

后台“标注”页沿用五类队列：`sample`、`promotion`、`blocked`、`near_threshold`、`manual`。入队时按文章 ID 稳定分到 80% 的 `development` 和 20% 的 `holdout`；队列行同时保存文章正文、来源事实、PsyHOT 视角、最新分析结果和公开投影的上下文快照。后续文章修订不会改写这份快照，导出的 gold JSONL 因而可以复现当时的判断输入。

标注按钮和备注保存会带上行版本号。两个后台页面同时编辑同一行时，后提交者会收到冲突并需要刷新，避免覆盖前一个人的决定。备注只留在后台和审计记录中，不写进 gold JSONL；未标注行也不会出现在导出文件中。导出链接支持 `queue`、`split`、`decision` 筛选，`decision=unlabeled` 返回空文件。

迁移 `0050_selection_label_context.sql` 只给已有 `0042_selection_labels` 队列增加快照、操作者、版本和更新时间字段，不改公共精选门槛，也不触发发布或模型调用。
