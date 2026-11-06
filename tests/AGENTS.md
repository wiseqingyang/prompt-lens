# 测试执行约束

继承根目录规则。现有测试使用 Node 内置 `node:test`，直接加载 `dist/main`；先运行 `npm run build:main`。Go 测试在 `core-go/` 中。

- 新增用例放在 `*.test.cjs` / `*_test.go`，让默认门禁自动收集。不要依赖个人目录中的导出文件或未跟踪文件；fixture 在仓库内使用合成数据，缺少必要 fixture 应失败而非静默通过。
- 监听 `127.0.0.1:0` 并读取实际端口；构造参数里的模拟端口可使用常量，但实际监听不得固定占用开发端口。
- 数据库、配置、CA、spool 均显式传入 `mkdtemp` / `t.TempDir()` 路径，避免类的默认用户目录。关闭数据库和服务后递归删除自己的临时目录，包含 WAL/SHM。
- Go 进程测试显式传 `-port 0 -data-dir <临时目录>`，避免默认读取用户 CA 和 spool。保留 stdin 控制生命周期；测试失败也回收自己创建的子进程。
- 用 `try/finally`、`t.after` 或 `t.Cleanup` 回收资源；恢复模块 mock、全局对象和环境。对等待/请求设超时，失败不能留下悬挂进程。
- 只访问本地合成 HTTP/TLS/SSE/WebSocket 服务，不发真实模型请求、不信任系统证书、不运行真实清库/Agent 启动动作。
- 回归断言返回结果、落库内容、客户端/上游可观察行为。构造最小失败场景，不复制生产算法到测试中得到同样错误。

定位命令示例：

```bash
npm run build:main
node --test --test-timeout=60000 tests/session_identity_v2.test.cjs
cd core-go
go test -race -count=1 -run TestWebSocket ./...
```

`node scripts/test-main.cjs` 自动收集全部 Node 测试并设置每个测试 60 秒超时；完整门禁另有每阶段超时。不要把超时当作正常通过。
