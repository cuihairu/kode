# RUST-010 审计与落地:Windows/macOS/Linux、x64/arm64、Remote SSH/WSL/Containers 的正确执行位置

日期:2026-11-15。审计对象:todo.md RUST-010。方法:打包矩阵/执行位置/路径正确性三面全谱核对。**结论:平台与架构轴打包+交叉验证已完备;Remote 轴唯一缺口=extensionKind 只靠上游缺省(自 VS Code 1.74 起缺省 workspace)而非显式声明——本批钉死 `"extensionKind": ["workspace"]` + 契约钉。**

## 1. 平台/架构轴:PASS(既有)

- 六平台 vsix 矩阵(platform-vsix.yml:36-55):linux-x64/linux-arm64(**musl 静态目标**,容器/alpine 可用)、win32-x64/win32-arm64、darwin-x64/darwin-arm64,每目标含 Rust 后台与协议 CLI;plus pure-ts 版(无二进制,TS 轨道足用)。
- 交叉验证不入闸不发资产:cargo test 按目标跑(--target × lib/cli_acceptance/windows_document_uri,platform-vsix.yml:86-94);构建与 nightly validate 两处 verify-platform-set(nightly.yml:134,199)+ SHA256SUMS 七资产字节校验(platformPackageSet.test.ts「exactly seven validated editions」)。
- npm 分发面:六平台 optionalDeps 映射 + windows .exe 后缀 + launcher 唯一发布件(npmPackage.test.ts:44-108);不支持的组合不猜(:58)。

## 2. Remote SSH/WSL/Containers 执行位置:缺口本批修

- **缺口**:package.json 此前无 `extensionKind`。行为上 VS Code 1.74+ 缺省即 workspace(engines ^1.82 在范围内),故现网行为正确;但「正确执行位置」靠上游缺省漂移不是声明——上游一旦改缺省或元数据链路丢字段,扩展会落到 UI 宿主,文件访问/kode-server spawn/telnet/引擎树探测全部指错机器。
- **修法**:显式 `"extensionKind": ["workspace"]`(package.json:198-200)。语义:Remote SSH/WSL/Containers 窗口中扩展常驻**工作区(远端)宿主**——workspace 文件、kode-server 子进程、telnet 通道、引擎树探测、桩导出全在远端机执行,UI 宿主零逻辑。
- 可观测面既有:identity 报告(IDE-MET-001,extensionIdentity.ts)分列 `host: remote(<name>)` / `local` 与 `side=workspace host/ui host`,装了未激活、激活中目录消失也如实分列,用户可对账执行位置。
- 远端无二进制→TS 轨道兜底(RUST-009 轴2 口径),Remote 场景仍可用。
- 契约钉:tests/activationEvents.test.ts 新例断言 `extensionKind` 恒 `['workspace']`;prove-red=摘字段→钉红→cp/cmp 还原复绿。

## 3. 路径正确性:PASS(既有)

- Rust 侧 windows_document_uri 测试按六目标交叉跑(platform-vsix.yml:94);TS 侧 workspacePath 抽象(joinWorkspacePath/usesPosixPath/selectPathApiForPlatform/pathApiFor,按样本路径选 POSIX/Win32 API,workspacePath.ts:4-40);配置模板 workspace 占位展开(:58-72)。

## 4. 门禁

activationEvents+platformPackageSet+npmPackage+bundleLoadSmoke 四契约文件 26 例绿(package.json 触面全量);`tsc` RC=0;`eslint` RC=0;prove-red 闭环。
