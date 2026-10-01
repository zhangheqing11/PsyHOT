# 参与贡献

欢迎提交可复现的问题、信源建议、精选标准的改进和文档修正。中文或英文都可以。

PsyHOT 基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 开源框架改造，本仓库只维护心理学方向的配置（`industry/`）和少量站点改动。采集、精选流程、聚簇等框架本身的问题，如果在上游也能复现，请优先提到上游仓库。

## 去哪里交流

- [Issues](https://github.com/zhangheqing11/PsyHOT/issues/new/choose)：可复现的 Bug 和有明确场景的功能建议。
- [部署与使用问答](https://github.com/zhangheqing11/PsyHOT/discussions/categories/q-a)：安装、配置、部署和使用问题；问题解决后可以标记答案。
- [想法交流](https://github.com/zhangheqing11/PsyHOT/discussions/categories/ideas)：先讨论方向和使用场景。
- [作品展示](https://github.com/zhangheqing11/PsyHOT/discussions/categories/show-and-tell)：分享你基于 PsyHOT 搭建的站点和使用经验。
- 安全漏洞请按 [安全报告说明](SECURITY.md) 私密提交。

## 贡献范围

优先欢迎心理学信源（尤其是中文信源和覆盖不足的分支领域）、评分标准与提示词、标注样本、部署体验、可访问性、文档和可复现故障的改进。大幅调整架构或产品行为前，先在 Issue 或讨论区说明场景和方案，避免投入后才发现方向不合适。

本仓库的信源名单和精选标准都是公开的，见 `industry/sources.json` 和 `industry/prompts/`。新增信源请附上试抓结果（能抓到、最近仍在更新），并说明它覆盖了哪个分支领域；不接受需要登录、付费墙或违反来源使用条款的抓取。

## 提交改动

1. Fork 本仓库，从最新的 `main` 创建自己的分支。想基于框架做别的行业的站点，建议直接从上游 [AIHOT](https://github.com/KKKKhazix/AIHOT) 开始。
2. 阅读 [AGENTS.md](AGENTS.md) 和改动对应的文档。保持一次 PR 解决一个清楚的问题，不夹带无关重构。
3. 按 [部署文档](docs/deploy.md) 配置本地环境。使用独立测试库，开发时关闭采集、模型调用和外部推送；不使用生产数据库或真实付费服务做测试。
4. 验证改动涉及的行为，在 PR 中写明运行结果。代码改动执行 `npm run typecheck`、`npm test`、网页构建与网页测试；后端测试库名必须以 `_test` 或 `_ci` 结尾，先执行迁移。运行中的站点可用 `node scripts/smoke.ts --base http://localhost:3000` 检查。纯文档或模板改动核对链接、语法和实际展示即可，不需要为了凑数量新增测试。
5. 向本仓库 `main` 提交 PR，关联相关 Issue。页面改动附截图；涉及配置或升级步骤时同步更新文档。

`main` 通过 PR 合并，PR 需要通过 GitHub Actions 的 `check` 和 `docker` 检查。

请勿提交 `.env`、密钥、管理员密码、Cookie、生产数据或未获授权的素材；日志和截图也要先移除敏感信息。代码沿用 [MIT 许可证](LICENSE)，品牌和第三方素材说明见 [NOTICE](NOTICE)。
