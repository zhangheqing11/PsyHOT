# 业界信源清单与接入记录

| 项 | 值 |
|---|---|
| 状态 | 2026-10-05 接入 33 个（站长选定首批全部和可选 12 个中的 11 个；Counseling Today 抓不到） |
| 测试方式 | 从线上香港服务器，用本站抓取器的 UA（`PsyHOTBot/1.0`），在 worker 容器里用后台“试抓”同一套代码预览；遇到反爬、验证码、登录的一律记为不可用，不绕过 |
| 配套规划 | `tracks-academic-industry.md` 第 7 节 |

“近 30 天”是测试时页面或订阅里能看到的条数。综合类来源（WHO、FDA、网信办、OpenAI 等）里大部分内容和心理无关，由预筛拦下，每条只花一次预筛调用。

## 1. 已接入

### 国内

| 信源（id） | 方式 | 分级 · 参与 | 近 30 天 | 说明 |
|---|---|---|---|---|
| 中国政府网 政策文件库 · 心理 / 精神卫生 / 精神障碍 / 精神药品（`json-govcn-policy-*`，4 个） | `json_list`，`sousuo.www.gov.cn/search-gov/data`，取“部门文件” | T1 · editorial | 合计 1–2 | 部委文件会同步到这里，替代对抓取返回 412 的卫健委、药监局官网，例如《健全社会心理服务体系和危机干预机制实施方案》（国卫医政发〔2026〕8号）、精神药品目录调整公告。检索是模糊匹配，“心理”会带进少量含“中心”“管理”的无关文件，由预筛拦下。接口只有正文开头，开了 `fetchPublicContent` 取全文 |
| 国家网信办 · 政策法规（`web-cac-zcfg`） | `web_list` | T1 · editorial | 约 15 | 人工智能拟人化互动、未成年人网络保护等 |
| 国家心理健康和精神卫生防治中心 · 通知公告、中心动态（`web-ncmhc-*`，2 个） | `web_list` | T1 · editorial | 约 4 | 标题含采购、招聘、录用、成交、中标、询价、公示、比选的直接丢弃 |
| 中国心理学会 · 通知公告（`web-cps-notice`） | `web_list`（首页是 frameset，直接取 `cms/show.action` 地址） | T1 · editorial | 约 36，过滤后很少 | 会议通知、年会、征文、申报类标题直接丢弃；含伦理、守则、标准、规范、声明、倡议、共识的保留。条目链接到公众号文章，香港服务器能打开并取到正文 |
| 注册系统 · 重要通知、最新资讯（`web-chinacpb-*`，2 个） | `web_list` | T1 · editorial | 约 3 | 注册标准、伦理守则征求意见、从业资质 |
| 中国网·心理中国 · 要闻、行业资讯、政策信息（`web-psychina-*`，3 个） | `web_list`（用 http，https 证书不匹配） | T2 · editorial | 约 70（三个栏目有重叠，同一链接只存一份） | 国内最稳定的心理行业新闻源，也混有科普和地方宣传稿，靠 T2 门槛筛 |
| 健康报（`web-jkb-news`） | `web_list`，新闻中心页；日期和完整标题从文章页的 `crtime`、`title` 取 | T2 · editorial | — | 国家卫健委主管的行业报，心理相关很少 |
| 36氪（`rss-36kr`） | `rss` | T2 · hot_signal | 约 150 | 只作热度信号 |

### 国际

| 信源（id） | 方式 | 分级 · 参与 | 近 30 天 | 说明 |
|---|---|---|---|---|
| Behavioral Health Business（`rss-bhbusiness`） | `rss` | T2 · editorial | 约 100 | 美国行为健康行业：融资、并购、关停、支付方政策 |
| STAT · 心理健康（`rss-stat-mental-health`） | `rss` + `fetchPublicContent` | T2 · editorial | 约 9 | 摘要短，取正文（付费墙文章取不到时只用摘要） |
| MedPage Today · 精神科（`rss-medpage-psychiatry`） | `rss` | T2 · editorial | 约 40 | |
| The Guardian · 心理健康（`rss-guardian-mental-health`） | `rss` | T2 · editorial | 约 55 | |
| Psychiatric Times（`rss-psychiatric-times`） | `rss` | T2 · editorial | 约 200 | 订阅把 CDATA 包装又转义了一层，解析器已修 |
| Psychedelic Alpha（`rss-psychedelic-alpha`） | `rss` | T2 · editorial | 约 15 | |
| 美国 FDA · 新闻稿（`rss-fda-press`） | `rss` | T1 · editorial | 约 11 | |
| 美国 FTC · 新闻稿（`rss-ftc-press`） | `rss` | T1 · editorial | 约 20 | |
| 欧洲药品管理局 · 新闻（`rss-ema-news`） | `rss` | T1 · editorial | 约 8 | |
| WHO · 新闻（`json-who-news`） | `json_list`，`who.int/api/news/newsitems`（官方 RSS 已停更） + `fetchPublicContent` | T1 · editorial | 约 60 | 接口没有摘要，取正文 |
| NICE · 新闻（`web-nice-news`） | `web_list`，`/news/articles` | T1 · editorial | 约 5 | |
| 美国精神医学学会 · 新闻稿（`web-psychiatry-org-news`） | `web_list` | T1 · editorial | 约 3 | |
| 英国皇家精神科医学院 · 新闻（`web-rcpsych-news`） | `web_list`，日期取自链接 | T1 · editorial | 约 13 | |
| BACP · 新闻（`web-bacp-news`） | `web_list` | T1 · editorial | 约 16 | |
| OpenAI · 新闻（`rss-openai-news`） | `rss` | T1 · editorial | 约 68（相关 1–2） | 订阅里有 1246 条历史，首次导入只取 5 条 |
| Anthropic · 新闻（`web-anthropic-news`） | `web_list` | T1 · editorial | 约 10 | |
| Character.AI · 博客（`rss-characterai-blog`） | `rss` | T1 · editorial | 约 3 | |
| BBC · 健康（`rss-bbc-health`） | `rss` | T2 · hot_signal | 约 33 | 只作热度信号 |

## 2. 重点站点的尝试结果

| 站点 | 拦截方式 | 试过的路 | 结论 |
|---|---|---|---|
| 国家卫健委 | 瑞数 WAF：所有非浏览器请求返回 412 和 JS 挑战，从大陆网络也一样 | 英文站 en.nhc.gov.cn（能访问，每月几条，几乎没有心理内容）；中国政府网政策文件库（能取到部委文件）；健康报（主管报纸） | 文件走政府网检索；新闻靠健康报、心理中国、国家心理健康和精神卫生防治中心覆盖。剩下的缺口只能靠官方公众号（付费） |
| 国家药监局 | 瑞数 WAF，同上；药审中心 403，器审中心也是瑞数 | 英文站（只有规章和外事新闻，没有具体药品审批）；政府网检索“精神药品”（能取到精神药品目录调整公告）；《中国医药报》cnpharm.com（国庆期间首页是放假占位，文章页 404） | 精神药品管制走政府网检索。具体新药获批（如失眠药）暂无免费渠道，节后复测中国医药报 |
| 健康界 | 阿里云 WAF 的 `acw_sc__v2` JS 挑战 | 订阅地址、移动站都没有 | 不绕过；只能走它的公众号（付费） |
| 中国心理卫生协会 | 2026-10-03 后对境外出口一律返回 416（之前从香港能抓到；站长手机在大陆网络能打开） | 换 UA 无效，真实浏览器经 VPN 也是 416，说明按出口地区拦截，不是识别爬虫 | 现有信源保持开启并自动重试，节后看是否恢复。不恢复的话有三条路：Mac 定时抓取后推送到 `/api/ingest/items`（需要 VPN 对该域名直连、服务器配 `INGEST_TOKEN`、Mac 开机）；大陆云函数中转；公众号（付费） |

## 3. 测过、不能用的

| 来源 | 结果 |
|---|---|
| 美国心理学会 APA（apa.org、apaservices.org） | JS 验证页 |
| SAMHSA、CMS、NAMI、MobiHealthNews、Healio、Digital Health（英国）、澎湃新闻 | 403 或 Cloudflare 验证 |
| 动脉网 | 前端渲染，列表里拿不到内容 |
| 医脉通 | 需要登录 |
| Counseling Today（ACA） | 文章列表由前端渲染，没有订阅源；要用付费的 Jina 渲染才能抓，服务器没有配 Jina |
| NIMH 新闻 | 前端渲染，没有日期，也没有订阅 |
| BPS（英国心理学会）新闻 | 列表没有日期，要逐篇抓详情页，暂不接入 |
| GOV.UK 关键词订阅 | 关键词过滤不生效 |
| 人民网健康 RSS、OPEN MINDS | 已停更 |

## 4. 公众号（付费，等站长决定）

系统已支持 `mp_account`（极致了），按次计费：查一次文章列表 ¥0.14，取一篇正文 ¥0.03。按默认节奏（最多每 3 小时查一次），每个号约 ¥35/月，经过回执和预算熔断。能补上面缺口的候选：国家卫健委、国家药监局、健康界、中国心理卫生协会的官方号。具体账号在后台用接口核实 ghid 后再定。

## 5. 不收录：公司自有渠道

简单心理（新闻接口）、好心情（企业资讯页）等公司官网能抓到，但内容以课程上新、品牌联名、校友活动为主。公司的重大事件（融资、并购、关停、处罚）会被行业媒体报道，从媒体进来更客观。

## 6. 之后要做的

- 节后（10 月 8 日以后）复测中国心理卫生协会和《中国医药报》。
- 跑 1–2 周后看各源的入选数，用站长标注的业界样本校准 T2 门槛（目前 76）。
- `tracks-academic-industry.md` 第 7 节第 2 步：评分提示词补业界的“重要”和“噪声”例子，新增“政策”类。
