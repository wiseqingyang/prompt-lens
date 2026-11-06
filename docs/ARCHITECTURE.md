# 架构与代码入口

| 组件 | 入口 | 责任 |
| --- | --- | --- |
| Go 核心 | `core-go/main.go`, `proxy.go`, `forward.go`, `websocket.go` | 代理、TLS、HTTP/SSE/WebSocket 转发、审计副本与事件重试 |
| Electron 主进程 | `src/main/index.ts`, `core.ts`, `cert.ts` | 生命周期、核心子进程、证书与显式用户操作 |
| 审计接收与存储 | `src/main/core.ts`, `storage.ts`, `parser.ts`, `session.ts` | 认证接收、持久化、解析、会话与统计 |
| 控制接口 | `src/main/web.ts`, `desktop-security.ts`, `src/preload/index.ts` | 本地 Web、认证、IPC 能力与校验 |
| 界面 | `src/renderer/App.vue`, `composables/`, `components/` | Vue 展示、设置、分析与导出 |
| 共享语义 | `src/shared/` | Agent、协议、历史与规则脱敏 |

业务转发先于独立审计处理。审计超限截断只影响副本；重试仅投递审计事件，绝不重放模型请求或工具调用。事件持久化后才确认，数据库迁移有版本与事务。相同提示词不构成同会话证明，reported/estimated/unavailable/parse_error Token 状态不可混用。

退出时先 drain，再终止核心与 Web 服务、关闭存储。核心监听父进程 stdin 以避免成为孤儿进程。设置修改会重启核心；不要以文件保存成功推断重启或真实流量验收成功。

协议、存储和 UI 的改动约束及验证矩阵见 [DEVELOPMENT.md](DEVELOPMENT.md)。本页不把实现细节当成稳定第三方 API；预发行阶段内部接口可能变化。
