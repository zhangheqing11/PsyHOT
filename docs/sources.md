# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 固定微信公众号 | EveryInfra 的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

所有类型都可设 `config.poolMinScore`（0–100 的数字）：只有评分达到这个下限的条目才进入全部动态，
没有评分的也不进入。不设时保持原有规则。该条件作用于发布层的 `eligible`，因此站内搜索及其他读取
全部动态的出口也会排除这些条目；主题页只列精选，本来就不列低分预印本。详情页仍按原有参与方式和
可见性规则提供。不要把它当作精选门槛：精选仍按原有规则判断，实际配置应低于精选门槛。
后台修改配置会自动排队重新发布；脚本或 SQL 修改配置后需运行 `republishSource(id)`，不调用模型。

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

BMJ Open 的官方 `https://bmjopen.bmj.com/rss/current.xml` 是 RDF RSS，`dc:subject` 带有期刊栏目；PsyHOT 的 BMJ Open 信源只允许 `Open access, Mental health`，不抓整本期刊。
RSS、网页列表和 JSON 信源都使用站点标识明确的默认抓取身份；需要某个官方接口识别信源时，可以在该信源配置
`userAgent` 覆盖身份（例如 `PsyHOTBot/1.0`）。这个值应继续说明抓取者，不要伪装成浏览器或其他爬虫。

RSS 标准日期缺失或不可解析时，解析描述开头的明确出版日期，如 ScienceDirect 的
`Publication date: Available online 21 October 2026` 或 `Publication date: 1 February 2026`。
只接受完整的英文日/月/年，按 UTC 零点存储；月份、日期区间、接收/修改时间或未知格式保持空值，不用发现时间替代。

### json_list（通用 JSON 列表）

```json
{
  "url": "https://example.org/works.json",
  "itemsPath": "message.items",
  "titlePaths": ["title.0"],
  "urlTemplate": "https://doi.org/{raw:DOI}",
  "publishedAtPaths": ["published-online.date-parts.0", "published-print.date-parts.0", "issued.date-parts.0"],
  "excludePatterns": { "title.0": "^Supplemental Material\\b", "DOI": "\\.supp(?:lement(?:al|ary)?)?(?:[._-]?\\d+)?$" }
}
```

- `publishedAtPaths` 按顺序取第一个能解析的日期，缺值、空值和非法日期会继续尝试下一项。未配置时沿用旧的
  `publishedAtPath` 单一路径；两者同时提供时以 `publishedAtPaths` 为准。现有 `publishedAtUnit`
  （`epoch_s`、`epoch_ms`、`yyyymmdd`）仍适用。
- Crossref 的 `[年, 月, 日]` 数组按 UTC 日历严格校验；缺月或缺日时分别用该月 1 日或该年 1 月 1 日，不能据此声称精确到日。
  所有候选字段都不可解析时日期为空，不默认使用 `created` 或发现时间。
- `excludePatterns` 是“字段路径 → 正则字符串”的映射，忽略大小写；任一字符串字段匹配就在映射和入库前排除。
  非法正则会让本次采集失败；若整批都被明确规则排除，采集成功并返回空列表。排除计数和原因会写入抓取运行详情。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account（固定公众号，EveryInfra）

```json
{ "ghid": "gh_0123456789ab", "wechatBiz": "MTIzNDU=", "nickname": "公众号名称" }
```

每个公众号按自己的抓取间隔拉一次文章列表（一次付费调用）。列表只有标题、链接和时间，没有摘要，
所以每篇新文章再付费取一次正文；`ingestNoiseFilter` 在取正文之前按标题过滤。

- **间隔按发文频率**：发得勤的每天一次，其余每两三天一次（`interval_minutes` 最长 10080）。付费信源不能
  短于 12 小时，数据库约束和后台都会拒绝（`sources/config-keys.ts` 的 `paidIntervalFloor`）。
- **账号核对**：`wechatBiz` 是账号的 `__biz`。列表里的文章必须带这个值；一篇都对不上，说明 `ghid`
  指向了别的账号：这一次只付了列表费，信源标红“公众号身份不符”，一周内不再抓，等人工改 `ghid`。
- **只买新文章**：第一次检查只核对账号、记下位置，不买历史文章的正文（首次导入的存量只会归档，不进“今天”）。
  之后每次只取上次检查以来（留两天余量，最多十天）发布、还没收过的文章，每次最多 8 篇。
- 列表接口偶尔对部分账号返回 503（不计费），一小时后再试。

没有 `ghid` 的账号用 `scripts/resolve-wechat-accounts.ts` 查找（付费：每个账号一次搜索，最多三次候选列表），
只有列表文章的 `__biz` 和 `wechatBiz` 一致才采用；先不加参数看结果，再加 `--apply` 写入（记审计日志）。

公众号候选发现是显式付费操作：

```bash
node --env-file=.env scripts/discover-wechat.ts --keyword 'AI 心理健康' --output /private/path/candidates.json
```

候选结果仅供评估，不会自动成为固定信源或下载历史文章。

### 小红书（EveryInfra）

小红书使用 `json_list` 的 EveryInfra 适配器。配置示例：

```json
{
  "adapter": "everyinfra_xhs",
  "everyinfraAction": "search",
  "everyinfraParams": {
    "keyword": "心理健康 AI",
    "date_range": "last_7_days",
    "sort": "newest"
  },
  "everyinfraDetail": true
}
```

`everyinfraAction` 目前可用 `search`、`user_posts`、`hashtag` 或 `trending`；不同 action 的
参数按 EveryInfra 当前接口契约填写。`everyinfraDetail: true` 会对新发现的笔记追加一次 `note` 调用，
保存正文；关闭时只保存搜索结果的摘要，避免为每条笔记付详情费用。
API key、计费回执和失败重试由后端统一处理。

关键词搜索返回的大多只是“沾边”的笔记（情绪语录、备考资料、课程广告），所以关键词信源都配了
`ingestNoiseFilter.requireMarkers`：标题或摘要里没有其中一个词（研究、期刊、指南、获批、政策……）的笔记
直接丢弃，不进分析链路也不付详情费用；`dropMarkers` 再去掉备考、招募、课程之类。关键词信源只保存搜索
结果里的正文（`summaryIsBody`），固定博主才取详情。`ingestNoiseFilter` 也可以用在 `mp_account` 上，
给“健康中国”这类覆盖面很宽的账号只留心理相关的文章。

小红书笔记的点赞、收藏、评论、转发数随列表一起存进 `articles.raw`，之后的列表再看到同一篇时更新为最新的数
（不算新版本，不重新分析）。热点榜用它们给参与方加权（`industry/selection.ts` 的 `HOT.engagement`，最多 2 倍，
没有互动数据的参与方仍是 1）。公众号列表不带阅读数和点赞数，取传播数据要对每篇文章单独付费，目前没有开。

关键词搜索只是发现渠道：热度里的参与方是笔记的作者（`raw.participant = xhs-author:<作者 ID>`），不是搜到它的
关键词，同一作者的笔记经几个关键词进来也只算一方。X 主题检索同理，参与方是发帖账号。带货笔记（`is_goods_note`）不收。
关键词信源默认作热度证据（`hot_signal`），只用搜索摘要；固定博主进精选，新笔记取一次正文。

EveryInfra 每次调用都计费（约 $0.0056）。`budgets` 表里 `everyinfra` 是总上限，`everyinfra:xiaohongshu`、
`everyinfra:wechat_oa`、`everyinfra:twitter` 是各平台的份额，一个平台用完不影响其他平台；手动运行的公众号候选发现和账号查找用
`everyinfra:discovery`，不占采集的份额。一小时内三次因余额被拒，
这一小时剩下的时间不再调用；充值后自动继续。

### X 主题检索（EveryInfra）

`json_list` 使用 `adapter: "everyinfra_x"`、`everyinfraAction: "search"`，
`everyinfraParams: { "keyword": "(psychology OR neuroscience) research" }`。
也支持 `user_posts`，参数是 `username`。检索结果沿用 `x:<推文ID>` 判重、作者、正文与互动计数，
默认主题发现信源为 `hot_signal`，参与现有事件归组与热度，不把讨论帖自动当作独立报道。
当前 API 偏向 Top 结果，不提供完整 Latest 时间水位保证。付费调用仍受回执和预算限制。
EveryInfra 信源的采集间隔由运营配置，自动频率调整不会加快其付费轮询。

关键词或覆盖面很宽的公众号可以配置 `ingestNoiseFilter.requireMarkers`：标题或摘要至少命中一个标记词才会保留，
并在购买小红书详情或公众号正文前执行；`dropMarkers` 和 `dropMarkersTitleOnly` 随后排除备考、招募、课程等噪声。
抓取运行详情记录每种规则丢弃的条数，便于知道一批内容为何没有入库。

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

### Bluesky（`json_list` 的 `bluesky_feed` 适配器）

```json
{ "url": "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:xxxx&limit=30&filter=posts_no_replies", "adapter": "bluesky_feed" }
```

读 Bluesky 的公开接口，不需要 key。`actor` 用账号的 DID（`did:plc:…`，改名不受影响）。每条帖子以它在 bsky.app 的地址入库，转发也算（日期按转发时间）；帖子带的链接卡片、正文里的链接、引用帖子的链接都写进正文。只有图片或视频、没有文字和链接的帖子跳过。这类信源一般设成 `hot_signal`。

### 网页事件报道（DeepSeek 搜索，`external` 信源 `web-story-lookup`）

不是定时采集的信源，而是热点榜的补充证据。每 6 小时（`hot.web-lookup`），近 3 天评分 50 分以上的事件（入没入选都算：只有我们一个信源报道、在外面却被广泛报道的事件，正是原来漏掉的热度）和热点候选，每次最多查 30 个，用中文标题和原文标题各搜一次 DeepSeek；同一事件 12 小时内只查一次，总共最多 2 次。

- 先按规则筛：没有日期、早于事件首报 3 天以上的不要；论文本身的学术页面（期刊、预印本、PubMed、索引、图书馆代理）不要；自动翻译摘要的镜像站、期刊预测页和机器人帖子不要；我们自己的公众号、小红书报道被搬到网易号、搜狐号的副本不要；已经报道过这个事件的站点不要；标题完全不沾边的不要。
- 剩下的（最多 10 条）交给归组模型判断一次（`industry/prompts/web-coverage.md`），只留真正在报道或讨论这一个事件的网页，最多 5 条。
- 留下的网页存为 `hot_signal` 文章（不分析、不进全部动态和精选），直接记为这个事件的信号。参与方是站点（`web:<域名>`），公众号文章按账号（`wechat:<__biz>`）；同一站点只算一次；几家网站转载同一篇稿子（同一条通稿、同一份新闻稿，摘要前 200 字相似度 ≥ 0.7）也只算一次。
- 预算：`deepseek-tools:search` 每天 150 次。关掉：`WEB_STORY_LOOKUP_ENABLED=false`。

正文兜底：页面直接读不出正文、又没有 Jina key 时，用 DeepSeek 抓取（`deepseek-tools:fetch` 每天 100 次）。站点拒绝了我们（401/403/412/429/451）或有机器人验证（ScienceDirect、卫健委、药监局、健康界）的页面，任何兜底都不去读。关掉：`DEEPSEEK_BODY_FALLBACK=false`。

找新信源：`node --env-file=.env scripts/discover-web-sources.ts ["查询" ...] [--out 报告.md]`，只列出现有信源之外的站点和公众号，不写库。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **同一参与方** `signal_group_id`：同一个机构的几个信源（它的期刊、它在 Bluesky 上的几个账号）填同一个值，热度里只算一个参与方。比如一个学会在社交媒体上宣传自家期刊的论文，不算“另一方也在关注”。
- **热度证据怎么挂上事件**（`hot_signal`）：先看帖子回复或引用的是不是已收录的帖子；再看它带的链接是不是指向已收录的报道（按网址，或按 DOI：doi.org 链接能对上出版社地址的论文）；都不是，才按文本相似度找最接近的事件。前两种不调用模型。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 期刊条目：补原始摘要

有些期刊的订阅源只给标题和作者（ScienceDirect 给出版日期、来源和作者，Taylor & Francis 的摘要字段为空），原文页面又有机器人验证，抓不到正文。这样的条目只跑预筛、不评分、不写摘要，不会出现在站上（`editorial/writing.ts` 的 `thinText`）。

采集开启时，worker 每 20 分钟为摘要缺失的期刊条目补原始摘要，时间范围与摘要翻译一致：按发现时间取近 `ABSTRACT_TRANSLATION_DAYS` 天，默认 3 天。有正文且 `body_status = 'ok'` 的期刊也会检查摘要，但仍在等待正文的条目先等正文提取完成。新闻、公众号和 X 帖子不参与论文摘要恢复。

期刊按顺序尝试已存 HTML、免费获取的出版页、开放的学术元数据。HTML 只接受明确标记的 Abstract 章节或 `citation_abstract` 元数据；Wiley 已存正文另允许完整、短小且严格由 Background / Methods / Results / Conclusions 组成的结构化摘要。无论哪一种，都不会把整篇论文截取后当摘要；无法确认边界或超过 6,000 字符的 HTML 片段会被放弃。出版页不使用浏览器渲染或付费正文回退。

开放元数据依次查询 OpenAlex、Europe PMC、Crossref：链接里有 DOI 就按 DOI 查，ScienceDirect 的链接先用 PII 在 Crossref 换成 DOI，都没有就按标题精确匹配。预印本保留原有的元数据恢复路径：近 45 天、尚无正文且正文提取已结束的条目，不新增出版页抓取。查到的摘要作为新版本写进摘要字段，保留已有正文和正文版本历史，并按原有流程重新分析；已有模型预算和回执规则继续适用。

数据库收录有延迟，查不到的按 6 小时、1 天、3 天、7 天、14 天重试，条目超出对应时间范围后不再补查。记录在 `abstract_lookups` 表里，HTML 恢复的来源记作 `stored_html` 或 `publisher_html`。上述出版页和公开接口不需要 Key；`industry/site.ts` 里填了 `contactEmail` 的话，查 Crossref 和 OpenAlex 时会带上这个邮箱，进它们限流更宽的“礼貌通道”。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- `items` 中每条必须是 JSON 对象；包含 `null`、数组或其他非对象值时返回 400，且不会创建或更新信源，也不会写入条目。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 在后台暂停信源后，推送接口返回 409，不再接收新文章；恢复信源后可以继续推送。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。
