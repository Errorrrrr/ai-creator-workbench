# Antigravity CLI 接入

## 实现

- 驱动 ID `antigravity`，本机命令 `agy`；通过 `--help` 检查所需协议参数，避免误认 IDE 启动器或伪报版本。
- 前端请求新增布尔 `allowUserProfile`，默认 false。每次生成前确认使用 CLI 的登录态、用户配置、额度及本次上下文；Rust 与浏览器运行桥均拒绝缺少确认的请求。
- 生成采用固定的 stream-json 输入/输出参数，通过 stdin 写入一条 user event；只采纳唯一 SUCCESS result 的非空 response，不将工具日志或诊断混入候选正文。
- 独立临时工作目录，plan 模式、terminal sandbox、禁用斜杠命令展开。未使用 dangerously-skip-permissions。不覆写用户配置，不拷贝凭据，不恢复旧会话；使用 CLI 默认模型。
- Antigravity 与 Claude 权限边界不同：保留真实 HOME 以复用登录态，用户插件、hooks、MCP 和权限配置仍可能生效，CLI 也可能留存会话。并非无工具或完整进程沙箱。
- 沿用超时、输出限制和取消处理；macOS/Linux 浏览器运行桥也使用进程组终止。

## 验证

- 本机 `/Users/zxx/.local/bin/agy` 存在，arm64 原生；runtime 检测返回 ready、canGenerate true。
- 浏览器连接中心真实打开并设为 Antigravity 执行端成功，显示用户登录态与 Plan 提示。
- 未确认调用返回 403；stdin 编码、完整成功结果、缺失结果、错误/空结果、畸形 JSON 与重复结果的临时协议断言通过。
- JavaScript 语法检查、Rust clippy all-targets 无警告通过。无新增单元测试文件。
- 未获真实调用确认，本轮未使用用户账号验证模型生成、登录续期或实际工具策略；不能据安装检测声称模型可用。

## 本轮变更清单

- 修改：`src/app.js`、`src-tauri/src/runtime.rs`、`scripts/dev-server.mjs`、版本清单与锁文件、README。
- 新增：`scripts/antigravity-protocol.mjs`、本文。
- 无删除文件；无数据库结构变更；无 Git 提交或推送。
