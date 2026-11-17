# 期刊常规接入与引用补收评估（2026-11-17）

基于 main e80f289 的现行筛选流程；生产只读核对，本次没有新增生产信源或部署。

| 期刊 | 样本 | 摘要可评 | 全部动态 | 精选 | 精选中缺原论文 | 建议 |
|---|---:|---:|---:|---:|---:|---|
| Psychotherapy and Psychosomatics | 19 | 17 | 17 | 6 | 6 | 优先加入 |
| British Journal of Health Psychology | 19 | 17 | 17 | 0 | 0 | 第二批／暂以引用补收覆盖 |
| Computers in Human Behavior | 20 | 3 | 2 | 0 | 0 | 暂缓常规接入，先改善摘要获取 |
| Journal of Medical Internet Research | 20 | 19 | 8 | 3 | 3 | 建议加入，沿用心理健康预筛 |
| Journal of Affective Disorders | 20 | 18 | 18 | 1 | 1 | 第二优先级，可小规模接入 |
| Science | 20 | 10 | 0 | 0 | 0 | 维持按需补收，不接全刊 |
| Personality and Social Psychology Review | 1 | 1 | 1 | 0 | 0 | 已接入，保留；无需重复新增 |
| The Lancet Psychiatry | 20 | 7 | 7 | 5 | 3 | 已接入，优先补在线发表入口 |

取样：Crossref 2026-08-19～2026-11-17可见的journal-article元数据，按发表日期降序最多20条/刊；不足则全取。Crossref、Europe PMC、OpenAlex补摘要，缺摘要不计作0分/不相关。139条中92条可评，70条进入内容池，15条达到精选，13条未找到独立原论文条目。样本非人工金标准，可评子集有获取偏差，不能据此断言整刊质量或长期入选率。

- **Psychotherapy and Psychosomatics**：17篇有完整摘要的样本均通过预筛，6篇达到精选，且6篇原论文均未入库；包含随机试验和元分析，能补治疗与临床研究。
- **British Journal of Health Psychology**：17篇均可进入全部动态，但本次0篇达到精选；健康心理学相关性高，当前门槛下首页增量未显现。
- **Computers in Human Behavior**：20篇仅3篇取得足够摘要，不能用0篇精选评价整本期刊；已有报道中的重要论文可由按需补收覆盖。
- **Journal of Medical Internet Research**：19篇可评，8篇通过预筛，3篇精选且均缺原论文；11篇不相关内容被现有预筛拦下，不需放宽门槛。
- **Journal of Affective Disorders**：18篇均通过预筛，1篇精选且缺原论文；精神卫生相关性高，但本次大部分样本属于较窄的相关/机制研究，精选产出较低。
- **Science**：10篇有足够摘要的样本全部被预筛挡下；综合科学期刊的非心理学内容多，引用补收更适合拾取其中重要脑科学论文。缺摘要的10篇未计入阻挡比例。
- **Personality and Social Psychology Review**：90天可见元数据仅1篇，样本不足以评价整刊。上轮缺失论文发表于2025年8月，公众号在2026年11月解读，按需补收可覆盖这种时间差。
- **The Lancet Psychiatry**：7篇可评中5篇精选；2篇原论文已存，3篇缺失。最近3次RSS采集都返回15条、0新增，最新发现条目停留在10月14日；健康正常不代表覆盖完整。

覆盖核验处理了DOI、PII与[Articles]等栏目标题前缀。Lancet的两篇高分样本已入库，三篇未入库。不能把原论文缺失解释为该研究没有任何二手报道。

新增推荐顺序：P&P、JMIR；并行修补Lancet在线发表入口；JAD第二批，BJHP非优先；CHB先改善摘要，Science使用按需引用补收。PSPR与npj Mental Health Research已接入，无须重复注册。常规信源接入仍需站长选择，本PR不改industry/sources.json。

自动补收实现见[机制说明](../paper-backfill.md)。9篇真实报道的引用全部通过免费元数据核验，摘要与精确日期均找到。431条模型回执估算¥0.8342，按高峰且无缓存折扣上界¥4.0942；均低于本地¥10预设上限。所有付费请求保留回执；未向生产写入，未触发邮件/飞书/推送。

官方接口依据：[Crossref](https://github.com/CrossRef/rest-api-doc)、[Europe PMC](https://europepmc.org/RestfulWebService)、[OpenAlex](https://docs.openalex.org/api-entities/works/work-object)、[DeepSeek价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。
