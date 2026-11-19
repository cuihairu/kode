# RUST-139 批 2:WorkspaceSymbol 快速搜索决策核(root 集 + effective 折叠 + 组件槽面)

日期:2026-11-19
todo.md 行:`RUST-139(旧 LSP-002) DocumentSymbol/WorkspaceSymbol:稳定排序+快速搜索。`
本批边界:**检索决策核 + golden 第三面**——批 1 DocumentSymbol(7947d7dc document_symbols.rs)之上,`EntityMappingManager.searchDefSymbolsByPrefix` + `collectPropertyDefinitions/collectMethodDefinitions` 决策链同构下沉(root 集/effective 折叠 first-wins/组件槽独立面/前缀大小写不敏感+trim/三键排序)。`textDocument/workspaceSymbol` LSP 接线(server.rs/rpc.rs)留接线批,本批零接 server.rs 纯库不变。

## 架构(`crates/kode-server/src/workspace_symbols.rs`)

- **root 集 = 语料 entity 类 def**(TS `mappingIndexesByRoot` 同口径:`lookupIndexByClass` 注记「接口/组件类不单独建索引」——interfaces/components 段 def 不入 root,只经实体闭包出现)。rootName = def basename(TS rootName 来自 entities.xml 实体名,语料两值恒同;异名登记册场景归接线批——诚实边界)。
- **effective 折叠闭包**(`def_fold_paths`,signature_help 走查核的 `with_components=false` 变体):own → interfaces → parent → parent 的 interfaces → …(KR-AUD-72 接口不跟随 Parent;环截断;只取语料存在路径)。first-wins 去重按 TS effectivePropertyKey(`fullPath::sortedFlagDomains`,语料顶层 fullPath=name → `name+排序旗标`)/effectiveMethodMaps(段+方法名)同构;去重发生在前缀过滤之前(两者对同名符号等价)。
- **组件槽独立面**(TS 组件不进 effective 集,单独 push):槽收集 = local + parent 链各 def 的 Components 段(`parent_chain_paths`,槽名小写去重 first-wins——TS componentsBySlot 同口径;接口 def 不产槽),每槽走组件自身折叠闭包(组件 Parent 在 components/ 内解析,组件不再嵌套组件——TS allowComponents=false 同口径)。搜索面命中不携带槽名(TS WorkspaceDefSymbolHit 无 slot 字段同构,containerName 只用 rootName·section)。
- **前缀口径**:needle trim + 小写,符号名 toLowerCase().startsWith(TS 同构);空前缀=全集。
- **排序**:rootName → symbolName → line 字节序(语料全 ASCII,= TS localeCompare 边界);Rust/JS sort 均稳定,同键平位按迭代序(root 路径序)确定。

## 走查核重构(`signature_help.rs`,行为锁定)

`owner_chain_paths` 的闭包走查提取为 `def_chain_paths`(+components,签名面域不变)/`def_fold_paths`(workspace effective 面)/`parent_chain_paths`(组件槽定位)。重构引入一处回归当场被合成钉拦下:父路径在守卫处预插 `seen` 后循环顶 `insert` 返回 false 直接 break——**父链永远不入列**(批 2 语料 golden 与 TS 镜像双绿未拦=语料签名面不依赖父链解析,20 万探针级的语料自洽盲区;合成钉为猎手判例再+1)。修后批 2 全部 15 钉 + golden 逐字节不变(regen compare 绿),证明语料零回归。

## golden 第四面

`crates/kode-server/tests/golden/workspace-symbols-parity.json`(15 roots / 53 符号 / 81 探针 / 317 命中 / 全集 108 / 120KB):
- **确定性探针集**(不另起探测面):全集符号名派生——原形(精确臂)/ 小写前两字符(截断臂)/ 原形前两字符(大小写折叠臂)+ 负例 zz/qq(恒空,防全绿退化)+ 空前缀一次(全集);
- 逐探针记命中全量(rootName/symbolName/kind/section/声明落点/行);生成器 `dump-workspace-symbols-golden`;
- 结构完整性:hitCount=逐探针和/universeCount=空前缀命中/symbolCount=全集去重符号名/探针字节序/命中三键序/前缀过滤口径逐命中复核/kind·段值域/root 恒实体 def/落点不出语料/**区分度真分布钉**(接口折入命中+组件槽命中+父链折叠命中在语料上真实在场,折叠面退化成恒只读本文件会红)。

## TS 镜像

`tests/kodeWorkspaceSymbolsParity.test.ts`(defParser 原语独立复算,4 例):① 计数锚(rootCount/probeCount/symbolCount/universeCount + 探针集同派生);② 全集深等;③ 81 探针逐个深等 + hitCount 守恒——折叠/去重/前缀/排序全链独立重推,不读 Rust 结果;④ 护栏(落点在语料/root 恒实体/kind·段值域/负例真空/折叠真分布/三键序)。

## prove-red(三靶闭环,cp+cmp 字节还原 + grep 钉存在性)

- T1(Rust):effective 去重臂放行(`let _ = seen_props.insert(key)`)→ `fold_order_first_wins_matches_ts_effective_sets` 红;**golden 重生成绿=语料不可分辨**(语料实体无一在闭包内重声明同名同键符号——覆盖臂全在合成 fixture,如实登记;首版扰动把 seen 集使用整体摘除触发 E0282 类型推断断,红在编译层不算数,重打为类型保持扰动);
- T2(Rust):排序次键反转 → `sort_order_root_symbol_line` 红 + **golden regen 红**(语料可分辨);
- T3(TS):镜像属性前缀大小写折叠摘除 → 逐探针深等红 1 例。

## 单元钉(8 例)

折叠序 first-wins 三臂(own 压接口/父类、接口压父类、父类独有折入)/ 方法段+名去重(跨段同名双 hit、同段同名 first-wins)/ 组件槽面(槽内声明落点=组件 def、槽内 Parent 链折入)/ root=entity 类 def(接口/组件不是 root、跨 root 同名各自成 root)/ 前缀 trim+大小写折叠+空前缀全集+负例空 / 三键排序+跨 root 平位路径序稳定 / **RUST-149 横切**:撤根后该 root 命中扇出摘除不虚报、同路径 def 换代即换命中(stale 替位钉;stale/cancel/cold 对同步纯面 N-A 如实登记)。

## 门禁

- `cargo test -p kode-server`:lib 786/786(含 workspace_symbols 8)+ integration 全绿,合计 1387/0;
- `cargo clippy -p kode-server --all-targets` 0(初跑 3 条:type_complexity→SectionMethods type 别名、doc 注释后空行、测试多余 mut,修后 0);
- vitest:kodeWorkspaceSymbolsParity 4 + kodeSignatureHelpParity 4 + kodeReferencesParity 3 + kodeReferencesSemanticParity 4 + kodePythonCallAtParity 3 = 18;
- tsc:`tsconfig.json` 本批零新增(HEAD 树实测逐字节同输出:既有 2 条红 `src/backend/redisDrift.ts(45,5)` / `src/backend/telnetClient.ts(340,5)`,Buffer 变型,两文件为 11-10/11-12 他批提交面,本批零 src/ TS 改动、tests/ 在双 tsconfig exclude=既有口径——HEAD 临时 worktree 对照实证非本批引入;批 2 晨检 tsc 0 与今红的差归因 node_modules 工具链态漂移,登记不冒充修复,归 backend 面)。

## 坑账(本批新增)

1. **走查核重构的 seen 双插回归**:守卫处 `seen.insert(parent)` + 循环顶再 insert → 父链永不入列;语料 golden/TS 镜像双绿拦不住(语料签名面零父链依赖),合成钉拦下。判例:**重构共享走查核必须带父链/环臂合成钉**,语料自洽盲区不兜底;
2. prove-red 扰动若让类型推断失据(E0282)红在编译层=无效红,须类型保持扰动(重打判据);
3. dump 尾换行约定再踩:dump fn 返回裸 JSON(尾 `\n` 由 bin `println!` 补),fn 内自加 `\n` 会与 `trim_end_matches('\n')` 比对成前缀关系,char_indices zip 找不到差异点报偏移 0——**对拍红报偏移 0 先查两串是否前缀关系**;
4. JS 无 `Array.windows`(Rust API 手滑)→ 下标循环;
5. 期望漂移两处(父链修好后 Mixed/Monster 继承 onTalk×2、hp 命中含 Mixed)——钉的期望随行为修正同步重推,不是放宽容差。

## 余账(批 3+)

- `textDocument/workspaceSymbol` LSP 接线(server.rs/rpc.rs)——纯库就绪,TS 薄壳切 `workspace_symbols_by_prefix`(预算/取消留 TS;TS 根发现序=扫描发现序,接线时以路径序归一);
- 嵌套属性符号面(TS pushProperty 递归 children/arrayElement,FIXED_DICT 子项/数组元素独立符号)——kode-parser PropertyDef 顶层模型无嵌套字段,归 parser 模型扩展批;
- entities.xml 异名 root(rootName≠def basename)与接口条目元素形态(KR-AUD-88 `<interface><X/></interface>`)——语料恒同/恒文本形态,接线批按需扩。
