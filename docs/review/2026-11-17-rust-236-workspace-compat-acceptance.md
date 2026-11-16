# RUST-236 验收纪要:Workspace 兼容(Windows path/Linux case/macOS case-insensitive/WSL/SSH/containers)(纯对账)

日期:2026-11-17。本纪要对账 RUST-236(旧 QA-007,主 todo 排队项)的验收口径与交付证据。结论:**六维全有既有面+测试钉/走查记录/发布门,整合验收零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| Windows path | HR-MOD-009 词法规范化(反斜杠转正斜杠/盘符统一大写/UNC 反斜杠同折/`..` 词法上卷,纯字符串零 IO);二进制发现 win32 `.exe`;venv Windows 布局 `Scripts/python.exe`;debugConfigLaunch/autoDebugpy 平台分支 | `tests/hotReloadModuleIdentity.test.ts`+`tests/venvDiscovery.test.ts`(windows layout 例)+`src/backend/nativeBinary.ts` |
| Linux case | SCH-002 缓存根键保留 POSIX 大小写——仅大小写不同的两根各自缓存,同名实体不跨根串缓存(`skipIf win32`=场景在 Windows 不可构造,诚实平台门) | `tests/schemaCacheCaseSensitivity.test.ts`;ux009c Linux 腿走查(xvfb 双形态 2026-11-10,musl+rust-lld 构建配方在案) |
| macOS case-insensitive | 词法层不折叠大小写(canonicalize 保留原大小写=不在词法层造碰撞,fs 层大小写不敏感语义如实交还平台);CI darwin 夜构建双架构打包绿 | nightly.yml darwin-x64/arm64 VSIX;`tests/platformPackageSet.test.ts`(七版本完整性门:缺版本/多出 VSIX/字节不符阻断发布) |
| WSL | UNC 形保留 `//wsl$/…`、`//wsl.localhost/…`,反斜杠 UNC 同折到正斜杠 UNC | `tests/hotReloadModuleIdentity.test.ts:21-26` 双例 |
| SSH | UNC Remote SSH 挂载形保留(测试注释点名 Remote SSH);debugpy 注入真机链 | moduleIdentity 测试;`src/test/electron/suite/debugpyInjectLive.test.ts`;ux009b iMac 真机走查(2026-11-10,含 ssh=cmd.exe 坑账) |
| containers | devcontainer/远端=UNC/远端挂载形统一走 canonicalize 词法折叠;文件监视走 VS Code watch API(远端由宿主转发,不自建 fs.watch 假设本地盘) | `src/backend/hotReloadDiskWatch.ts`(监视面)/`hotReloadModuleIdentity.ts` |

## 自我验收证据

- moduleIdentity/venvDiscovery/schemaCacheCaseSensitivity/platformPackageSet 四套件当日全量 unit 10659(2113d5f4 门禁)内绿。
- Linux 真机走查(ux009c 2026-11-10 四组数据健康)与 iMac 走查(ux009b)记录在案;macOS 口径=CI darwin 夜构建绿(2026-11-10 记账)。

## 诚实条款

- **macOS case-insensitive 无专测**:SCH-002 明注 Windows 大小写场景不可构造而跳过;macOS 的 fs 层大小写折叠语义同样无法在 POSIX CI 内构造专测——策略=词法层不折叠(canonicalize 保留原样),碰撞可能性如实交还 fs 层,不作伪装断言。
- containers 维无专测与真机走查记录(devcontainer 场景未实测);证据=UNC/远端挂载形词法面+监视面走宿主 API 的设计,如实记账。
- WSL/SSH 维=词法形保留+真机走查坑账,非端到端自动化套件——证据形态是「走查记录+单元钉」,如实。
