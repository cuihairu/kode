# RUST-001 审计与整改：扩展宿主同步执行面

日期：2026-11-15。审计对象：todo.md RUST-001「扩展宿主不得同步执行全仓扫描、语义求解、全量 XML 解析、巨型日志处理」。范围 `src/**/*.ts`（不含 `src/test/**`）。方法：逐类定位调用点，核 await 边界、并发上限与激活链位置；结论只认读到的代码。

**结论：查出 3 处真违规面,已修 2 处(激活同步段全仓 walk、命令期 def 语料同步载入),残余 def 语料面与低危面如实登记为后续批次。** 不替旧实现圆场。

## 1. 已修(本批落地)

### 1.1 激活同步段全仓 walk(RUST-001 ① 违规,已修)

`src/workspaceDiscovery.ts` `scanWorkspaceAnchors`(:132)是 `fs.readdirSync` 递归 walk(深度 ≤7 `DEFAULT_SCAN_DEPTH` × 条目 ≤20000 `DEFAULT_SCAN_MAX_VISITED`,自带实测注释 **40.5ms/次巨仓冷跑**),原由 `src/activate/languageServices.ts:308` 在 `startKbEngineIndexing()` **激活同步段**逐 workspace folder 同步调用。

修复:新增 `preheatDiscoveryScanActivation`(`src/workspaceDiscovery.ts`):有界 Rust 扫描器(`$/kode/workspace/scanAnchors`,5s 超时,代际+缓存新值守卫)优先;Rust 不可用时 `setImmediate` 让出一个宏任务再走既有同源 `scanCache` 兜底。激活同步段不再付这段 walk。

**诚实边界**:兜底段本身仍是同一条有界同步 walk(与交互冷触发同口径),本批只保证它**不在激活同步段上执行**;逐目录 `fs.promises.readdir` 的真异步 walk 属后续批次,不声称兜底段非阻塞。

### 1.2 命令期 def 语料同步载入(RUST-001 ③ 违规,已修)

`src/defMd5Check.ts` `collectDefMd5Inputs` 按 `**/*.def` 逐文件 `deps.readText` 读 def 语料,缺省实现 `readSharedFileSnapshot` 对未打开文件走 `readFileSyncUtf8Recorded` 磁盘补载——循环内无 await,命令期把整仓 def 载入压成一个阻塞段;`findEngineSdkStamps` 同形。

修复:`DefMd5CheckDeps.readText` 签名改 `Promise<string | null>`;新增 `readSharedFileSnapshotAsync`(`src/sharedFileSnapshot.ts`,缓冲区优先语义不变、磁盘补载走已有记账异步入口 `readFileUtf8Recorded`,故未新增 `src/backend/fileReadMetrics.ts` 的函数,复用既有);def 语料改**有界并发**(8 路,`DEF_MD5_READ_CONCURRENCY`,与 `globalDataIndex.ts:153` `INITIAL_SCAN_CONCURRENCY` 同口径),盖章面按至多 `SDK_SCAN_FILE_CAP` 顺序 await。

**顺序无关性依据**:Rust 侧 `defs` 收进 `HashMap` 聚合(`crates/kode-server/src/def_md5/mod.rs:1175`),摘要与读取次序无关。

prove-red:把并发批改回逐文件顺序读(旧形态)后,新例 `def corpus reads concurrently and bounded` 峰值断言 `expected 1 to be greater than 1` **红**;还原后 22/22 绿。

## 2. 通过面

| 类 | 裁定 |
|---|---|
| ② 语义求解(全仓面) | ✅ 跨文件索引读取+解析均异步、有界并发 worker 池(`globalDataIndex.ts:153/345`、`pythonClassIndex.ts:527` `parsePythonFileResponsive` 走 `pythonParserWorkerHost` Worker);单文档求解由当前文档文本驱动,无宿主同步全仓求解入口 |
| ④ 巨型日志处理 | ✅ 全异步 + 硬上限:`logErrorScan.ts` `ERROR_SCAN_MAX_FILE_BYTES = 64MB`(:19)、超限 :242 跳过并留 `readError` 文案不截断硬判、`await deps.stat/readDirectory`;`backend/logHub.ts` 分块预算(1MiB chunk / 64KiB 轮 / 128KiB 批 / 10000 事件 8MiB 上限 + 轮时间片);`playerDataCloneImportGuard.ts:16` `createReadStream`+`for await` 真流式 |

文件枚举统一经 `findFilesAcrossRoots`(`scanRoots.ts:280` `await vscode.workspace.findFiles(glob, exclude, undefined, token)`);`scanRoots.ts:232-264` 外部根走 `fs.promises.readdir` + 每 256 条目 `setImmediate` 让出。`spawnSync/execSync/execFileSync`:全 src 仅 `src/debugConfig.ts:1089`(`listProcesses` 用 `ps`/`tasklist` 列本机进程,命令期);无未 await 的 `findFiles`/`readDirectory`/`textSearch`。

## 3. 残余面(如实登记,不修不声称已修)

| 面 | 位置 | 规模 | 处置 |
|---|---|---|---|
| def 语料同步读+解析 | `backend/defReferenceGraph.ts:156-165` `buildFileIndex`(`readdirSync` 递归 defs 根 + 逐 def `readFile`+`parseDef`+`parseDefFileSemantics` 全驻留);由 `activate/utilityCommands.ts:88/122` 同步调用 | 单 defs 根(`interfaces/`+`components/`+根三处),非全仓 | 后续批次:改有界并发异步 + 解析让位 |
| def 语料同步读+解析 | `backend/defRenamer.ts:630` `listDefFilesRecursive` + `:476`/`:815` 消费 | 同上,单 defs 根 | 同上 |
| def 语料同步读 | `activate/diagnostics.ts:1678-1696` `collectTopologyDefInputs`(三根全量 def 同步读,注释自陈为逐文件重算的全局输入;解析已交 Rust `validateProcessTopologyInRust`) | 全项目 def | 后续批次:读相异步化 |
| def 闭包同步读+解析 | `backend/defAnalyzer.ts:478` `collectInheritedNames`、`backend/defChain.ts:61-130`(hover 路径) | 闭包有界,非全仓 | 单文件交互链;登记不修 |
| 实体方法 owner 同步读 | `entityMappingHelpers.ts:355-361`、`entityMapping.ts:1929-1945`(循环同步 `readFileSyncUtf8Recorded`,循环后才 await Rust) | 单实体方法文件集 | 低危,登记 |
| 同步子进程 | `debugConfig.ts:1089` `execSync`(列进程,命令期) | 单命令 | 后续改 `execFile` promise |
| 休眠违规 | `backend/pythonReturnTypeInference.ts:144` `collectProjectPythonFiles`(全仓递归 `readdirSync`,≤20000,**无深度上限**;无生产调用者,`:175` 异步版才被用) | 全仓 | 后续批次删除或加深度上限 |

`pythonClassIndex.ts:1014` 有 `SCAN_CHUNK_SIZE` 分块,登记为「分块但仍同步段」,同属后续批次。

## 4. 门禁

`tsc` RC=0;`lint` RC=0;`defMd5Check` 22/22;`workspaceDiscovery{Top3,Rust}`+`workspaceDiscovery` 56+1skip;`test:unit` 819 文件 10161+8skip RC=0;`xvfb-run -a test:demo:editor` 25 passing RC=0。

锚点锁步:激活预热块改异步入口注释 +4 行 → `perfCallChainDoc.test.ts` ANCHORS 表 `activate/languageServices.ts` 340→344、741→745（204/277/128 在块前不动),`docs/perf/2026-baseline.md` 两处出处同改;真位重探核对一致。
