# RUST-238 验收纪要:Security(workspace trust/命令注入/路径穿越/生成文件覆盖/恶意插件/高频日志敏感数据)(纯对账审计)

日期:2026-11-17。本纪要对账 RUST-238(旧 QA-009,主 todo 排队项)的验收口径与交付证据。方法:六维逐一真侦察(精确探针非凭印象:capability 声明/child_process 全量/SQL 构造点/写入闸/CSP 基建/遥测外发扫)。**结论:六维全有既有面,零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| workspace trust | **`untrustedWorkspaces: {supported: false}` 声明**——受限模式工作区 VS Code 平台层不激活本扩展(信任=平台闸,不自造弱检查) | package.json capabilities(当日 python 读实证)+`%kbengine.capability.untrustedWorkspaces.description%` nls |
| 命令注入 | 全 src 进程面=execFile/spawn **参数数组**(无 shell:true、无 exec 字符串拼接):debugConfig RUST-001 承诺式 execFile(不再 execSync 阻塞宿主)/inferPipeline spawn 数组/protocolTooling+pcapActions execFile+timeout 5000;Rust 侧 kode-kbengine 无 Command::new shell | `src/debugConfig.ts:1142-1155`+`src/inferPipeline.ts:116-118`+`src/protocolTooling.ts:45`/`protocolPcapActions.ts`;grep 全量核(shell:true/exec 零命中) |
| 路径穿越 | db-clone SQL 双闸=标识符 `quote_ident`(planner.rs:222)+值 `?` 绑定(SELECT planner/import INSERT binds 全参数化);文件域=HR-MOD-006 out-of-root/多命中拒绝不猜+`..` 词法上卷卷出根交解析器拒;db-clone 畸形输入 fail-closed(RUST-231 fuzz.rs) | `crates/kode-db-clone/src/planner.rs`/`import.rs:509-511`;`tests/hotReloadModuleIdentity.test.ts`;fuzz.rs(RUST-231 纪要) |
| 生成文件覆盖 | copy-if-absent 四面(pythonStubExport/entityTypeStubs/pythonTypeStubs/pythonExtraPaths——用户资产不覆盖);pyrightconfig 五闸(user-owned previous 全等/缺省闸,不经确认不覆盖=RUST-162);writeFileAtomic 同目录 tmp+rename(RUST-163,故障注入钉);clone import 预留 fail-closed(crash/歧义 COMMIT 拒绝=fingerprint sha256 校验) | RUST-162/163 纪要;`src/backend/playerDataCloneImportGuard.ts`(fingerprint 格式闸+reservation);clearCaches/reset 类破坏面走 modal 确认(RUST-221) |
| 恶意插件(webview 注入) | webviewSecurity.ts 统一入口(KR-AUD-38/43/49/50/53):16 字节 nonce+`script-src 'nonce-…'`+toJsonForScript 吃 `<>`(防 `</script>` 断开脚本上下文,数据源「引擎 watcher 不可信」明示)+`default-src 'none'` 断外联外帧+离线打包不引 CDN(RUST-225)+图片源显式开洞制 | `src/webviewSecurity.ts`+`tests/webviewSecurity.test.ts`+各面板 Html 套件(databaseManagement/monitoring/entityDependency/flowSwimlane);RUST-225 纪要(69c2a202) |
| 高频日志敏感数据 | **遥测零、外发 HTTP 零**(grep 全量实证)——日志/指标全部本地(OutputChannel/logCollector 引擎日志端口本地展示面/metrics 本地性能面板);高噪音明细默认关(metrics.fileReadDetail=false、semanticTokens 默认关=RUST-144 opt-in) | grep telemetry/fetch/http.request 全 src 零命中(hotReload.ts:549 命中为计时 API requestSource 非网络);RUST-228 默认值口径 |

## 自我验收证据

- 六维探针当日实跑(本次侦察命令输出在案);webviewSecurity/caseSensitivity/hotReloadModuleIdentity 套件当日 unit 10659(2113d5f4 门禁)内绿;RUST-231 fuzz 面(db-clone fail-closed)当日 cargo 全绿。

## 诚实条款

- **webview CSP 样式内联是刻意放行**(`style-src 'unsafe-inline'`——各面板大量 style 属性;RUST-225 记账原样适用);脚本面 nonce+cspSource 双源已收。
- logAutoConnect 默认 true=自动连引擎日志端口(loggerPort 20022)——收集的是**用户自己引擎**的日志、本地展示,不外发;若用户把引擎日志端口暴露到不可信网络,那是部署面非本扩展面,如实划界。
- 「恶意插件」按 kode 现实=webview 数据注入面(XSS/CSP);VS Code 扩展间隔离由宿主保证,非本扩展可声明面。
- clone import 对目标库的写入=用户显式选择的目标(host/port/database 走表单+预留 fail-closed);未做 SQL 层之外的注入面审计(表名来自 def 推导非用户自由文本,quote_ident 承载)。
