# 本机网站

地址：<http://localhost:3000>；关于页：<http://localhost:3000/about>；后台：<http://localhost:3000/admin>。

使用现有本地 PostgreSQL 数据库 `psyhot`（Docker 容器 `psyhot-testdb`，端口 55432），保留内容和后台账号。网页与 API 通过 macOS 用户服务 `com.psyhot.local.server` 常驻，登录后自动启动，异常退出时自动重启。需要 Docker Desktop 正在运行；数据库容器设置了 `unless-stopped` 重启策略。

只监听本机地址，不启动外网隧道和 worker；抓取、模型调用、邮件和推送关闭。现有 `.env` 不改写，启动脚本通过进程环境把站点地址改为 localhost，并在 API 进程中移除旧的开发免登录选项。

## 修改文字后更新网页

保存文件后，在项目目录执行：

```bash
bash scripts/local-site.sh update
```

完成构建和服务重启后，刷新浏览器即可。此命令只更新本机网站，不发布到 psyhot.cn。

## 管理

```bash
bash scripts/local-site.sh status   # 查看网页和接口是否可访问
bash scripts/local-site.sh stop     # 本次登录期间停止
bash scripts/local-site.sh start    # 再次启动
bash scripts/local-site.sh restart  # 重启
```

系统启动配置位于 `~/Library/LaunchAgents/com.psyhot.local.server.plist`；运行脚本是 `scripts/local-server.sh`，日志保存在 `.data/local-server/logs/`。旧的 `com.psyhot.demo` 外网演示服务已禁用，避免重开隧道或抢占端口。

电脑休眠或 Docker 未运行时，网站和数据库可能不可访问。唤醒并启动 Docker 后，刷新网页；需要时执行上面的 `restart`。
