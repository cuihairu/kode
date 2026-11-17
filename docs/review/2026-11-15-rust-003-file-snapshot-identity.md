# RUST-003 审计与整改：文件快照身份标识与打开文件内存优先

日期：2026-11-15。审计对象：todo.md RUST-003「文件快照按 root + canonical URI + document version 唯一标识；打开文件内存优先」。方法：审计 + 逐处读码核实。

**结论：判据三轴在读面**（`src/sharedFileSnapshot.ts`）**已经齐备**——快照对象上就有 `rootId` / canonical `uri` / `version`（document 域=编辑序号、disk 域=mtimeMs，`source` 字段区分两域不做跨域比较），「打开文件内存优先」在同步/异步/批量三条读路径上成立且有测试钉死「不读盘」。**真差距在绕开读面的旁路面**：其中 def 调用链的 python 读面同时踩两轴（无缓冲区优先 + `path.normalize` 非 canonical 身份 + mtime/size 对未保存编辑盲），本批已修。其余旁路面核实后逐条裁定，不凑数。

## 1. 已满足面（读面）

| 判据轴 | 出处 | 状态 |
|---|---|---|
| root | `sharedFileSnapshot.ts:122/:137` `rootId = deps.resolveRootId(...)`（生产=`SemanticIndex.resolveRootIdForPath`，最长前缀匹配） | 字段在 |
| canonical URI | `:116/:138` `uri = normalizeFileIdentity(fsPath)` | 字段在 |
| document version | `:125-127` document 域=`document.version`；`:140` disk 域=`mtimeMs` | 字段在 |
| 打开文件内存优先 | `:117-131`（同步）、`:159-173`（异步）、`:99-106`（批量 `collectOpenDocumentTexts`）：命中打开文档即返回缓冲区 `getText()`+`document.version`，`source:'document'`，**不触发任何磁盘读** | 三路径成立 |

`normalizeFileIdentity`（`backend/pathIdentity.ts:2`）口径已核实：反斜杠→`/`、词法折叠 `..`（POSIX 语义）、丢 `.`/空段、Windows 盘符根不可弹、UNC 前两段不可弹、裸盘符段→小写盘符根、Win 盘符/UNC 整体小写而 POSIX 保留大小写。`normalizeDocumentKey`（`backend/documentStore.ts:57`）对 file/空 scheme 走同一路径归一，非 file scheme 用 `uri.toString()` 原串——两域键不同形，跨域永不碰撞。

**版本比对已有真实消费**：`databaseSchema.ts:625` `current.source !== recorded.source || current.version !== recorded.version` 判漂移（IDE-SNP-006 的 `SharedFileVersionRef`）。但其注释明示「有文件读取副作用，禁止在查询热路径调用」——version 比对是**对账安全网**，热命中走配置轴 + 事件失效面，不是查询判据。

## 2. 已修：def 调用链 python 读面（真缺陷，两轴同时踩）

`src/backend/defCallChain.ts` `readPythonFileWithMtimeCache`：

- **无缓冲区优先**：直接 `fs.statSync`+`fs.readFileSync`，不看 `vscode.workspace.textDocuments`。编辑器里改了未保存 → mtime/size 不变 → 命中旧盘缓存，**调用链里看不到未保存的 python 改动**；
- **身份键非 canonical**：用 Node `path.normalize(filePath)`——**不折叠 `..`、不套盘符/UNC 大小写规则**，同一文件的不同拼法形成两个缓存条目，命中率与失效判定同时失真；
- 缓存内容来源是磁盘，与「打开文件内存优先」相悖。

修法：先查 `vscode.workspace.textDocuments`，`normalizeDocumentKey(document.uri) === normalizeFileIdentity(filePath)` 命中即返回 `getText()` 且**不入盘缓存**（把缓冲区内容按 mtime/size 缓存正是该缺陷本身）；未命中才落 `readDiskPythonFile`，缓存键改 `normalizeFileIdentity`。文件系统访问仍用原拼写 `filePath`——identity 已折叠 `..`/`.`，不是必然存在的盘路径，identity 只作缓存键。

**测试**：`tests/defCallChainOpenDocument.test.ts`。既有 4 个 defCallChain 测试全经 `options.readPythonFile` 注入替身，**缺省读面零覆盖**——本测试**不注入**，逼出真默认实现，逼它去读磁盘上已存在的 `.py`。断言落点是「调用链边来自缓冲区内容」而非函数返回值：盘上写 `self.cell.diskTarget(1)`、编辑器未保存内容写 `self.cell.bufferTarget(1)`，断言链边出现 `bufferTarget` 且不出现 `diskTarget`——回归成读盘则链形改变，不是靠接口形状自证的假绿。

**prove-red**：把缓冲区命中改成 `continue`（跳过缓冲区、强制读盘）后测试**红**（`expected false to be true`）；`cp` 备份还原 + `cmp` 字节校验一致后 1 passed。

## 3. 核实后的旁路面裁定（不凑数）

以下路径确实绕开读面，但**逐处核实后不构成「未保存内容被旧盘内容顶掉」**，故如实登记为设计选择或已兜住，不修不声称已修：

| 面 | 位置 | 裁定 |
|---|---|---|
| 生成器三处直读盘 | `generatorForms.ts:607`（entities.xml）、`:677`（types.xml）、`:745`（entity def） | **误判，实为正确**。三处上方均有 `findOpenTextDocument` 分支且 `return`（`:586-604`/`:745` 同理）——打开时走 `insertIntoOpenBuffer` 写缓冲区，`:607` 只在文件**未打开**时可达，读盘正确。与 `codeGenerator.ts:600/:675` 的 `readSharedFileSnapshot` 是同一语义输入的两种实现，均先查打开文档 |
| 模板覆盖读盘 | `codeGenerator.ts:1028` | 读 `.kode/templates/` 项目模板覆盖，非引擎输入；同文件 `:600`/`:675` 才是引擎 XML 读面且已走快照。不属本判据的语义输入 |
| `isDirty` 门控 | `globalDataIndex.ts:414`/`:752` | 只认脏文档。已保存的打开文档其磁盘内容本就等于缓冲区，不回落缓冲区不丢信息。是缓存键设计选择，非未保存内容丢失 |
| 快照身份在读面被降级 | 28 处 `readSharedFileSnapshot` 调用点 | **25 处只取 `content`**，`version`/`rootId`/`source` 丢弃（降级为纯文本）。真正用 `{source,version}` 维度的只有 `databaseSchema.ts:284` 与 `rename.ts:224`。登记：身份在生产但多数消费点未承接 |
| `rootId` 无生产消费 | `snapshot.rootId` | src 内零使用（唯一断言在 `tests/sharedFileSnapshot.test.ts:83`）。实际缓存键用的是**查询上下文**的 workspaceRoot（`databaseSchema.ts:451`），不由快照自身身份决定。判据的「root」维度目前由调用方上下文承担 |
| `defFingerprintLedger` 裸 fsPath 键 | `backend/hotReloadDefFingerprintLedger.ts:51` | 键是未归一的裸 `fsPath`，无 root/version。同文件不同拼写在 Windows 上成两个台账条目。登记不修（热更回执面，影响面限于台账条目分裂） |

**未修不声称**：`definitionSemantics.ts:151`/`:244` 的缓存键不含 version 且 src 内无 `.clear()`/失效调用；`entityMapping.ts:1938`/`:2685`、`entityMappingHelpers.ts:361` 直读盘（与同文件 `:2336`/`:2389` 走快照面形成两套读面，但 `:2434-2449` 用 `collectOpenDocumentTexts` 在查询时补正——缺陷被下游兜住，首扫本身仍读盘）。登记为后续批次，不在本批改。

## 3.1 后续批次（2026-11-15 收口）：definitionSemantics 缓存身份化

上表「未修不声称」中登记的 definitionSemantics 缓存面已收口：`localCache`/`resolvedCache` 条目从裸语义改为**身份集合条目**（`identitySet: 归一路径键 → 快照 {source,version} 令牌`），命中前逐文件重探令牌，任一漂移即重解析——键内身份替代失效调用，`src` 内依旧零 `.clear()`，结构性吃不到旧值。

- **消费集事实源**：`ResolutionContext` 新增 `consumed` 集（只增不减），与 `visited`（环守卫，进出回退）分离——首批实现曾误把 `visited` 当消费集，而它在解析完成时恰好回退为空集，身份集合恒空 → 空集合命中恒真 → 永久假新鲜（tests/definitionSemanticsIdentityCache.test.ts 逼出）。入口/父/接口/组件全部经 `resolveSemanticsFromLocal` 登记，三个子上下文构造位透传 `consumed`。
- **轻量身份探针**：`sharedFileSnapshot.ts` 新增 `readSharedFileSnapshotIdentity`（document 域=编辑序号零 IO、disk 域=一次 stat），与快照读同一 deps/归一键，不养第二套打开文档判定。
- **入口根修复**：`loadResolvedAt` 恒传 context 后旧内部的 `originRootOf(defPath)` 兜底不再可达——双根同名父回解退化逐根首命中（IDE-IDX-002 既有钉 A/B 串根红逼出），context 显式携带 `originRoot`。
- **测试**：`tests/definitionSemanticsIdentityCache.test.ts` 五例全走「同一 loader、文件在两次查询间被改」：入口 mtime 漂移（loadLocal/loadResolvedAt）、入口未变父变了（visited≠consumed 的红面）、打开文档 version 前进、删除后不落陈旧 null。**prove-red**：剥 `context.consumed.add` → 身份集合恒空 → 空命中恒真 → 2 红；cp/cmp 字节还原复绿。
- 门禁：tsc 0 / eslint 0 / unit 834 文件 10246+8skip 0 红 / xvfb demo 25 RC=0。
- 剩余登记面（不在本批改）：25/28 快照调用点只取 content（消费点未承接身份，正确性无需）；`hotReloadDefFingerprintLedger` 裸 fsPath 键（热更回执面）；entityMapping 首扫读盘+查询兜底双面（下游兜住）。

## 4. 门禁

`tsc` RC=0；`npm run lint`（`eslint src --ext ts`）RC=0；`tests/defCallChain*.test.ts` + `flowFailureSamples` 5 文件 39 passed；`defCallChainOpenDocument` prove-red 红→还原绿；`test:unit` 全量 **10185 total / 10177 passed / 8 skipped / 0 failed**，3303 套件全 passed（JSON 报告口径；两个整文件 skip 为环境门控——`playerDataCloneMysqlReal` 要 MySQL port、`runtimeCommands` 同类，非本批）；`xvfb-run -a test:demo:editor` **25 passing** RC=0。与 RUST-002 当轮口径（822 文件 / 10184 例）比对：本次 823 文件 / 10185 例，差值恰为本批新增的 1 个测试文件 1 例，**零消失**（本批曾误记基线为 10225，已更正）。

锚点：`perfCallChainDoc.test.ts` ANCHORS 表**不含** `src/backend/defCallChain.ts`（核过），本批改该行号不触发锁步。
身份化批次改 `definitionSemantics.ts`/`sharedFileSnapshot.ts` 行号——ANCHORS 表两者均不含（核过），不触发锁步。

## 5. 登记面收口裁定（2026-11-17，RUST-003 关账批）

§3 尾登记的三面于 2026-11-17 逐面裁定并补契约，RUST-003 就此关账：

1. **`hotReloadDefFingerprintLedger` 裸 fsPath 键**——新证据：装配侧（HR-PR-02..08 接线批）尚无生产调用点（`evaluateDefFingerprintChange` 除测试外零引用，grep 全 src 实证），串册风险 contingent on 装配的键形选择。本批交付mitigation=模块头注**键形态契约**（键必须根无歧义，多 root 同相对路径是两个文件；台账纯核不解析路径，区分度责任在装配）+ tests/hotReloadDefFingerprintLedger.test.ts「键形态契约」两例钉（两 root 绝对键互不相串；同键重记录=时间性覆盖语义）。装配批接线时受此契约约束。
2. **25/28 快照调用点只取 content**——复核维持原判：identity 字段的 src 内消费者为零（rootId 零消费、version 仅 databaseSchema.ts 对账安全网），「只取 content」的调用点无 correctness 需求；字段在快照对象上齐备供未来消费者承接，丢弃无缺陷。
3. **entityMapping 首扫读盘+查询兜底双面**——复核维持原判：直读位（entityMapping.ts readFileSyncUtf8Recorded 两处+entityMappingHelpers.ts 一处）与查询面 `collectOpenDocumentTexts()` 并存结构在当前行位实证（行号较本审计日漂移：1938→1942 等，结构未变），下游兜住判定成立；首扫读盘=索引构建期设计选择。

任务书两轴「root + canonical URI + document version 唯一标识」「打开文件内存优先」均已落地并有测试钉（两批次 d38d9537+99fd303d+本契约批），登记面全部裁定完毕，无开放缺陷残留。