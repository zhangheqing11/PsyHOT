# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
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

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

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
