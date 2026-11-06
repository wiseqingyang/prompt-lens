# 发行操作手册

当前采用源码优先的交付方式。维护者可以是个人，不需要 Apple Developer 会员即可公开源码、生成源码包或自行构建。签名桌面安装包是独立的后续发行路径；版本号、构建成功和 Actions artifact 都不等于已经正式发布。

## 首次公开检查

- [x] 维护者已确认源码与 PromptLens 标识可公开使用；项目源码采用 MIT，第三方条款保留。
- [ ] 复核 `source-files.json` 内的每个文件及准备公开的 Git refs；不包含开发数据库、捕获、凭据、个人笔记和内部历史报告。
- [ ] 在拟公开提交运行完整门禁、依赖审计和秘密扫描，检查对应 macOS/Linux CI 结果。扫描器零发现不能替代人工隐私审查。
- [ ] 确认公开仓库地址与 README、package.json、Issue 模板及 SECURITY.md 一致。
- [ ] 公开时启用并实际核对 GitHub 私密漏洞报告，或先提供验证过的私密联系渠道；不得要求用户公开漏洞详情。
- [ ] 按仓库功能配置分支保护：禁止 force-push/删除，将 `quality (ubuntu-latest)`、`quality (macos-latest)` 和秘密扫描设为必需检查。单人维护可不强制第二人审批，避免自己无法合并；外部贡献仍由维护者审查。
- [ ] 检查 Actions 只读默认权限、Dependabot 与可用的秘密扫描保护；公开仓库、推送 tag 和上传发行附件均由维护者明确执行。

本清单列出操作条件，勾选源码权属不表示远端设置已经完成。公开源码必须使用经过审核的独立仓库；本地忽略目录和旧开发仓库不属于发行材料。

## 公开文件清单

`source-files.json` 是显式清单。新增文件先审查内容再加入；`npm run check:source` 拒绝未列出的已跟踪文件、缺失文件、重复项、越界路径、符号链接和常见私密材料。未知未跟踪文件不会进入源码快照或源码包。清单不是内容脱敏器，合法文件名内也可能含私人信息。

测试中的用户名、路径、邮件和时间应为合成数据；协议/日期边界用例可保留必要时间。第三方版权声明、作者署名和公共仓库账号须保留。发布者公开的提交身份、提交时间与版本元数据仍会出现在新 Git 历史中。

`npm run source:snapshot` 按清单复制当前工作区（可含未提交修改），生成 `.quality/public-source-*` 与逐文件 SHA-256 清单。这适合审查和隔离桌面构建；正式源码发行使用下面的干净提交归档。

## 源码候选

需要 Git、Node/npm、Go、OpenSSL、tar 和 POSIX shell，版本见根目录 README。

```bash
npm ci
npm run verify
npm run audit:dependencies
npm run pack:source
```

`pack:source` 要求所有清单文件已提交、索引与已跟踪工作区干净。它使用 `git archive` 排除 Git 历史，只打包提交中的文件，并通过解包逐项验证文件集合、字节和执行权限。已有输出拒绝覆盖，重新构建前由操作者移走旧输出。

输出 `.quality/source-release/`：

- `PromptLens-<version>-source.tar.gz`：源码，不含依赖目录、数据库、CA 和 `.git`。
- `SOURCE_MANIFEST.json`：公开提交 SHA、版本、逐文件 SHA-256 和执行权限。
- `SHA256SUMS`：归档与清单的校验和。

源码包接收者应先核对校验和，再解压、进入源码目录并运行 `npm ci` 和 `npm run build`。macOS 可用 `shasum -a 256 -c SHA256SUMS`，Linux 可用 `sha256sum -c SHA256SUMS`。源码包没有 `.git`，用于开发的完整 `verify` 和重新发行应在 Git 克隆中运行。

`.github/workflows/release.yml` 在推送 `v<package.version>` tag 时复用 macOS/Linux 门禁及全历史秘密扫描，再生成源码候选；也可以手动选择该 tag。无需 Apple 密钥。工作流不创建 GitHub Release，也不改变仓库可见性。维护者复核 CI、归档与已知限制后，才创建 Release 并上传这三个原始文件；SHA-256 用于完整性核对，不是数字签名。

## 可选桌面预览

```bash
npm run pack
npm run smoke:desktop -- .quality/preview-release/mac-arm64/PromptLens.app/Contents/Resources/app.asar --check
```

`pack` 仅支持 macOS arm64，在独立源码快照中安装、编译并重建 Electron SQLite，不修改工作区原生模块。输出 `.quality/preview-release` 标记 UNSIGNED，不作正式安装包。不要关闭 Gatekeeper、TLS 验证或 Electron 隔离来通过验收。

桌面冒烟只用临时合成数据库和随机端口，不启动真实代理或操作系统信任。`SMOKE_READY` 证明 SQLite 读写、沙箱配置与引导重定向，`IPC_OK` 证明 renderer → preload → 主进程往返；这不能代替完整生产生命周期和干净账户测试。

## 可选签名桌面发行

具备签名条件后，维护者可手动运行 `.github/workflows/desktop-release.yml` 并选择匹配版本的 tag。此流程不会随普通源码 tag 自动执行。

1. 配置受限 `release` environment 与 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` secrets；禁止提交证书或密码。
2. workflow 先运行质量与秘密扫描，再构建 macOS arm64。缺少平台、tag 或凭据即失败，不回退到 unsigned；保留 hardened runtime、强制签名和公证。
3. 验证 `codesign --verify --deep --strict`、`spctl --assess`、`xcrun stapler validate`。候选包括 DMG/ZIP、校验和、第三方许可、npm SBOM、Go 清单与工具链信息。
4. 在干净受支持系统核对哈希、安装/启动/退出、CA 信任与撤销、网络恢复以及真实 Agent；记录版本、系统、架构、步骤和结果。
5. 验收通过后再上传原始候选及发行说明。当前未完成 Apple 签名、公证、干净账户安装或真实 Agent 发行验收，不能据此声明桌面包已可交付。

## 回退

保留公开源码 tag、锁文件和已发布候选哈希。发行后撤回损坏包并给出恢复说明。数据库升级须先备份；旧应用能否读取新 schema 必须单独验证。不要自动删除用户数据或 CA 作为回退。
