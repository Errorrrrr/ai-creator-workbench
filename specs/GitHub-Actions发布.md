# GitHub Actions 发布与手动更新

发布源：`Errorrrrr/ai-creator-workbench`。当前交付范围是 macOS 12.3 或更新版本、Apple Silicon（M 系列）处理器；不生成 Intel、Windows 或 Linux 安装包。

## 用户如何更新

底栏“检查更新”展示当前版本、最新稳定版本、适用平台、发布日期和纯文本发布说明。首次启动不自动联网，点击检查或“重新检查”才下载 GitHub Releases 中的静态 `latest.json` 附件，不调用 GitHub REST API，不占用匿名 API 每小时 60 次额度。

“打开发布页”打开对应 GitHub Release；“下载匹配安装包”打开匹配当前平台的 DMG 下载链接。该功能不在后台安装、不替换运行中的程序，也不要求配置 Tauri Updater 签名密钥。

静态清单下载要求仓库和 Release 公开。仓库私有、尚未发布清单、网络失败或附件下载服务暂时限制请求都会显示明确结果；草稿不会作为更新出现。将仓库设为公开与发布正式版本是不同操作，公开状态以 GitHub 当前实际设置为准。

升级前先导出“完整备份”，关闭旧程序，再用新程序替换应用。应用目录与 SQLite 数据目录分开；版本升级仍应在隔离数据副本上验证，不能用安装包构建成功代替数据迁移验收。

## 工作流与权限

入口是 `.github/workflows/release.yml`：

1. 推送 `v*` tag 自动启动；也可在 Actions 中选择 `Release macOS`，手动填写一个**已经存在**的 tag 重试。
2. 拒绝不符合严格 SemVer 的 tag、缺失 tag、非 commit 引用和版本不一致。手动输入只作为环境变量/进程参数传递，不拼接为 Shell 代码。
3. 从已验证的不可变 commit 构建。检查 `package.json`、`package-lock.json` 顶层与根 package、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 中应用包的版本，共六处字段。
4. 顺序执行 `npm ci`、JavaScript 语法检查、全部 Node 测试、前端构建、`cargo test --locked`，随后使用仓库锁定的 Rust 工具链构建 `aarch64-apple-darwin` 的 app 与 DMG。Cargo 构建也带 `--locked`。
5. 校验 app 的版本、应用标识、arm64 架构和签名结构；验证 DMG 镜像；归档 app，生成 `latest.json` 静态更新清单、覆盖 app/DMG/清单的 SHA-256 清单和内部产物清单。
6. 构建成功后上传 Actions artifact。发布 job 再次验证全部文件哈希与 tag 指向，创建未公开草稿，上传全部文件并核验，最后一步才公开 Release。

默认 `contents: read`，只有发布 job 获得 `contents: write`。使用 GitHub 提供的 `GITHUB_TOKEN`，无需个人访问令牌；不得把 token、Apple 证书或私钥提交到仓库。当前不需要单独的发布 secret。

同一版本的运行受并发锁保护；最终发布阶段跨版本串行，避免慢完成的旧版本覆盖 Latest。只有比现有 Latest 更高的稳定版本可以成为 Latest，预发布标记会保留。GitHub 并发队列可能取消尚未开始的旧排队任务；需要时可手动重跑其已有 tag。

## 发布新版本

以 `0.3.0` 为例，先修改上述六处版本字段，并核对更新入口内显示的应用版本。在创建 tag 前完成代码评审及本地检查：

```bash
npm ci
npm run check
npm test
npm run build:web
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

提交经过检查的改动，再创建版本 tag。这里的命令是发布者操作说明，不代表某个版本已经提交或推送：

```bash
git add <本次需要发布的文件>
git commit -m "Release 0.3.0"
git tag -a v0.3.0 -m "Release 0.3.0"
node scripts/check-release-version.mjs --tag v0.3.0
git push --atomic origin main v0.3.0
```

发布前核对 tag 指向的内容，不移动已公开版本的 tag，不强制覆盖已公开安装包。发现已发布版本有问题时，提高版本号后重新发布。

## 附件与校验

从 v0.4.1 起，每次发布的公开附件为：

- `ai-creator-workbench_0.4.1_aarch64.dmg`：推荐安装入口。
- `ai-creator-workbench_0.4.1_aarch64.app.zip`：保留 app 包结构的压缩副本。
- `latest.json`：当前版本、说明与安装包链接，应用通过固定的 `releases/latest/download/latest.json` 入口读取。
- `SHA256SUMS`：上面三个文件的 SHA-256 清单。

把四个文件下载到同一目录后执行：

```bash
shasum -a 256 -c SHA256SUMS
```

三项都应返回 `OK`。内部 `release-metadata.json` 随 Actions artifact 保留，但不作为公开附件；用于绑定 tag、commit、目标架构、文件大小与哈希。

当前使用 **ad-hoc 签名**，没有 Apple Developer ID 签名或公证。签名结构校验通过只证明打包结构有效，不表示 Apple 已验证开发者身份。macOS Gatekeeper 可能阻止首次打开；仅在确认仓库来源与哈希后，按系统提供的“仍要打开”流程操作，不需要也不建议全局关闭系统安全检查。

## 失败与重试

- **版本检查失败**：修复对应文件并创建正确的新 tag；未公开的错误 tag 由维护者明确处理，工作流不会替发布者修改 Git 引用。
- **测试或构建失败**：没有公开 Release，不会改变 Latest。查看失败 job 的日志，修复后使用新 commit/tag 重试。
- **上传中断**：保留未公开草稿。对同一 tag 手动重试时，工作流只接管带本流程标识的草稿，替换其不完整附件后再发布；不会覆盖手工创建的草稿。
- **已经公开发布**：工作流拒绝覆盖。不要用重跑替代版本升级。
- **GitHub 权限错误**：检查仓库/组织的 Actions 政策是否允许发布 job 使用 `contents: write`，不要通过把凭据放进代码来绕过。
- **更新检查没有新版本**：核对仓库公开状态、Release 是否仍为草稿/预发布、Latest 标记、当前版本和网络或附件下载服务错误；`latest.json` 缺失时不会回退旧 API。

## 验证边界

发布脚本的 Node 测试覆盖严格 tag、六处版本一致性、已有 Git 引用、附件缺失/篡改、失败上传保持草稿、tag 移动拒发、Latest 规则及权限配置。GitHub Actions 成功记录与 Releases 附件才证明云端发布完成；本地脚本测试、YAML 解析和本机构建不能代替这个证据。

正式 Developer ID 签名、公证、自动下载安装、Intel/Windows 交付和跨版本安装升级验收不属于当前发布实现。
