# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 固定微信公众号 | 自建 WeRSS，以及后端 `WECHAT_RSS_BASE_URL` |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

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

### mp_account（固定公众号，WeRSS）

```json
{ "werssFeedId": "MP_WXS_12345", "wechatBiz": "MTIzNDU=", "nickname": "公众号名称" }
```

固定公众号只读取 `WECHAT_RSS_BASE_URL` 指向的自建 WeRSS 缓存 RSS；这个地址由后端部署配置提供。
WeRSS 自己维护微信登录及采集任务，PsyHOT 不接收微信 Cookie。
每条文章必须匹配账号 `__biz`、原文链接和发布时间，入库后沿用正文分析、筛选和归组队列。
未授权、空缓存、错误账号及验证页会记为采集异常，不会切换 EveryInfra 或 Dajiala 付费补抓。
`industry/wechat-werss.json` 保存账号映射；`verifiedInWeRSS=false` 的补充账号要在 WeRSS 中核验身份。
原 `ghid`/`wxid` 可保留作身份线索，不再触发付费列表或正文调用。

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

小红书笔记的点赞、收藏、评论、转发数随列表一起存进 `articles.raw`，热点榜用它们给参与方加权
（`industry/selection.ts` 的 `HOT.engagement`，最多 2 倍，没有互动数据的参与方仍是 1）。公众号列表
不带阅读数和点赞数，取传播数据要对每篇文章单独付费，目前没有开。

### X 主题检索（EveryInfra）

`json_list` 使用 `adapter: "everyinfra_x"`、`everyinfraAction: "search"`，
`everyinfraParams: { "keyword": "(psychology OR neuroscience) research" }`。
也支持 `user_posts`，参数是 `username`。检索结果沿用 `x:<推文ID>` 判重、作者、正文与互动计数，
默认主题发现信源为 `hot_signal`，参与现有事件归组与热度，不把讨论帖自动当作独立报道。
当前 API 偏向 Top 结果，不提供完整 Latest 时间水位保证。付费调用仍受回执和预算限制。
EveryInfra 信源的采集间隔由运营配置，自动频率调整不会加快其付费轮询。

### Bluesky（`json_list` 的 `bluesky_feed` 适配器）

```json
{ "url": "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:xxxx&limit=30&filter=posts_no_replies", "adapter": "bluesky_feed" }
```

读 Bluesky 的公开接口，不需要 key。`actor` 用账号的 DID（`did:plc:…`，改名不受影响）。每条帖子以它在 bsky.app 的地址入库，转发也算（日期按转发时间）；帖子带的链接卡片、正文里的链接、引用帖子的链接都写进正文。只有图片或视频、没有文字和链接的帖子跳过。这类信源一般设成 `hot_signal`。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **同一参与方** `signal_group_id`：同一个机构的几个信源（它的期刊、它在 Bluesky 上的几个账号）填同一个值，热度里只算一个参与方。比如一个学会在社交媒体上宣传自家期刊的论文，不算“另一方也在关注”。
- **热度证据怎么挂上事件**（`hot_signal`）：先看帖子回复或引用的是不是已收录的帖子；再看它带的链接是不是指向已收录的报道（按网址，或按 DOI：doi.org 链接能对上出版社地址的论文）；都不是，才按文本相似度找最接近的事件。前两种不调用模型。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 只有标题的期刊条目：补摘要

有些期刊的订阅源只给标题和作者（ScienceDirect 给出版日期、来源和作者，Taylor & Francis 的摘要字段为空），原文页面又有机器人验证，抓不到正文。这样的条目只跑预筛、不评分、不写摘要，不会出现在站上（`editorial/writing.ts` 的 `thinText`）。

采集开启时，worker 每 20 分钟为这类近 45 天的条目查一次开放的学术元数据，依次是 OpenAlex、Europe PMC、Crossref：链接里有 DOI 就按 DOI 查，ScienceDirect 的链接先用 PII 在 Crossref 换成 DOI，都没有就按标题精确匹配。查到的摘要作为新版本写进条目的摘要字段，条目会重新完整分析。数据库收录有延迟，查不到的按 6 小时、1 天、3 天、7 天、14 天重试，之后放弃。记录在 `abstract_lookups` 表里。这些都是免费的公开接口，不需要 Key；`industry/site.ts` 里填了 `contactEmail` 的话，查 Crossref 和 OpenAlex 时会带上这个邮箱，进它们限流更宽的“礼貌通道”。

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

### 部署 WeRSS 私有服务

在服务器 `.data/werss/runtime.env` 中设置随机 `SECRET_KEY`、`USERNAME`、`PASSWORD`，
以及 `WERSS_AUTH_WEB=True`（公众号后台扫码）、`HEADLESS=true`、`GATHER.MODEL=weread_mp`、`GATHER.CONTENT=True`、`THREADS=1`。
微信读书需要在 `/weread` 单独扫码授权，公众号后台授权不等于微信读书授权。
服务启动及每半小时会用正常浏览器访问书架维护会话，并通过书架接口验证后保存新的凭据；
验证失败只记录状态，不把缓存的“已登录”当作有效授权。
PsyHOT 的 `.env` 设置 `WECHAT_RSS_BASE_URL=http://werss:8001`。

```bash
docker compose -f docker-compose.yml -f deploy/werss.compose.yml --profile werss up -d werss
```

管理页只绑定服务器 `127.0.0.1:8001`，经 SSH 转发访问；不要向公网开放。
固定账号映射会导入 WeRSS，日常微信采集为北京时间 09:15、18:15；PsyHOT 每 30 分钟读取缓存。
微信读书每次只获取最新一篇，无法回补历史，轮询之间多次发布可能漏文。
私有实例会从正文校验公众号 `__biz`、原始发布时间和原文长链接；空正文记录下次仍重试，
完整且已核验的记录不重复取正文。失效授权或 429 会暂停后续账号半小时，新扫码后可解除暂停。
登录状态与标题测试不能证明阅读权限有效，须验证正文。原公众号后台 `web` 模式出现 200013 时全局冷却六小时，禁止轮换账号或密集重试。
未通过真实文章验证前，只能报告配置就绪，不能报告微信采集恢复成功。
