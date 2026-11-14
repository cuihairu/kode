# RUST-008 审计与落地:自有协议版本化;公共 API 与内部存储隔离;插件默认无文件写/网络/任意执行权限

日期:2026-11-15。审计对象:todo.md RUST-008(「插件」= 本 VS Code 扩展,中文生态术语)。方法:逐判据审计 + 落地唯一真缺口(协议版本 TS 侧不查)。**结论:①协议版本两侧常量已有但 TS 侧只收不查——本批补上握手版本门;②③能力面全谱审计通过,登记裁定依据。**

## 1. 判据①自有协议版本化:已补 TS 侧握手版本门(真缺口,本批修)

- Rust 侧版本常量已有:`crates/kode-protocol/src/lib.rs:15` `PROTOCOL_VERSION = "0.2.0"`,经 `--version`(main.rs:170)、initialize 回包 `serverInfo.version`(server.rs:304)、health `serverVersion`(server.rs:661)三面报出。
- **缺口**:TS 侧 `KodeCoreClient` 收到 `serverInfo.version` 后从不比对——版本错配的新旧二进制会以互不认识的 RPC 形状静默对讲,漂移在首次请求才炸且炸因难读。
- 修法(`src/backend/kodeCoreClient.ts`):`KODE_PROTOCOL_VERSION = '0.2.0'` 常量(注释钉死与 kode-protocol 两侧同批改);initialize 回包版本不一致 → 杀子进程(**保留 client 可再 spawn**——用户原地换二进制后下一次 start() 自然恢复,不走 dispose 永久disposed 面)+ 抛 `KodeCoreTransportError('PROTOCOL_VERSION_MISMATCH')`。gate 侧既有 catch 把该错误归入回落 TS 面(`serveInRust` fallback),不误伤服务;重启路径走既有 RESTART_GAVE_UP 有界放弃。
- 测试:kodeFakeServer 增 `wrongVersion` 替身旗标,缺省回真版本;新钉「版本不一致 → PROTOCOL_VERSION_MISMATCH + childProcess=null + client 可再 spawn」。prove-red=暂摘版本门 → 该测试红(旧形 start() 正常 resolve)→ `cp`/`cmp` 还原复绿。kodeCore 家族 10 文件 126 例全绿(含真二进制 E2E/parity,`target/debug/kode-server --version` = 0.2.0 与门一致)。

## 2. 判据②公共 API 与内部存储隔离:审计通过

公共 API 面 = package.json contributes(命令/配置/视图)+ `$/kode/*` RPC;内部存储 = 进程内索引(EntityMappingManager/globalDataIndex/workspaceIndex/spaceDataIndex 的内存 Map+LRU)+ 派生缓存(`.kbengine/` 桩导出、tmpdir perf 资产)。核实:无任何公共命令直改内部索引结构(索引变更只经文件事件/配置事件面);`.kbengine/stubs` 是用户命令触发的**派生数据导出**(pythonStubExport,非数据真相,可重建——RUST-011 判据的域,该行单独审计);`$/kode/rpc` 方法面是 Rust 语义查询,无存储写入面。隔离成立。

## 3. 判据③插件默认无文件写/网络/任意执行权限:审计通过(default-deny 面)

| 能力 | 面 | 默认态与门 |
|---|---|---|
| 文件写 | quickActions 配置写、pythonStubExport、日志导出(save dialog)、debugConfig 生成、databaseWiring 用户编辑、cpuProfileCapture、临时编辑热更、pythonProcessConfig | 全部用户命令触发,无后台写用户文件路径;语言服务自身零写盘(索引全内存/派生缓存) |
| 网络 | telnet(user-config host/port)、数据库连接(user-config profile,命令触发)、热更 HTTP 通道(user-config)、httpRequestService(显式 URL+10s 超时) | 全部用户配置+用户触发,无遥测/无外呼默认面 |
| 任意执行 | kode-server spawn(自带二进制、自有协议)、pythonExecService(**只 compile() 不执行**红线,执行器源只 import json/sys/traceback)、ruff shell-out(选定解释器环境)、pip install(**同意式,绝不静默装**,2026-11-06 用户令)、pytest(测试面板用户触发) | 全部有界角色:无 eval 用户代码面,compile-only 红线注释在 pythonExecService.ts:24 |

## 4. 门禁

`tsc` RC=0;`npm run lint` RC=0;kodeCore 家族+parity 10 文件 126 例全绿;prove-red 闭环;全量 test:unit 见 todo 勾行注(与 RUST-007 当轮 10186+1 比对)。
