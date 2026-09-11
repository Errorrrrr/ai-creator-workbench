# AI Creator Workbench

面向灵感、故事设定、短剧与漫剧剧本的本地优先 AI 创作工作台。工程名：`ai-creator-workbench`。

这一版是可直接运行和打包的产品原型：创作者可以从灵感逐步推进到剧本，导入自己的 Markdown / Obsidian 资料，连接 OpenAI 兼容 API、Ollama 或受控本机 CLI，并在采纳 AI 候选前检查内容与引用。桌面壳使用 Tauri 2，供应商请求与 CLI 执行由 Rust 本地运行时承接。

## 运行

浏览器开发模式要求 Node.js 18 或更高版本：

```bash
npm run dev
```

默认访问 `http://127.0.0.1:4173`。如端口被占用，可使用 `PORT=4174 npm run dev`。

静态检查：

```bash
npm run check
node --check src/knowledge-index.js
```

## 桌面运行与打包

桌面开发额外要求 Rust stable 与 macOS Xcode Command Line Tools。安装依赖后可以直接启动 Tauri：

```bash
npm ci
npm run desktop:dev
```

构建 Apple Silicon 应用和安装镜像：

```bash
npm run desktop:build:mac
```

构建产物位于：

- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/AI Creator Workbench.app`
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/AI Creator Workbench_0.1.0_aarch64.dmg`

当前配置使用 ad-hoc 签名，适合本机开发验证；对外分发前仍需配置 Apple Developer ID 并完成公证。

## 已实现

- 新建短剧、漫剧或通用故事项目，从灵感、创作简报、世界观、人物、大纲逐步推进到分集与分场。
- 动态项目树及分集/分场的创建、重命名、排序、复制、删除和撤销。
- 剧本、大纲、设定引用和历史版本视图；编辑即时保存，刷新后恢复。
- AI 候选区支持停止、重试、光标插入、替换正文、追加正文、撤销和重做。
- 每次采纳保存完整内容快照、产生方式和当次知识引用，可预览旧版本并恢复为新版本。
- 用户授权选择 `.md`、`.markdown`、`.txt` 文件或目录，浏览器只读导入并建立本地索引。
- 知识片段可搜索、勾选并随生成请求发送；候选稿显示本次实际引用，不使用静态引用数据。
- OpenAI 兼容接口真实测试 `/models` 并调用 `/chat/completions`；API Key 只存在当前页面内存中。
- Ollama 真实发现 `/api/tags` 并调用 `/api/chat`。
- Tauri 桌面版不依赖常驻 Node 服务；供应商测试、文本生成、取消任务和 CLI 检测均通过 Rust 命令执行。
- 本地运行桥真实检测 Codex、Claude、Gemini；当前只有 Claude 固定驱动具备安全执行通路，并且必须由启动进程显式提供环境变量凭据。
- Apple Silicon 下检测 CLI 二进制架构；Intel 版 CLI 明确标记为 Rosetta 兼容模式和实验状态。
- 亮暗主题、命令面板、键盘操作、可见焦点、移动端项目树/AI 抽屉与响应式布局。

## 知识库与“向量”说明

Obsidian 本身保存的是 Markdown 文件，不要求也不会修改 Vault。用户选择 Vault 目录后，本原型读取文本、优先按段落、句末或换行等自然边界切成约 500–700 字的片段，再在浏览器本地生成 384 维稳定哈希词向量，用余弦相似度做轻量检索。

这里的向量用于把“写法不同但词项相关”的查询与片段进行排序；它不是神经网络语义 Embedding，适合验证检索、引用和上下文装配流程。首版最多保留 160 个片段，项目与索引保存在当前运行容器的 `localStorage`（浏览器或 Tauri WebView）。当前不会解析 Obsidian 标签、双链或插件数据库，也不会向 Vault 写回内容。

## AI 接入边界

- 浏览器开发模式直连供应商 API，仍会受供应商 CORS 策略影响；Tauri 桌面版统一由 Rust 运行时请求供应商，不依赖 WebView 跨域权限。
- API Key 不落盘，刷新页面后需要重新输入。
- “本机 CLI”不代表本地模型：所选正文与知识上下文仍可能由 CLI 发送到其云端服务。
- CLI 接口只接受服务端白名单 `driverId`，参数固定、`shell: false`、空临时目录运行，并限制请求体、输出、并发和超时；前端不能提交命令、参数、路径或环境变量。
- Codex CLI 当前只做安装检测。只读沙箱不能充分保证它不读取设备文件，因此浏览器桥不开放执行。
- Claude CLI 使用 `--bare`、无工具、无会话持久化参数，并在临时隔离 HOME 中运行；仅当启动工作台时显式提供 `ANTHROPIC_API_KEY` 才开放执行，不读取用户级 hooks、插件、自动记忆、OAuth 登录或 Keychain。真实调用仍可能产生账号用量或费用。
- Ollama 内容在本机模型中处理，但模型能力、速度与内存占用取决于用户安装的模型。

## 数据与安全

当前版本一次保留一个本机项目。新建项目会替换当前项目并清空旧知识索引；界面会先明确提示。正文、结构、版本、非敏感连接元数据和知识片段存放于当前运行容器，密钥不进入持久化数据。浏览器与桌面 WebView 使用各自独立的本地存储，不会自动迁移项目。

浏览器开发模式的 CLI 运行端点只监听 `127.0.0.1`，校验同端口 Origin；桌面版不开放 HTTP 端点。两种模式都使用固定驱动、固定参数和临时隔离 HOME，拒绝任意 Shell，但这仍不等同于操作系统级安全沙箱。

## 快捷键

- `⌘/Ctrl + K`：打开命令面板
- `⌘/Ctrl + S`：立即保存当前文档
- `⌘/Ctrl + Enter`：执行 AI 请求
- `Esc`：关闭弹层或停止生成

## 桌面架构与后续

当前先交付 macOS arm64：静态前端运行在 Tauri WebView 中，Rust Local Runner 负责供应商代理、CLI 白名单、进程终止、超时和输出限制。下一阶段再迁移 Vue 3 + TypeScript，以 SQLite 保存项目结构、向量库存放可重建索引，并用 Keychain/Credential Manager 保存密钥；Windows 侧由 Job Object 承接进程树终止与资源限制。
