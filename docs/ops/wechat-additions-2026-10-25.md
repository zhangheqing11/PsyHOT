# 2026-10-25 公众号名单调整

用户指定的频率（非系统推断）：

| 信源 | 间隔 | 状态 |
|---|---|---|
| PsychStatisticia | 1440 分钟 | 新增配置，未核验账号，暂时停用 |
| 岳行行428 | 1440 分钟 | 新增配置，未核验账号，暂时停用 |
| Psychology心理探寻 | 2880 分钟 | 新增配置，未核验账号，暂时停用 |
| 苇草psy | 2880 分钟 | 新增配置，未核验账号，暂时停用 |
| 中国临床心理学杂志（wechat-cjcp） | 4320 分钟 | 现有配置从 2880 调至 4320，不新增重复项 |
| 中国科学院心理研究所 | 保留现有 1440 分钟 | 已有“中科院心理所”（wechat-psych-cas），不重复添加 |

四个新号只有 nickname，没有猜测 ghid 或 wechatBiz。必须使用现有 everyInfraCall 的
wechat_oa/account_search 和 discovery 预算份额搜索，核对准确账号后读取候选文章列表，
从该号真实文章链接取得 __biz，再配置 ghid、wechatBiz 并启用。不要直接按昵称购买文章正文。
现有 resolve-wechat-accounts.ts 只处理已经有 wechatBiz 的账号，不能直接解决这四项。

seed 只插入不存在的 id，不更新已有行。上线时需把新号的已核验配置同步入库，并通过带
before/after 的 audit_log 将 wechat-cjcp 的 interval_minutes 改至 4320；调整 next_fetch_at
时避免留下旧的更早调度。上线前核对生产库，若目标已经由其他操作添加，按 ghid/__biz 去重。
保留 EveryInfra 现有预算，不增加额度。新增列表检查的平均开销为每天 3 次调用，正文另计。

本次未上线：SSH 和本地数据库连接均返回权限拒绝（Operation not permitted / EPERM），
未调用付费接口，未改变生产数据库。

验证：typecheck、网页生产构建、JSON 解析、ID 唯一性、指定间隔及未核验账号停用断言通过。
网页测试中需监听 127.0.0.1 的用例被运行环境拒绝（listen EPERM），无法全部通过；
后端数据库测试及运行站点 smoke 因同一连接/监听限制未执行。
