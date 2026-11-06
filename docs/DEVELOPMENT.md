# LLM 需求开发与验收流程

本流程面向在本仓库工作的编码 LLM。根目录 `AGENTS.md` 保留通用规则，并引导按任务阅读本文件对应章节。目标是让后续需求有明确边界、可复现验证和可核对的完成证据。

新增 Agent 或扩展其协议、用途与归属规则时，同时阅读 [Agent 适配指南](AGENT_ADAPTATION.md)，按证据、采集、会话/轮次、关联、用量、持久化、性能和验收逐项核对。

## 从需求到交付

| 阶段 | 必须产出 | 进入下一阶段的条件 |
| --- | --- | --- |
| 理解 | 需求记录、当前实现入口、相关基线结果 | 范围与验收可观察；关键歧义已解决 |
| 设计 | 影响模块、接口/数据兼容性、验证与回退方法 | 每条验收有验证方法；高风险改动有故障/迁移场景 |
| 实现 | 小范围源码变更、对应回归用例 | 每个实现点关联验收编号，无未解释的范围扩张 |
| 验证 | 目标用例、完整门禁、适用的 UI/桌面证据 | 检查实际执行，失败已解决，未验证项显式列出 |
| 复核交付 | 最终 diff、需求证据表、交付说明 | 没有未通过/待验证的必需验收项才能声明完成 |

状态可写为 `澄清中 → 待实现 → 实现中 → 待验证 → 已完成`；未具备环境或用户侧证据时保持“待验证”。需求有调整时更新范围和验收条件，不能只更新代码。小改动可在交付说明记录；不为每次拼写修正创建大文档。

## 架构与改动约束

按本次涉及模块阅读，具体实现以当前源码为准。

| 模块 | 责任与主要位置 |
| --- | --- |
| `core-go/` | HTTP/HTTPS/WebSocket 转发、审计副本、证书、事件投递；`forward.go`、`proxy.go`、`websocket.go`、`cert.go` |
| `src/main/` | Electron 生命周期、捕获接收、解析、会话聚合、SQLite、配置、本地 Web API |
| `src/preload/index.ts` | 显式 IPC 桥接能力，与主进程处理器及渲染端调用保持一致 |
| `src/shared/` | Agent 分类、协议识别、捕获语义；跨层规则优先复用这里 |
| `src/renderer/` | Vue 界面、composables、界面类型与解析工具；运行于浏览器或 Electron |
| `tests/` | Node 回归，包含本地捕获入库链路和部分 renderer 逻辑 |

- **代理与生命周期**：脱敏、解压、解析、截断仅处理审计副本；保留业务正文、认证头、URL、状态码与流式首段交付。协议层调整须有本地 origin 对比测试。保持事件去重、持久化后 ACK、取消传播和父子进程清理；只重试审计事件，不重放模型请求或工具调用。
- **解析与会话**：未知会话不可凭相同提示词合并，不同 Agent/会话不串联。实际 Token、估算、不可用及解析失败不可混为零；截断/中断保留状态。
- **API / IPC / 配置**：字段变更同时核对主进程、preload、renderer 类型与调用方，保留浏览器路径。配置默认值、校验、保存、重载与展示保持一致。
- **存储迁移**：使用事务与 `user_version`；用临时旧库验证升级、重复打开、失败回滚和原始记录保留。声明旧版本是否能读取升级后的数据，不能默认降级安全。
- **安全与真实数据**：保留 TLS 校验、控制面认证、Host/Origin 校验与 Electron 隔离；CA 损坏不得静默替换。凭据不得进入日志、报告、fixture 或截图；真实审计正文不作自动化 fixture。真实数据排查只在用户明确授权范围内进行。
- **工作区与依赖**：不以 reset/clean 或覆盖他人修改恢复工作区。依赖变更同步锁文件并说明必要性；`dist/`、`resources/bin/`、`release/`、`.quality/` 为生成目录，修改源码后构建，不手工修改或提交产物。验证不按端口查杀进程，不重启正在使用的代理。

## 环境与命令

- CI Node 固定为 `.node-version` 中的 `22.20.0`，Go 固定为 `1.27.2`（包含标准库安全修复）。各平台以对应提交的 CI 结果为证据。
- 新环境使用 `npm ci`，遵循锁文件；测试需要 `git`、`go`、`openssl` 和 POSIX shell。当前完整用例含 `/bin/sh`、POSIX 权限断言，CI 覆盖 macOS/Linux，Windows 的完整运行验收仍未建立。
- Vue 类型检查遵循 [Vue 官方建议](https://vuejs.org/guide/typescript/overview)。仓库主编译器为原生 TypeScript 7，当前 `vue-tsc` 依赖 JS 编译器 API，所以独立使用 `typescript-vue`（TS 5.9.3 别名）做 Vue 检查；主进程构建显式调用 TS 7，避免两个依赖的同名 `tsc` bin 冲突。不要移除 renderer 检查来规避工具兼容问题。

| 命令 | 覆盖范围 | 使用时机 |
| --- | --- | --- |
| `npm run verify:fast` | 公开文件清单、diff 空白错误、main/shared/preload 类型、Vue TS/模板类型、Go vet | 开发中快速反馈；不证明功能完成 |
| `npm run verify` | fast 全部检查＋Go race（`-count=1`）＋主进程编译＋全部 Node 回归＋Vite 生产构建＋Go 编译 | 代码/配置/依赖/门禁改动最终交付 |
| `npm run typecheck` | 主进程与 Vue 类型 | 快速定位类型问题 |
| `npm run test:main` | 主进程编译＋全部 Node 回归，含部分 renderer 逻辑 | 主进程/界面逻辑迭代 |
| `npm run test:core` | Go 竞态测试（可能复用 Go 测试缓存） | 代理迭代；最终门禁使用无缓存执行 |
| `npm run build` | 写入 `resources/bin` 与 `dist` 的应用构建 | 准备启动/打包，不能代替验收 |

验证脚本每阶段失败即停止，未执行阶段标记 `skipped`，返回非零；超时和缺少工具也是失败。`.quality/verification.json` 在每次运行开始就覆盖旧结果，记录模式、开始/结束时间、commit、工作区状态、环境和各阶段退出码。`running` 或 `mode=fast` 都不能当作完整成功。

完整门禁会重建 `dist`，Go 产物写到 `.quality/`，不覆盖 `resources/bin`、不重启桌面应用、不改变系统代理。报告和产物已忽略，不要提交真实运行数据。并行运行两次门禁会争用同一产物/报告，应串行执行。

## 验证矩阵

按改动选相关用例并补齐新增场景；表中的现有用例只是起点，不代表新需求已覆盖。

| 改动范围 | 现有验证入口 | 必须关注的验收场景 |
| --- | --- | --- |
| HTTP/TLS/流式转发 | `core-go/{proxy,transparency,encoding,protocol,keepalive,auth_transport}_test.go` | 上游与客户端正文/头/状态、首块可达、取消、压缩、超限仅影响副本、原 TLS 与 MITM 共存 |
| WebSocket | `core-go/websocket_test.go`、`tests/websocket_capture.test.cjs` | 同连接多轮、完成即入库、断连与失败、认证、ALPN |
| 解析/usage/工具 | `tests/b08_audit_accuracy.test.cjs`、`antigravity_web_fetch.test.cjs`、`codex_context_update.test.cjs` | JSON/SSE 变体、重复 delta、工具映射、Token 来源、非模型 fetch 不污染统计 |
| 会话/分类/身份刷新 | `tests/session_identity_v2.test.cjs`、`identity_refresh.test.cjs`、`session_selection.test.cjs` | 同名提示词跨会话、跨 Agent、显式父子关联、未知身份、乱序回复、缓存失效 |
| 存储/迁移/统计 | `tests/b06_idempotent_storage.test.cjs`、`b09_diagnostics_and_maintenance.test.cjs`、`b12_daily_activity.test.cjs` | 旧 schema、重复事件、回滚、原文保留、日期边界、所有筛选口径一致 |
| 生命周期/配置 | `tests/b07_lifecycle.test.cjs`、`b10_stability_and_smoke.test.cjs`、`b11_config.test.cjs`、`main.test.cjs` | ready 前失败、drain、退出/孤儿清理、重复 stop、默认配置、保存重载 |
| 安全/证书 | `tests/b03_security.test.cjs`、`main.test.cjs`、`core-go/cert_security_test.go` | 未授权请求拒绝、脱敏、坏证书/权限/链接、原 CA 不变、TLS 不降级 |
| Vue 页面/交互 | renderer 类型检查＋构建＋`tests/session_selection.test.cjs`＋新增目标测试 | 选择/加载竞态、空态/错误态、设置保存、实际主题与窗口布局；涉及 IPC 时核对浏览器降级路径 |
| 门禁自身 | `tests/verification.test.cjs` | 失败非零、超时/缺工具失败、旧成功覆盖、后续阶段不执行 |

UI 目测记录环境、操作、预期和实际结果，截图只使用合成数据。现有门禁没有全自动浏览器 E2E、打包后桌面冒烟或真实 Agent 验收，不能在报告中声称这些已通过。新需求如果涉及这些路径，应补充相应验证，而不是给无关改动强制跑登录或发布。

## 需求记录与证据

使用 [模板](requirements/TEMPLATE.md)。例如“刷新后保持选中会话”至少拆成：会话仍存在时保留选中、会话消失时回到可解释空态、较早请求晚返回不能覆盖最新选择。每条标记 `AC-1` 等编号，并记录测试文件/用例名或操作步骤、实际结果、限制。

测试数量仅说明运行规模，不代替验收覆盖。自动化通过与真实客户端可用是不同证据；`/health` 只证明就绪，抓取链路至少要看到新的事件入库且对应请求/回复/usage 正确。需要真实登录客户端时沿用用户正常操作，不自动重试真实模型调用。

最终复核：行为是否逐项满足需求？协议、安全与旧数据约束是否保持？接口调用方是否同步？是否遗漏错误态和清理？报告是否对应最终修改？还有没有靠日志猜测成功的地方？

缺陷修复需证明目标用例修复前失败、修复后通过；新行为覆盖正常路径、关键边界和相关失败路径，断言用户可观察结果。遇到环境限制或原有故障，记录原因并保留未验证状态。UI 操作还应覆盖空态、错误态及适用的主题/窗口大小。

交付前核对 `.quality/verification.json` 的 `mode/status/environment.commit/environment.worktree/startedAt`，勿复用旧报告。交付说明包含行为变化、验收结果、实际执行命令、未验证项、风险与回退；自动化通过但必需人工验收未完成时，明确写“自动化通过，验收待完成”。

## CI 与发布边界

`.github/workflows/verify.yml` 在 PR、`master/main` push 和手动触发时运行相同 `npm run verify`，保存平台报告；失败阻止检查变绿。代码中的 workflow 不会自动启用 GitHub 分支保护。仓库管理员若需要禁止未通过检查的合并，应将 `quality (ubuntu-latest)` / `quality (macos-latest)` 设置为 required checks。

标签触发的发行 workflow 先执行同一 macOS/Linux 门禁和秘密扫描，再生成源码候选，无 Apple 密钥要求。签名桌面候选为独立手动 workflow；两者均不自动发布。干净账户安装/卸载与真实 Agent 必须取得独立证据。新文件须经内容审查后加入 `source-files.json`；未列出的已跟踪文件会使门禁失败。完整步骤见 [发行手册](RELEASING.md)。
