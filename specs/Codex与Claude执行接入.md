# Codex 与 Claude 执行接入（0.2.3）

## 使用与边界

- Codex：`codex exec`，stdin 提示、临时工作目录、read-only sandbox、ephemeral、ignore-user-config、ignore-rules。只采纳 output-last-message 文件，不将日志作为正文。不传审批/沙箱绕过参数。复用 CODEX_HOME 登录态，不复用用户自定义供应商配置。只读模式并非无读取能力。
- Claude：有显式 API Key 时继续 bare 模式；无 Key 时使用已有 CLI 登录态，清空普通 settings sources，禁用内置工具、MCP、技能和普通 hooks、自动记忆及会话保存。组织托管策略可能覆盖限制，CLI 用户上下文不保证完全隔离。
- 浏览器模式 API Key 来自启动服务的 ANTHROPIC_API_KEY；桌面模式还支持连接中心会话/钥匙串 Key。两端无 Key 都尝试 CLI 登录态。
- 每次调用明确确认账号、上下文和额度使用。检测成功不等于登录/生成成功。未登录通过现有错误分类显示，不自动启动登录或读取输出中的凭据。
- UI 将“设为执行端”统一改为“设为当前 AI”；真正未实现的驱动标注“工作台暂未支持调用”。保留未安装和检测失败的区别。
- Codex 检查 exec help；Claude 检查 help 中所需参数，缺少能力不开放执行。

## 变更清单

- 修改 src/app.js、src-tauri/src/runtime.rs、scripts/dev-server.mjs、版本清单及锁文件、README。
- 新增本文，无删除文件、数据库结构变更或新增单元测试文件。

## 已验证与问题修复

- 浏览器实测 Codex → Claude 切换成功；未确认的生成请求均返回 403；未调用真实模型。
- 原生检测发现 Claude help 超过旧版 8 KiB 上限（本机 stdout 8583 字节），导致误判。已提高到 64 KiB，与 Node 检测一致。
- 检测失败优先显示错误状态，不再被 Intel 兼容标签掩盖。
- 最终 0.2.3 原生 app 已重启实测：Codex 与 Claude 均显示“设为当前 AI”，原先选中的 Antigravity 保留。未在用户桌面项目库新增测试数据。
- JavaScript check、Rust clippy all-targets、arm64 app/DMG 构建通过；未进行真实生成、登录续期或账号额度验证。无 Git 提交/推送；安装包未公证。
