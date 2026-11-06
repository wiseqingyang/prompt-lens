# PromptLens Agent 协同与二次开发指引

本文件是专为参与 PromptLens 开发、重构与维护的 AI 编程 Agent（以及开发者）制定的核心指引。
用户最新指令优先，局部约束请参考对应子目录的 `AGENTS.md`（如 [tests/AGENTS.md](tests/AGENTS.md)）。

---

## 1. 项目定位与架构全景

PromptLens 是一个在本地运行、真正无侵入式的 Coding Agent 请求审计与提示词解剖平台。系统架构分为四层：

```
[Coding Agent 客户端] (Antigravity / Codex / Pi / WorkBuddy / Cursor)
         │  HTTP / HTTPS / WebSocket 业务流量
         ▼
[Go 代理核心 (core-go)] (默认 127.0.0.1:8899)
   ├── 透明转发业务请求（零时延干扰、保留完整双向流式语义）
   └── 异步复制审计事件（失败重试、自动熔断截断）
         │
         ▼ 内部接收器 (127.0.0.1:8897)
[Electron 主进程 & 存储 (src/main)]
   ├── 协议解包与脱敏 (src/main/schemas/)
   ├── Agent 会话与轮次归属引擎 (src/main/attribution/)
   └── 本地 SQLite 持久化 (src/main/storage.ts)
         │
         ▼ 本地 Web API (127.0.0.1:8088) / IPC
[Vue 3 渲染端 (src/renderer)]
   ├── 会话列表与轮次导航 (src/renderer/components/session/)
   ├── 提示词上下文解剖树 (src/renderer/components/anatomy/)
   ├── 报文时间线与流式查看器 (src/renderer/components/timeline/)
   └── Token 消耗与用量统计看板 (src/renderer/components/dashboard/)
```

---

## 2. 核心契约与开发铁律

任何改动都必须严格遵循以下原则，违背者不得提交：

1. **先确认范围**：查看 `git status` 和相关 diff，阅读当前源码与测试；保留已有改动，不顺手重构、升级或清理无关内容。
2. **保持协议契约**：审计处理不得改变业务流量。只重试审计事件，**绝对不重放模型请求或工具调用**；保持会话隔离与数据语义不变。
3. **保护运行环境**：未经用户授权，不动真实数据库、CA、钥匙串、系统代理或正在运行的 Agent/代理；不关闭 TLS 校验或削弱认证、Electron 隔离；不泄露凭据。
4. **隔离测试**：必须使用本地 mock、合成数据、随机监听端口（`127.0.0.1:0`）和独立临时目录；严格使用 `try/finally` 或 `t.after` 回收测试创建的资源。修改测试时遵循 [tests/AGENTS.md](tests/AGENTS.md)。
5. **验证最终改动**：代码、配置或依赖改动交付前必须运行 `npm run verify`；纯文档改动检查链接与 diff。不得删除测试、弱化断言或降低门禁来通过。
6. **凭证据完成**：复核最终 diff，逐项记录验收结果；必需项失败或未验证时不能声明完成。
7. **开发阶段架构优先**：围绕问题根因选择简洁方案，避免堆叠补丁和不必要的历史兼容代码；不扩大无关改动范围。
8. **证据驱动规则**：设计假设须验证后入码；相同证据与规则版本必须产生相同结果。保留判定依据，缺失或冲突显式表达，不以猜测兜底；原始事实与可重算的派生结果分离。
9. **Token 数据严肃性**：Token **仅采信协议明确返回的 reported usage**，缺失时明确标识“用量不可用”，严禁本地按字符估算。
10. **UI 规范与零开发者废话**：页面只展示对终端用户有用的信息，禁止将开发日志式、耗时毫秒数、底层数据库细节展示在界面上；主题色严格沿用清新的冰川青碧色阶（`#1f7a73`），遵循统一样式规范。

---

## 3. 核心代码模块地图

| 模块 | 核心源码目录 / 入口 | 关键职责与设计说明 |
| --- | --- | --- |
| **Go 代理核心** | `core-go/` (`main.go`, `proxy.go`, `forward.go`) | 高性能中间人代理，处理 TLS 握手解密、WebSocket 帧重组与审计事件异步推送 |
| **主进程与生命周期** | `src/main/` (`index.ts`, `core.ts`, `cert.ts`) | 管理 Go 核心子进程、证书生成/安装、主窗口生命周期与桌面一键拉起 |
| **协议解析与解剖** | `src/main/schemas/`, `parser.ts` | 识别 OpenAI/Claude/Gemini 等协议，提取用户指令、System Prompt、工具声明与调用结果 |
| **归属与会话引擎** | `src/main/attribution/` | 负责将碎片化的 HTTP/WS 请求归并至对应 Agent 原生 Session 与 Turn |
| **适配器注册表** | `src/main/attribution/adapters/` | 各 Agent（Antigravity, Codex, Pi, WorkBuddy）的具体归属策略与规则解析 |
| **存储引擎** | `src/main/storage.ts`, `repository.ts` | 基于 SQLite 的不可变事实存储、派生结果索引、正文冷热分层与维护压缩 |
| **前端交互与状态** | `src/renderer/composables/` | Vue 3 响应式状态管理（会话、时间线、设置、统计、主题） |
| **共享协议契约** | `src/shared/` | 前后端共享类型定义、协议常量、脱敏规则（`sanitizer.ts`）与 Agent 目录 |

---

## 4. 二次开发指引：如何接入新的 Agent

接入或增强一个 Coding Agent 时，请务必详细阅读 [新增 Agent 适配指南 (docs/AGENT_ADAPTATION.md)](docs/AGENT_ADAPTATION.md)。

基本开发步骤：
1. **明确五大核心要素**：谁发出的（Agent 身份）、请求做什么（用途）、属于哪个会话（Session ID 作用域）、在哪一轮（Turn 划分边界）、与谁关联（父子关系）。
2. **编写适配器实现**：在 `src/main/attribution/adapters/` 下创建或扩展适配器，实现 `AgentAttributionAdapter` 契约接口。
3. **注册 Agent 元数据**：在 `src/shared/agent.ts` 的 `AgentList` 中声明接入项（显示名称、图标、一键启动方式、终端注入命令模板）。
4. **编写契约测试**：在 `tests/` 下编写针对新 Agent 的合成请求测试（如流式解析、Session 聚类、Turn 边界等），严禁使用真实账户或包含敏感信息的个人录制。

---

## 5. 过程性需求记录与 Git 规范

- 功能迭代、行为修复或新增 Agent 适配时，先按 [需求模板 (docs/requirements/TEMPLATE.md)](docs/requirements/TEMPLATE.md) 梳理需求、验收条件（`AC-1`, `AC-2`...）与验证方法。
- **过程性文档管理原则**：为了保持开源仓库的纯粹整洁，所有在 `docs/requirements/` 下创建的具体需求文档（如 `docs/requirements/<feature>.md`）均已被 `.gitignore` 自动忽略，不纳入公共源码版本跟踪。
- **开源公开白名单**：仓库采用显式文件清单控制公开范围，文件列表记录在 [source-files.json](source-files.json) 中；若新增了需要随源码公开发布的核心代码或静态资源，必须在验证前同步将其添加到 `source-files.json`。

---

## 6. 常用开发与验证命令

| 命令 | 适用场景 | 运行耗时参考 |
| --- | --- | --- |
| `npm run verify:fast` | 本地开发过程中的快速类型检查与静态校验 | ~3 秒 |
| `npm run verify` | **交付前必需全量门禁**（包含类型检查、Go race 并发测试、全套 Node 契约测试与生产构建） | ~20-30 秒 |
| `npm run check:source` | 校验公开文件清单 `source-files.json` 是否与 Git tracked 文件严格一致 | ~0.5 秒 |
| `npm run audit:dependencies` | 执行生产依赖零漏洞检查、开发工具链已知风险核验与 Go 漏洞扫描 | ~5 秒 |
| `npm run pack:source` | 从干净提交构建生产源码包（`*.tar.gz`、清单与 SHA-256 校验和） | ~2 秒 |
| `npm run dev:renderer` | 启动前端 Vite 开发服务器（HMR 模式） | 即时 |
| `npm start` | 构建完整工程并启动桌面端 Electron 应用 | ~5 秒 |
