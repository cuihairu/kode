# RUST-149 横切收口:kode2 LSP 收编批五面韧性矩阵

2026-11-19。kode2 LSP 族 Rust 收编批(lane/todo-sweep)最后一条:按任务书
「随各条顺带写,最后单独收口」把五条决策核面的 stale response / cancel /
cold workspace / root 移除横切验收汇成矩阵,补齐唯一缺口(documentSymbols
零登记),登记 Core 重启维度的结构性 N-A。行留开:接线批(批 3+)真异步面
仍须按批 1 判例补 token/cancel。

## 五面 × 四维矩阵

| 面(载体) | stale | cancel | cold | root 移除 |
|---|---|---|---|---|
| references(RUST-138,c22feb18) | N-A(同步纯面,如实登记) | N-A | N-A(golden=语料冷装载) | **✓ lib 钉**:`invalidate_root` 后陈旧站点整个消失不虚报 + 查询域证据不变 |
| documentSymbols(RUST-139,cf17b4af) | **✓ 本批钉**(771f9bf6) | N-A(同步零 await 无取消位) | N-A(纯 text 函数,冷热同路) | N-A(per-document 面无根位;撤根语义归索引面,由 references/workspace_symbols 钉承) |
| workspaceSymbols(RUST-139,cf17b4af) | **✓** `def_update_swaps_hits_same_path` | N-A(同步纯面) | golden=语料冷装载 | **✓** `root_removal_drops_hits_and_keeps_other_roots`(被移除根命中消失,其他根保留) |
| signatureHelp(RUST-140,a0e92c7c) | **✓** 同路径 def 换代即换签名(不虚报旧签名) | N-A(同步纯面,登记) | 语料冷装载 | **✓** 撤根如实 miss(不虚报) |
| diagnosticLayering(RUST-142,2632e882) | **✓** `version_bump_replaces_published_items`(装配面级;异步 stale/cancel 记账由批 1 调度核十项 stale 迹 + coalescedStale/staleDropped 承) | 批 1 调度核(异步五守卫/取消记账)承;装配面纯同步 N-A | golden 重生成从语料冷装载 | N-A(装配面吃 findings 输入,无根位;根维度归索引面) |
| codeAction(RUST-143,b8fe4e99) | N-A(纯同步装配,无缓存) | **✓ 模块文档登记**:cancel 位=宿主面(provider 首行 `isCancellationRequested` → 空),纯函数 N-A | N-A(纯函数) | N-A(输入面无根) |

## 本收口补的缺口

`document_symbols` 是五面中唯一零 RUST-149 登记的面。补钉
`rust_149_recompute_swaps_tree_and_is_stateless`(crates/kode-server/src/
document_symbols.rs):同文本重复求值 deep-equal(无隐藏状态漂移)+ 文本
换代即换树(永不服务旧树)。纯函数无缓存,故 stale 结构性不可虚报,钉的
是其可观察契约而非缓存失效逻辑;cancel/cold/root 的结构性 N-A 理由写入
钉文档注释。

## Core 重启维度

五面均为纯库(零 RPC/零进程/零长持状态),Core 重启结构性 N-A。重启
语义在批 1 已收的 kodeCoreGate 面承:d124e7a4(重启冷却+版本账重置+
快照重放+kill-switch+kodeCoreGateRoots 换根重放)。接线批引入真进程/RPC
后须端到端复核。

## 诚实边界(行留开依据)

- 本批五面是**纯库决策核**,LSP provider 接线(server.rs RPC + TS
  provider token 面)归接线批;接线后真异步面按批 1 判例补 token/cancel
  (completion token 面已有先例)。
- 批 2 证据登记的 GAP 仍未收,批 3+ 候选:inlay 7 族 / codeLens 7 族
  cancel、references 族 stale(GAP 指 TS 接线层;Rust 纯库面本批已钉)、
  semanticTokens 异步化时补 token 面。
- 冷 workspace 维度在纯库面只等价于「语料冷装载」(golden 重生成即冷
  路径);真实 VSCode 冷启动(gate 冷却/首扫取消窗)批 1 kodeCoreGate
  面已钉,接线批仍须端到端复核。
- 本收口只动 Rust 测试面(771f9bf6)+ 文档,零生产语义变更;
  document_symbols.rs 附带 rustfmt 2021 归一(本 sweep 自有件,纯排版)。

## 批 3:TS 接线面 token/cancel(2026-11-19 收口)

按本收口「诚实边界」登记的批 3+ 候选,把 inlay / codeLens 家族的取消面按
批 1 判例补全(判例:真异步面每个 await 放行点复查令牌,取消后不再发起后续
解析;同步 provider 只设入口闸)。新增面:

| 面(文件:行) | 形态 | 闸位 |
|---|---|---|
| `CallChainController.provideCodeLenses`(defCallChainProvider.ts:89) | 真异步(逐方法 def 反查 await) | 入口 + 循环顶 + 每 await 后 + 返回前 |
| `DefParamInlayHintsProvider`(defParamInlayHints.ts:229) | 真异步(逐点位 def 反查 await) | 入口 + 循环顶(取消即空,反查次数冻结) |
| `DefPropsInlayHintsProvider`(defPropsInlayHints.ts:129) | 真异步(属性面单次 await) | 入口 + 放行前复查 |
| `KBEngineBuiltinTypeInlayHintsProvider`(inlay.ts:29) | 真异步(def 归属面 await) | 入口 + 放行前复查 |
| `KBEnginePropertyShadowInlayHintsProvider`(inlay.ts:125) | 真异步(扫描束 + 逐候选 def 反查) | 入口 + resolve 闭包入口/放行后 + 束 await 后 |
| `KBEngineProxyInternalAttrHintsProvider`(inlay.ts:228) | async 签名/同步体(桩副本同步 fs 读) | 仅入口闸 |
| `InferredMirrorTypeInlayHintsProvider`(inlay.ts:77) | 同步(镜像同步 fs 读) | 仅入口闸 |
| `GeneratedSourceCodeLensProvider`(generatedSourceLenses.ts:46) | 同步 | 仅入口闸 |
| `TypesXmlCodeLensProvider`(codeLens.ts:380) | 同步 | 仅入口闸 |

同一批补了测试缺口:此前 `tests/codeLensCancellation.test.ts` 只覆盖
property / rpc 两族。新增 `tests/cancellationTokenBatch3.test.ts`
(9 例):四个真异步面各钉「放行前复查 → 返空 + 解析次数冻结」(callChain /
defParam / defProps / builtinType),propertyShadow 钉「取消后不再反查后续
候选 + 入口零反查」,四个同步面各钉「活令牌出内容 vs 已取消令牌返空」两臂
对照(generatedSource / inferredMirror / proxyInternalAttr / typesXml)。
prove-red 六臂逐一扰动对应闸,各臂只咬自己那一条并 `cmp` 字节还原。

references 族 stale、semanticTokens 的 GAP 依本收口的登记不变(前者 TS 层
已由 references.ts 贯穿 token,后者待语义 token 异步化时补),本批不收。

## 门禁

- `cargo test -p kode-server`(--test-threads=4 口径):800 lib(799+本
  钉)+ 98 集成套件全绿;
- `cargo clippy -p kode-server --all-targets` rc=0;
- vitest 相关面(kodeDocumentSymbolsParity + kodeWorkspaceSymbolsParity)
  全绿;tsc rc=0。

## 载体

- 771f9bf6 `feat: rust resilience pin for document symbols`(本收口唯一
  代码载体)
- 勾行提交(见 todo.md RUST-149 行第三段证据)
