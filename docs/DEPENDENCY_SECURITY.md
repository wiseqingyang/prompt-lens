# 依赖安全处置

检查日期：2026-11-05。维护责任：项目维护者；每周依赖更新与每次正式发行前复核。审计结果具有时效性，不构成永久安全保证。

| 项目 | 处置 | 验证 |
| --- | --- | --- |
| source-map-js / GHSA-68fv-2mgg-jv7q | 锁文件更新至 1.2.2 | npm 官方源审计 |
| http-cache-semantics / GHSA-ch52-4w7c-c8xp | 锁文件更新至 4.3.0 | npm 官方源审计 |
| fastify / GHSA-389g-gv7q-r4x8 | 生产依赖更新至 5.12.8，fast-uri 与 @fastify/static 同步更新 | 生产依赖零漏洞 |
| Go 1.27.2 标准库 / GO-2026-6809 | 提高模块最低 Go 与 CI 至 1.27.3 | 更新后扫描无已知漏洞 |
| minimatch / GHSA-g3hv-75wg-m249 | 仅打包工具链（electron-builder），保留显式限时风险记录 | 见下文 |

官方来源：[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)、[fastify](https://github.com/advisories/GHSA-389g-gv7q-r4x8)、[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[Go 发行修复](https://go.dev/doc/devel/release)。

minimatch（GHSA-g3hv-75wg-m249）通过 @electron/universal → app-builder-lib → electron-builder 引入开发依赖。此包不在应用生产依赖中；打包脚本使用的 glob 匹配路径均为工程静态配置，不读取外部非受信输入。npm 提供的自动修复建议降级至 electron-builder 25.1.0（不兼容当前 Electron 44），上游 electron-builder 暂未发布兼容修复版本。

该项临时风险处置仅到 **2026-11-25** 或首个上游修复版本出现（以较早者为准）；届时必须更新依赖或重新书面评估，不能无限期豁免。生产依赖审计要求所有严重级别为零（`found 0 vulnerabilities`）；完整开发树要求无 high/critical，且只允许表中已评估的 minimatch 中危传播链；新告警或评估过期都会使门禁失败。正式发行必须复核该处置是否仍有效。

```bash
npm run audit:dependencies
cd core-go
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
```

使用官方 npm registry 与锁文件 integrity；新增依赖同时评估许可与运行范围。`npm run release:metadata` 生成 npm CycloneDX、Go 模块清单、工具链版本、安装依赖许可和 Electron runtime notices。Go JSON 模块清单不是宣称符合 CycloneDX 的 Go SBOM；需要消费者格式时据此再生成并验证。
