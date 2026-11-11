# KSEM-BAS-02 引擎契约版本登记账(2026-11-12)

todo.md「KSEM-BAS-02」交付物。**分工**:本账登记**版本/钉点/漂移/切换机制**
层;语义行为契约表(9 条,cellData 初始化/onGetCell/onWriteToDB/entity_call/
method/FIXED_DICT/ENTITYCALL/创建 API/spaceData)由
[2026-11-11-ksem-bas-01-02.md](2026-11-11-ksem-bas-01-02.md) 第二节承载
(基线同为 3082ab5),两文件互补不重复。

方法:全库扇出侦察引擎事实消费面(29 面)+ 逐面源码核对 + 本机 fork 树
(`../kbengine` = cuihairu/kbengine)拓扑/漂移实测。**口径**:登记的是
「kode 断言的引擎事实以哪个引擎提交核实」;无钉点=事实只有 file:line
锚、引擎移动即静默失效,是登记缺口非缺陷。

---

## 1. 引擎提交版图(fork:cuihairu/kbengine)

| 提交 | 含义 | 拓扑(本机实测) |
| --- | --- | --- |
| `3082ab5` | 现本机树 HEAD(2026-11-07,pyscript vector repr 有界写);KSEM 设计依据/控制台链审计/def-flags 复核基线 | 契约现行基线 |
| `f85ad81` | 审计钉点(2026-11-06):watcher 请求号表、基元 utype 装载序、bots 调研、LIV 证据 | HEAD 祖先,**94 提交漂移**(见 §4) |
| `c2a3b8f` | 知识库 grounding 基钉(kbe/src file:line 大盘) | 在 f85ad81..HEAD 区间内(README 提交) |
| `6d12b8f` | 部分知识页落稿时的 fork HEAD | HEAD 祖先 |
| `28d2117` | typings 派生钉点(2026-10-21「align engine typings with source evidence」):vendored `typings/KBEngine` + 参考快照 | 早于 f85ad81 110 提交;**typings/ 目录此后零漂移** |
| `0bc93d5` | 证明 fork 从无 `version.h`(C-14 双标记探测依据) | 历史提交,一次性证据 |
| `855a06d` | fork BUILD-NOTES(python-version-baseline 历史引) | 历史提交 |
| `bf1a9cd6…` | **上游 kbengine/kbengine v2.5.10**:PA-001 wire 取证基准(schema/protocol crates + wire-protocol 文档) | 上游 tag,与 fork 线独立 |
| `2f8b1a6` | PA-001 取证时引擎 HEAD(所引目录核实未变) | 取证时点 |
| `e257ab7` | kbengine-build 树(windows-msvc-fix 分支,PY_SSIZE_T_CLEAN) | **不在契约线**,构建树单列不入账 |

引擎版本标识:kbeversion.h 三宏 `2.5.10`(MAJOR 2/MINOR 5/PATCH 10,
本机实测);fork 无 version.h(0bc93d5 证明)。探测双口径见 §5 边界。

## 2. 契约登记表(按钉点分组)

### A. 钉 f85ad81(94 提交漂移——§4 已复核)

| 契约面 | 源码符号 | 角色/行为 | 守护 |
| --- | --- | --- | --- |
| `src/sdk-gen/sdkMessageNumberAudit.ts:15` | `datatypes.cpp` `DataTypes::initialize` addDataType 序 + `datatype.cpp:87-92` `_g_dataTypeUID++`(初值 1) | 21 基元 UINT8..VECTOR4=utype 1..21,消息表基元面逐条咬合,SDK 内建映射缺名点名 | 纯测 `sdkMessageNumberAudit.test.ts`(钉 commit 字面量);消费 `clientSdkGenerator.listClientSdkBuiltinTypeNames` |
| `src/watcherProtocolAudit.ts:22`(watcher 半) | `messages_fixed_defaults.xml` `<Component::queryWatcher><id>`(dbmgr 41006…interfaces 41007)+ `console_helper.h:11` 65502 | 生产 `kbengineProtocol.ts` `WATCHER_QUERY_MSG_IDS`/回调 id 逐键锁 | 纯测 `watcherProtocolAudit.test.ts` |
| `src/backend/botsControl.ts:4` | `kbe/src/server/tools/bots`、`KBEngine.addBots/read-only bots`、telnet 51000 python 层 | addBots 命令串形态/白名单;**无逐 bot 销毁 API=诚实边界** | 纯测 `botsControl.test.ts` |

### B. 钉 3082ab5(现行基线)

| 契约面 | 源码符号 | 角色/行为 | 守护 |
| --- | --- | --- | --- |
| `src/watcherProtocolAudit.ts:87`(console 半) | `messages_fixed_defaults.xml` Logger 701/702/703、`console_helper.h:10` 65501、LogWindow.cpp:376-433 线序 | 控制台日志/观察链 id 与 wire 序 | 纯测 `consoleProtocol.test.ts`;live 证据 `liveWatcher/liveSpacesVerification` 嵌 commit |
| `src/backend/kbengineProtocol.ts`(注释钉) | `common.h` COMPONENT_TYPE 枚举 0..14、`network/common.h` KBE_PORT_START+86=20086、`debug_helper.h` 0x7ff/level bits、CELLAPPMGR querySpaces 50003 | 生产协议常量族 | **引擎树条件测**(read 活树 common.h/console_helper.h,skipIf 无树)`kbengineProtocol.test.ts:235` + 纯测 gaps/readers/socket |
| `docs/knowledge/def-flags.md:8,209` | `entitydef/common.h:19-28` ED_FLAG_*(ED_FLAG_BITS 116)、`:41-55` 域掩码、`entitydef.cpp:161-174` g_entityFlagMapping 12 拼写 | 实体流转图 Flags/Exposed/持久化语义全链 | `entityFlowGraph.test.ts`(纯,锁 bit 值)——模块本体无钉(§3 缺口 2) |
| `docs/knowledge/entity-migration…`、guiconsole 设计、demo-hot-reload、KSEM 设计文档 | 各自 file:line | 知识/设计 grounding | 文档级 |

### C. 钉 c2a3b8f / 6d12b8f(知识库 grounding)

| 契约面 | 源码符号 | 角色/行为 | 守护 |
| --- | --- | --- | --- |
| `docs/knowledge/api-*.md`(C-21 → `src/generated/apiDocs.ts` 225 条 + kode-mcp `assets/api-docs.json` + `explain.rs`) | 逐条 `sourceRefs` file:line(如 entity_macro.h:1387) | hover/API 文档/MCP explain 内容 | 纯测 `apiDocsParity/apiDocsRustParity/pythonApiHoverDocs`;explain.rs 钉 `kbengine@c2a3b8f` 字面量(entity-migration 钉 3082ab5,测 :285 断言) |
| `src/hooks.ts` 回调表 | baseapp/cellapp entity.cpp、proxy.cpp、witness.cpp 逐回调 sourceLocation | 「源码没有的回调绝不列出」;签名取 Py_BuildValue 格式串 | **引擎树条件测** `hooks.test.ts:86` 逐行回验;模块无钉(§3 缺口 5) |
| `src/backend/entryHooks.ts` ← `entry-script-spi-methods.md:5-6`(**记 3082ab5 复扫不变** :142-149) | kbemain.h parseMainCommandArgs 等、cellapp space/nav 三件套 | 入口脚本 SPI 表 | **引擎树条件测** `entryHooks.test.ts` |

### D. 钉 28d2117(vendored 桩)

| 契约面 | 源码符号 | 角色/行为 | 守护 |
| --- | --- | --- | --- |
| `typings/KBEngine/`(23 文件)+ `typings/README.md:6,9` | fork `typings/` 布局;kode overlay=Entity.pyi cellData/Proxy.pyi 账号属性/_vectors.pyi | 22 文件清单、`__init__.pyi` 再导出序=影子契约、copy-if-absent 激活 | 纯测 `kbengineStubTemplate.test.ts`(钉 28d2117 字面量+清单);VSIX 暂存守卫 `vsix-staging.mjs`;派生闸 `scripts/derive-kbengine-stub-typings.mjs:38-49`(pin=fork typings 目录末次提交,mismatch exit 1,显式覆盖口存在)+ 清单漂移 fail |
| `src/kbeModuleIndex.ts` KBE_SYMBOLS 36 条 | `typings/_KBEngine_*.pyi` sourceFile:sourceLine + 直锚 `kbe/src/lib/pyscript/vector*.h`(cppClassName ScriptVector3 等)、`fixedarray/fixeddict.h` | kbe.KBEntity 跳转/补全/桩文档;KBEntity 别名诚实标注;KB-VER-002 分层 baseline|fork|pending(:148 单条 pending=运行时归属待取证) | **引擎树条件测** `kbeModuleIndex.test.ts:368` 逐条回验;模块无钉(§3 缺口 4) |

### E. 钉上游 bf1a9cd6(v2.5.10 wire 取证,离线 crates)

| 契约面 | 源码符号 | 角色/行为 | 守护 |
| --- | --- | --- | --- |
| `crates/kode-kbengine-schema/src/schema.rs:62` ENGINE_BASELINE | `messages_fixed_defaults.xml` 字节级副本、`message_handler.cpp:140-229`/`fixed_messages.cpp:29-74`、arg=v2.5.10 风格、merge 序 parent→interface→self | 静态消息 id/arg/长度、notFoundError、项目 override | `schema_units.rs`/`coverage_units.rs` 头注引 baseline;golden 带 engine_baseline 字段 |
| `crates/kode-kbengine-protocol`(lib.rs:17) | `common.cpp:20-70` datatype2id、framing READ_ID→LEN→LEN_EX、NUL 串语义、hello 重握手 | 消息 id 映射/成帧/解码;**TODO-2 ENTITYCALL、TODO-3 属性同步未钉** | `protocol_units.rs`/`framing_fuzz.rs` 等;SNAPSHOT.md 记 baseline |
| `docs/kbengine-wire-protocol.md`(PA-001) | 上表上游引据 + `2f8b1a6` 时点核实 | §3.1-§11 wire 契约文档 | 文档级(取证族 crates **未接线编辑器**,BAS-01 已记待核实) |

## 3. 无钉点契约清单(登记缺口:file:line 锚、无 commit)

1. `src/backend/serverConfigCatalog.ts`(255 键) + `scripts/gen-config-catalog.mjs` → `crates/kode-mcp/config_catalog.rs`——锚 `kbengine_defaults.xml:588-716` 等 + `serverconfig.cpp` 读取点;建账 2026-11-03(时树=f85ad81)未记。守门=引擎树条件测 `serverConfigRealDefaults`(读活树 942 行 XML)+ `serverConfigSourceComments` + CI 漂移闸 `gen-config-catalog --check`。
2. `src/backend/entityFlowGraph.ts`——ED_FLAG/域掩码/Exposed 门全链 CITATIONS 块(:303-380),钉点只在伴生 def-flags.md。
3. `src/backend/messageTableEngine.ts` + `src/messageTable.ts` + `crates/kode-server/src/message_table/constants.rs`——utype 分配/别名 id 4..255/保留名/方法 uid 溢出语义,file:line 直引;f85ad81 绑定只经 tradeoff 文档。
4. `src/kbeModuleIndex.ts`(见 §2.D——typings 面间接 28d2117,直锚 kbe/src 面无钉)。
5. `src/hooks.ts`(钉点在知识页 c2a3b8f,模块内无)。
6. `src/backend/kbengineMetadata.ts`(datatypes.cpp 基类型集/ARRAY 特例/FIXED_DICT 只经 types.xml/无 BOOL·TUPLE——引擎树条件测守)、`kbengineStartupScript.ts`、`telnetClient.ts`(password: 字面量/IAC 5 连/`:quit` 杀进程=恒拒)、`userTypeContract.ts`(datatype.cpp:2383-2397 三方法契约)、`redisKeySpace.ts`(kbe 前缀/entitylog 字段)、`entitiesXmlAnalysis.ts`(utype=清单序)、`propertyDirectionDiagnostics.ts`(createCellData/baseapp.cpp:2561)、`serverConfigAnnotations.ts`(xml.cpp IntText 注释位)、`definitionWorkspace.ts:393`、`generated/flagDomains.ts`(canonical=kode-parser flag_domains,Rust↔TS golden 锁步)。
7. `src/engineVersion.ts` 预设面(2.5.10=kbeversion.h 三宏口径,运行时发现非钉点)。

**结构性风险(登记为本账核心机制动机)**:引擎树条件测试套件(11 文件:
entryHooks/hooks/kbeModuleIndex/integrationTagWiring/kbengineStartupScript/
kbengineProtocol/kbengineMetadata/realEngineIntegration/
serverConfigSourceComments/serverConfigRealDefaults/engineTreeProbe)对
`../kbengine` 活树断言行级事实,**断言落稿时针对的提交无处记录**——树一
动测试静默重定基线(或红),不知道「哪个提交核过」。本账 §5 机制补此洞。

## 4. 漂移复核实录(f85ad81 → 3082ab5,2026-11-12 本机实测)

94 提交、kbe/src 37 文件 6781+/564-。契约相关目录差集与逐项复核:

| 锚定面 | 漂移内容 | 复核结论 |
| --- | --- | --- |
| 基元 utype 装载序(§2.A) | `datatypes.cpp` 仅 `delDataType` 删一行 `decRef`(d2ccd8c 双释放修复) | **`initialize` addDataType 序 21/21 逐条对拍现树一致——复核通过** |
| watcher 请求号(§2.A) | watcher 相关文件**零漂移** | 复核通过 |
| vendored typings(§2.D) | 28d2117 后 typings/ **零漂移**(110 提交) | 派生钉点仍现行 |
| entitydef 结构面 | `entity_component.cpp`+5(销毁路径空模块守卫)、`method.cpp`+6(失败参数置 None)——**运行时守卫,不触声明结构/Exposed/Flags/组件槽语义** | 静态契约不受影响 |
| 控制台链/协议常量(§2.B) | 落稿即对 3082ab5 | 现行基线,无需复核 |
| 其余漂移 | cellapp/baseapp/dbmgr/network/pyscript 运行时修复(teleport/id 池/blowfish/pickler 白名单/vector repr) | 均运行时面,现库无静态契约锚定;PA-001 wire 面(上游 bf1a9cd6)不受 fork 线影响 |

**判定:全部既有契约对 3082ab5 复核通过,零待复核项。**(下一节机制
供未来切换用。)

## 5. 切换引擎版本机制(树动时必走)

1. **定位漂移**:`git -C ../kbengine rev-list --count <旧钉>..HEAD` +
   `git diff --name-only <旧钉>..HEAD -- kbe/src/`,对照 §2 各面「源码
   符号」列,命中即该契约**标记待复核**;
2. **复核面**(命中者):审计表逐条对拍现树(sdkMessageNumberAudit 式
   实读);引擎树条件测试在活树重跑(注意:套件断言落稿提交按 §3.7
   补记);`gen-config-catalog --check` 漂移闸;`derive-kbengine-stub-
   typings.mjs` pin 闸;
3. **标记落账**:本账 §4 增行记「钉点 A→新 HEAD N,受影响契约 X..Y,
   复核结论/待复核」;复核未做的契约在本账与消费任务处标待复核,
   **不得静默沿用**;
4. **钉点更新**:复核通过后把对应契约面的钉点字面量/注释更新为新
   HEAD(如 watcherProtocolAudit 两半各改),并重跑其守护测试;
5. **kbeversion.h 版本宏变动**(非 2.5.10)时:engineVersion 预设口径、
   PA-001 v2.5.10 arg 风格、schema ENGINE_BASELINE 一并待复核——上游
   线与 fork 线分别处理,不互推。

**边界与诚实记录**:
- 引擎树探测双口径并存(登记不合并):产品面 `engineApiMetadata.ts`/
  `engineTree.ts` 双标记 version.h|kbeversion.h;测试面 `engineRoot.ts`
  用 `kbe/src/lib/entitydef` 目录存在——两口径语义不同(版本可读 vs
  树可用),行为如实;
- kbengine-build@e257ab7(win-msvc-fix 分支)是构建树,不入契约账;
- 本账为登记交付,不宣称任何新功能落地;§4 复核是只读对拍,未改任何
  生产钉点字面量(f85ad81 钉点保持原值:现树复核通过 ≠ 重钉,重钉须
  走 §5.4 并跑守护测);
- 并发会话落的行为契约表(2026-11-11-ksem-bas-01-02.md §二)与本账
  基线一致(3082ab5),其行号证据本次未逐条复验(该表 9 条属未来
  KSEM-CELL/RPC/SER 任务的输入,届时逐条复核)。
