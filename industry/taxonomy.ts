// 这个行业的分类体系：类别、标签词表、机构（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "research", label: "研究", section: "研究发现", guide: "新的实证研究：实验、调查、队列、脑影像等原创研究结果，包括预印本；不含综述和元分析" },
  { key: "review", label: "综述", section: "综述与元分析", guide: "元分析、系统综述、伞形综述、领域综述，以及大规模重复验证项目和多实验室合作研究的结果" },
  { key: "clinical", label: "临床", section: "临床与治疗", guide: "心理治疗与干预、精神科药物与神经调控、临床试验结果、诊断标准（DSM、ICD）、临床指南与循证建议" },
  { key: "industry", label: "行业", section: "行业与政策", guide: "心理健康政策法规与监管、学会与机构动态、从业资质与伦理事件、科研诚信与撤稿、数字心理健康产品与市场" },
  { key: "method", label: "方法", section: "方法与工具", guide: "研究方法与统计、测量工具与量表、实验范式与数据集、开放科学与预注册实践" },
  { key: "opinion", label: "观点", section: "观点与解读", guide: "学者评论与学术争鸣、理论文章、访谈、科普解读、现象与趋势讨论" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["research_finding", "meta_review", "replication", "clinical_practice", "policy_event", "method_tool", "opinion_explainer"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "研究发现", "元分析/综述", "重复验证", "临床/治疗", "诊断/评估", "政策/监管", "行业动态", "科研诚信", "方法/统计", "测量/量表", "学者观点", "科普解读",
  "其他",
] as const;

/** 可选的主题标签：前半是分支领域，后半是常见议题。 */
export const TOPIC_TAGS = [
  "认知", "社会", "人格", "发展", "临床", "咨询", "健康", "生理/神经", "进化", "组织/管理", "教育", "司法", "积极心理", "跨文化", "决策",
  "抑郁", "焦虑", "创伤/PTSD", "成瘾", "精神病性障碍", "双相", "孤独症/ADHD", "进食障碍", "自杀/自伤", "睡眠", "压力/情绪", "人际关系/孤独",
  "儿童青少年", "老龄化", "数字心理健康", "AI与心理", "心理治疗", "精神药物", "神经调控", "开放科学",
] as const;

/** 可选的实体标签（国际组织、学会、监管与研究机构）。 */
export const ENTITY_TAGS = [
  "WHO", "美国心理学会", "美国精神医学学会", "NIMH", "FDA", "NICE", "国家卫健委", "中国心理学会", "中国心理卫生协会", "中科院心理所", "Cochrane", "开放科学中心",
] as const;

/** 模型常写的近义词，统一成词表里的写法（英文按小写查）。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  研究: "研究发现", 论文: "研究发现", 实证研究: "研究发现", 新研究: "研究发现", 预印本: "研究发现", "论文/研究": "研究发现",
  元分析: "元分析/综述", 荟萃分析: "元分析/综述", meta分析: "元分析/综述", "meta-analysis": "元分析/综述", 系统综述: "元分析/综述", 综述: "元分析/综述",
  重复: "重复验证", 复制: "重复验证", 可重复性: "重复验证", 重复研究: "重复验证", replication: "重复验证",
  治疗: "临床/治疗", 临床试验: "临床/治疗", 干预: "临床/治疗", 疗法: "临床/治疗",
  诊断: "诊断/评估", 评估: "诊断/评估", 筛查: "诊断/评估",
  政策: "政策/监管", 监管: "政策/监管", 法规: "政策/监管", 法律: "政策/监管",
  行业: "行业动态", 机构动态: "行业动态", 学会动态: "行业动态", 融资: "行业动态", 收购: "行业动态",
  撤稿: "科研诚信", 学术不端: "科研诚信", 数据造假: "科研诚信",
  方法: "方法/统计", 统计: "方法/统计", 研究方法: "方法/统计", 量表: "测量/量表", 测量: "测量/量表", 问卷: "测量/量表",
  观点: "学者观点", 评论: "学者观点", 访谈: "学者观点", 科普: "科普解读", 解读: "科普解读",
  认知心理学: "认知", 社会心理学: "社会", 人格心理学: "人格", 发展心理学: "发展", 临床心理学: "临床", 心理咨询: "咨询",
  健康心理学: "健康", 神经科学: "生理/神经", 脑科学: "生理/神经", 认知神经科学: "生理/神经", 生理心理学: "生理/神经", 进化心理学: "进化",
  组织行为: "组织/管理", 工业与组织心理学: "组织/管理", 管理心理学: "组织/管理", 教育心理学: "教育", 司法心理学: "司法", 犯罪心理学: "司法", 法律心理学: "司法", 积极心理学: "积极心理", 跨文化心理学: "跨文化",
  判断与决策: "决策", 行为经济学: "决策",
  抑郁症: "抑郁", 焦虑症: "焦虑", 焦虑障碍: "焦虑", 创伤: "创伤/PTSD", ptsd: "创伤/PTSD", 创伤后应激障碍: "创伤/PTSD", 物质使用: "成瘾", 成瘾行为: "成瘾",
  精神分裂症: "精神病性障碍", 精神病: "精神病性障碍", 双相情感障碍: "双相", 双相障碍: "双相",
  孤独症: "孤独症/ADHD", 自闭症: "孤独症/ADHD", adhd: "孤独症/ADHD", 多动症: "孤独症/ADHD", 注意缺陷多动障碍: "孤独症/ADHD", 神经发育障碍: "孤独症/ADHD",
  自杀: "自杀/自伤", 自伤: "自杀/自伤", 非自杀性自伤: "自杀/自伤", 失眠: "睡眠", 压力: "压力/情绪", 情绪: "压力/情绪", 情绪调节: "压力/情绪",
  人际关系: "人际关系/孤独", 孤独感: "人际关系/孤独", 亲密关系: "人际关系/孤独", 社会联结: "人际关系/孤独",
  儿童: "儿童青少年", 青少年: "儿童青少年", 老年: "老龄化", 衰老: "老龄化", 老年人: "老龄化",
  心理健康app: "数字心理健康", 数字疗法: "数字心理健康", 人工智能: "AI与心理", ai: "AI与心理", 心理疗法: "心理治疗", 心理干预: "心理治疗",
  药物: "精神药物", 抗抑郁药: "精神药物", 精神科药物: "精神药物", 迷幻药: "精神药物", tms: "神经调控", 经颅磁刺激: "神经调控", dbs: "神经调控", 脑刺激: "神经调控",
  预注册: "开放科学", 开放数据: "开放科学",
  世卫组织: "WHO", 世界卫生组织: "WHO", 卫健委: "国家卫健委", 心理所: "中科院心理所",
};

/** 模型漏了分类标签时，按内容类型补一个。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  research_finding: "研究发现", meta_review: "元分析/综述", replication: "重复验证", clinical_practice: "临床/治疗",
  policy_event: "行业动态", method_tool: "方法/统计", opinion_explainer: "学者观点",
};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/** 机构主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  who: { name: "世界卫生组织 WHO", displayTag: "WHO", aliases: ["WHO", "世界卫生组织", "世卫组织", "World Health Organization"] },
  "apa-psychology": { name: "美国心理学会 APA", displayTag: "美国心理学会", aliases: ["American Psychological Association", "美国心理学会"] },
  "apa-psychiatry": { name: "美国精神医学学会", displayTag: "美国精神医学学会", aliases: ["American Psychiatric Association", "美国精神医学学会", "DSM"] },
  nimh: { name: "美国国立精神卫生研究所 NIMH", displayTag: "NIMH", aliases: ["NIMH", "National Institute of Mental Health"] },
  fda: { name: "美国 FDA", displayTag: "FDA", aliases: ["FDA", "美国食品药品监督管理局"] },
  nice: { name: "英国 NICE", displayTag: "NICE", aliases: ["NICE", "National Institute for Health and Care Excellence"] },
  nhc: { name: "国家卫生健康委员会", displayTag: "国家卫健委", aliases: ["国家卫健委", "国家卫生健康委员会"] },
  cps: { name: "中国心理学会", displayTag: "中国心理学会", aliases: ["中国心理学会", "Chinese Psychological Society"] },
  camh: { name: "中国心理卫生协会", displayTag: "中国心理卫生协会", aliases: ["中国心理卫生协会"] },
  ipcas: { name: "中国科学院心理研究所", displayTag: "中科院心理所", aliases: ["中科院心理所", "中国科学院心理研究所"] },
  cochrane: { name: "Cochrane", displayTag: "Cochrane", aliases: ["Cochrane"] },
  cos: { name: "开放科学中心 COS", displayTag: "开放科学中心", aliases: ["Center for Open Science", "开放科学中心", "OSF"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴，
 * 比如把一项普通研究写成“哈佛研究发现”）。中英文写法放在同一个规则里，翻译后的名字也能对上原文。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "who", name: "世界卫生组织 WHO", patterns: [/\bWHO\b|世界卫生组织|世卫组织/, /world health organi[sz]ation/i] },
  { id: "apa-psychology", name: "美国心理学会", patterns: [/american psychological association|美国心理学会|美国心理协会/i] },
  { id: "apa-psychiatry", name: "美国精神医学学会", patterns: [/american psychiatric association|美国精神医学学会|美国精神病学(?:学)?会|美国精神病学协会/i] },
  { id: "nimh", name: "NIMH", patterns: [/\bNIMH\b|national institute of mental health|美国国立精神卫生研究所|美国国家精神卫生研究所/i] },
  { id: "fda", name: "FDA", patterns: [/\bFDA\b|美国食品(?:和|与)?药品?(?:监督)?管理局/] },
  { id: "nice", name: "NICE", patterns: [/national institute for health and care excellence|英国国家卫生与临床优化研究所/i] },
  { id: "nhc", name: "国家卫健委", patterns: [/国家卫(?:生)?健(?:康)?委(?:员会)?|national health commission/i] },
  { id: "cps", name: "中国心理学会", patterns: [/中国心理学会|chinese psychological society/i] },
  { id: "camh", name: "中国心理卫生协会", patterns: [/中国心理卫生协会|chinese (?:mental health association|association for mental health)/i] },
  { id: "ipcas", name: "中科院心理所", patterns: [/中(?:国)?科(?:学)?院心理(?:研究)?所|institute of psychology,? chinese academy of sciences/i] },
  { id: "cochrane", name: "Cochrane", patterns: [/cochrane/i] },
  { id: "cos", name: "开放科学中心", patterns: [/center for open science|开放科学中心/i] },
  { id: "harvard", name: "哈佛大学", patterns: [/harvard|哈佛/i] },
  { id: "stanford", name: "斯坦福大学", patterns: [/stanford|斯坦福/i] },
  { id: "yale", name: "耶鲁大学", patterns: [/\byale\b|耶鲁/i] },
  { id: "mit", name: "麻省理工学院", patterns: [/\bMIT\b|麻省理工/, /massachusetts institute of technology/i] },
  { id: "oxford", name: "牛津大学", patterns: [/university of oxford|oxford university|牛津大学/i] },
  { id: "cambridge", name: "剑桥大学", patterns: [/university of cambridge|cambridge university|剑桥大学/i] },
  { id: "ucl", name: "伦敦大学学院", patterns: [/\bUCL\b|伦敦大学学院/, /university college london/i] },
  { id: "kings-college", name: "伦敦国王学院", patterns: [/king['’]s college london|伦敦国王学院/i] },
  { id: "pku", name: "北京大学", patterns: [/北京大学|peking university/i] },
  { id: "bnu", name: "北京师范大学", patterns: [/北京师范大学|北师大|beijing normal university/i] },
];

/**
 * 这些域名上的文章，发布方就是对应的机构。只列机构自己的站：期刊和新闻稿平台上的文章多是别人的研究，
 * 写成“某某机构发布”反而会张冠李戴。
 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "who", domains: ["who.int"] },
  { entityId: "nimh", domains: ["nimh.nih.gov"] },
  { entityId: "fda", domains: ["fda.gov"] },
  { entityId: "nice", domains: ["nice.org.uk"] },
  { entityId: "nhc", domains: ["nhc.gov.cn"] },
  { entityId: "camh", domains: ["camh.org.cn"] },
  { entityId: "cos", domains: ["cos.io"] },
];

/** 原文里的这些写法也算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "apa-psychiatry", pattern: /\bDSM-?(?:5|IV|5-TR)\b/i },
];
