# 学界五维评分（2026-10-29）

学界条目沿用预筛及两次旧评分；结构化完成后，按类别所属视角、再按信源视角兜底。学界、非推广、两次评分成功且均分至少 30 的条目，使用一次五维思考评分。业界和其他路径沿用原规则。

## 分数与入选

五维为 `sig`、`nov`、`cred`、`reson`、`act`，每维必须是 1–4 的整数，保留各自不超过 200 字的依据及 `event`、`contentType`。五维等权相加，显示分为 `Math.round((dimsSum - 5) / 15 * 100)`。

| 分级 | 学界显示分门槛 | 最低五维和 |
|---|---:|---:|
| T1 | 60 | 14 |
| T1_5 | 65 | 15 |
| T2 | 67 | 15 |

通过相关性、不是推广且最终分达到门槛才入选。入选和接近入选的写作档位使用最终分数。第二段失败重试一次，仍失败交给现有队列处理，不回退到旧分数。

## 模型、回执及回滚

`scoreDims` 能力默认使用 `default-think`，可通过 `SCORE_DIMS_MODEL` 或后台“模型与评测”页切换。默认预设沿用 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，显式开启思考及 JSON 模式，不读取 `LLM_EXTRA_JSON`；调用参数 4000 token，加上思考预设的 4000，总上限 8000，temperature 0.2。请求沿用回执和预算机制，用途为 `score_dims`。

`analyses.score` 写最终显示分；`output.scores` 保留旧的两次分数。`output.scoringPath` 标记 `dims` 或 `legacy`，五维路径另存 `dims`、`dimsSum`、`dimsModel`、`gate`；`threshold` 是实际使用的门槛。五维回执加入分析的 `receipt_ids`，相同输入重试复用已成功回执。

将 `SELECTION.academicDims.enabled` 设为 `false` 后提交、部署，即恢复旧判断流程，已有五维结果保留。部署不重算历史判断、不改服务器 `.env`。若线上报 `Model … is not configured`，停下报告，不加 key。

## 验证与来源

- 提示词来源：工作区 `outputs/打分算法离线测试-2026-10-28/prompts/v3.md`；固定副本为 `tests/fixtures/selection-v3.md`。`selection-dims.md` 只将字面量 PsyHOT 换成 `{{siteName}}`，测试验证渲染后逐字一致。
- 门槛、粗筛线、线性换算和直接替换上线的授权来源：工作区根目录 `交接-2026-10-29-学界五维打分上线.md`。
- 离线背景：`outputs/打分算法离线测试-2026-10-28/报告.md`、`交回-Claude-第三轮验收结果-2026-10-28.md`、`raw/summary-v3.json`。第三轮交回文件记录了线上样本编号冲突；上线实现使用交接批准的固定线性换算。
- `tests/academic-dims.test.ts` 覆盖门槛、粗筛、视角、推广、拒绝、开关、写作档位、严格校验、重试及回执落库；原分析测试覆盖关闭开关时的完整旧流程。
- **评测脚本暂未覆盖第二段，后续单独处理**：SelectBench 与 `scripts/eval-selection.ts` 的 `stages: "selection"` 保持只跑预筛和旧评分。
- 上线后按交接只读核验，并在第 3 天、第 7 天报告精选量、调用与估算花费、条目清单和旧新判断差异；只报告，不自行调整。
