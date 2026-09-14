# AI Creator Workbench

## 0.2.3 Codex / Claude

- Codex 已开放只读、非持久化执行，读取最后答复而非 CLI 日志；先在终端 `codex login`。当前使用默认供应商，不加载用户 config.toml 的自定义供应商配置。
- Claude 支持 API Key 或既有 CLI 登录态（无 Key 时回退），先运行 `claude auth login`。登录态模式关闭普通设置源、工具、MCP、技能和普通 hooks；组织托管策略仍可能生效。
- 所有调用使用临时工作目录，每次发送前确认账号与上下文；“设为当前 AI”只切换后续生成，不立即调用模型。安装检测不等于真实生成验证。
- Claude Key 裸模式仍保持隔离 HOME；Claude 登录态模式与 Codex 使用用户登录目录，不宣称完整进程隔离。

## 0.2.2 Antigravity CLI

- 连接中心检测本机 `agy`（而不是 IDE 启动器），选择 Antigravity CLI 后可发送生成请求，完整成功结果进入候选区。
- 先在终端运行 `agy` 完成登录。使用 CLI 当前默认模型；目前不在工作台内修改模型或账号。
- 每次生成需确认使用用户登录态及配置，并发送本次上下文；可能消耗额度、保存 CLI 会话，且用户插件/hooks/权限规则仍可能生效，不属于无工具模式。
- 固定参数启用 `--mode plan --sandbox --disable-slash-commands`，单次临时工作目录、stdin NDJSON、超时与进程组取消，不使用自动批准所有工具的参数。终端 sandbox 不代表整个 CLI 进程隔离。
- 参考：[官方 Headless 协议](https://antigravity.google/docs/cli/headless/)、[权限规则](https://antigravity.google/docs/cli/permissions/)。

## 0.2.1 修复

- 灵感库独立于项目，支持新增、编辑、搜索、Markdown 导出及追加到当前项目核心灵感；无初始示例。
- 灵感保存到本机项目库，单个项目 JSON 备份不包含独立灵感库，请使用灵感库内的导出按钮。
- 恢复系统原生标题栏，补齐工具栏非交互区域拖动与窗口拖动权限。

面向灵感、故事设定、短剧与漫剧剧本的本地优先 AI 创作工作台。工程名：`ai-creator-workbench`。

0.2.0 支持多项目独立保存、项目备份恢复、Markdown 导出，以及可选本机 Embedding 语义检索。桌面壳使用 Tauri 2，SQLite 保存项目，供应商请求与 CLI 执行由 Rust 本地运行时承接。首次启动没有示例项目；手动新建项目时，正文、大纲、分集和分场均不预填示例内容。

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
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/AI Creator Workbench_0.2.3_aarch64.dmg`

当前配置使用 ad-hoc 签名，适合本机开发验证；对外分发前仍需配置 Apple Developer ID 并完成公证。

## 已实现

- 项目管理：创建、切换和重命名；新建不会覆盖旧项目。
- 桌面 SQLite 事务保存，浏览器 IndexedDB 原子保存；保留上一份内部数据库快照，拒绝旧窗口覆盖新版本。保存失败会明确提示，不显示保存成功。
- JSON 项目备份与恢复为独立项目；Markdown 正文与大纲导出。桌面导出位于系统下载目录，文件名包含唯一后缀，不覆盖已有文件。
- 旧版 localStorage 数据首次打开时自动迁移到新存储，旧存储保留作为回退副本。迁移只在新库不存在时运行。
- 升级时仅隐藏完整匹配旧版未编辑“未命名短剧”的模板项目（正文、结构、视图指纹及空版本/知识库同时校验）；原始内容保留在库内恢复副本中，任何编辑过的项目均保留。

- 新建短剧、漫剧或通用故事项目，从灵感、创作简报、世界观、人物、大纲逐步推进到分集与分场。
- 动态项目树及分集/分场的创建、重命名、排序、复制、删除和撤销。
- 剧本、大纲、设定引用和历史版本视图；编辑即时保存，刷新后恢复。
- AI 候选区支持停止、重试、光标插入、替换正文、追加正文、撤销和重做。
- 每次采纳保存完整内容快照、产生方式和当次知识引用，可预览旧版本并恢复为新版本。
- 用户授权选择 `.md`、`.markdown`、`.txt` 文件或目录，浏览器只读导入并建立本地索引。
- 知识片段可搜索、勾选并随生成请求发送；候选稿显示本次实际引用，不使用静态引用数据。
- OpenAI 兼容接口测试 `/models` 并调用 `/chat/completions`；API Key 默认只存在当前页面内存中，macOS 桌面端可勾选保存到系统钥匙串。
- Ollama 真实发现 `/api/tags` 并调用 `/api/chat`。
- Tauri 桌面版不依赖常驻 Node 服务；供应商测试、文本生成、取消任务和 CLI 检测均通过 Rust 命令执行。
- 本地运行桥检测 Codex、Claude、Gemini；Claude 固定驱动可以使用连接中心显式填写的 API Key，或启动进程提供的环境变量凭据。Codex、Gemini 仍仅检测安装状态。
- Apple Silicon 下检测 CLI 二进制架构；Intel 版 CLI 明确标记为 Rosetta 兼容模式和实验状态。
- 亮暗主题、命令面板、键盘操作、可见焦点、移动端项目树/AI 抽屉与响应式布局。

## 知识库与“向量”说明

Obsidian 本身保存的是 Markdown 文件，不要求也不会修改 Vault。用户选择 Vault 目录后，本原型读取文本、优先按段落、句末或换行等自然边界切成约 500–700 字的片段，再在浏览器本地生成 384 维稳定哈希词向量，用余弦相似度做轻量检索。

默认哈希词向量用于轻量文本检索，不等于神经网络语义 Embedding。每项目最多保留 2000 个片段，项目与索引一起保存。

知识库页面可填写已经安装的 Ollama Embedding 模型，点击“建立 / 更新语义索引”。应用通过本机 `http://127.0.0.1:11434/api/embed` 生成真实语义向量，搜索时融合语义与文本相似度。模型变更需要重建；未变化片段可复用缓存。未安装模型、调用失败时明确提示，搜索回退到文本检索。不会自动下载模型或向云端发送资料。接口参考：[Ollama Embeddings](https://docs.ollama.com/api/embed)。

每个知识来源可“重新选择目录并同步”，更新新增、修改和删除的文件；这是用户触发的同步，并非后台文件监听。当前不会解析 Obsidian 标签、双链或插件数据库，也不会向 Vault 写回内容。

## AI 接入边界

- 浏览器开发模式直连供应商 API，仍会受供应商 CORS 策略影响；Tauri 桌面版统一由 Rust 运行时请求供应商，不依赖 WebView 跨域权限。
- API Key 不写入项目数据库或备份；选择记住密钥时仅写入 macOS 钥匙串，按连接 ID 与地址隔离。浏览器仍使用会话密钥。
- “本机 CLI”不代表本地模型：所选正文与知识上下文仍可能由 CLI 发送到其云端服务。
- CLI 接口只接受服务端白名单 `driverId`，参数固定、`shell: false`、空临时目录运行，并限制请求体、输出、并发和超时；前端不能提交命令、参数、路径或环境变量。
- Codex CLI 当前只做安装检测。只读沙箱不能充分保证它不读取设备文件，因此浏览器桥不开放执行。
- Claude API Key 分支使用 `--bare`、无工具、无会话持久化参数，在临时隔离 HOME 中运行；无 Key 则进入上述登录态分支。工作台自己的钥匙串选项仅保存用户明确提供的 API Key。真实调用可能产生账号用量或费用。
- Ollama 内容在本机模型中处理，但模型能力、速度与内存占用取决于用户安装的模型。

## 数据与安全

每个项目独立保留正文、结构、版本、知识片段和语义索引；连接配置作为本机共享设置。桌面数据库位于 Tauri 应用数据目录的 `workbench.sqlite3`，使用 WAL 与 FULL 同步，库大小上限为 64 MiB；浏览器使用 IndexedDB，受浏览器配额限制。浏览器与桌面之间通过 JSON 备份迁移。恢复备份不会覆盖原项目，语义向量可在目标设备重新生成。备份含创作和知识文本，请自行保管。

浏览器开发模式的 CLI 运行端点只监听 `127.0.0.1`，校验同端口 Origin；桌面版不开放 HTTP 端点。两种模式都使用固定驱动与参数，拒绝用户自定义 Shell。Claude Key 分支使用临时隔离 HOME；登录态分支、Codex 与 Antigravity 经每次确认后使用用户登录目录和临时工作目录。各驱动权限边界不同，不能把 CLI 整体视为操作系统级沙箱。

## 快捷键

- `⌘/Ctrl + K`：打开命令面板
- `⌘/Ctrl + S`：立即保存当前文档
- `⌘/Ctrl + Enter`：执行 AI 请求
- `Esc`：关闭弹层或停止生成

## 桌面架构与后续

当前交付 macOS arm64。尚未完成 Windows 发布、自动更新、后台目录监听、Codex/Gemini 创作执行及独立灵感素材库。真实供应商、Claude CLI 与 Embedding 模型需要用户配置后进行联调；本机协议模拟验证不等于真实模型质量验收。
