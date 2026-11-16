# RUST-141 批 1:def 重命名纯核下沉 Rust(验收纪实)

日期:2026-11-16
todo.md 行 402:`RUST-141(旧 LSP-008)Rename 全工作区可编辑范围分析;合成 preview,避免重命名错误同名符号。`
本批边界:**def 文件重命名四纯面**(src/backend/defRenamer.ts 同构下沉)。`textDocument/rename` / `prepareRename` LSP 接线、python self 访问改写面(EntityMappingManager)、renameInputsDrifted 漂移面留批 2(同 RUST-138/139/140 口径:server.rs/rpc.rs 并发在途,只落纯库,生产服务面仍是 TS)。

## 架构

- 新模块 `crates/kode-server/src/def_rename.rs`(~1100 行),四公开面对齐 TS 生产签名:
  - `resolve_rename_symbol_at_offset(text, offset)` → 符号面(kind/section/name/词区间,UTF-16);
  - `find_def_rename_conflict(text, symbol, new_name)` → NAV-008 窄面冲突(方法只查同段/属性·组件同面任一占名);
  - `compute_def_rename_edits(target_file, target_text, symbol, new_name, reader)` → 全工作区后代闭包编辑(编辑只向后代;接口混入传播=从接口文件发起时实体是后代);
  - `find_def_rename_conflict_in_closure(...)` → AUD-061 祖先+后代双向闭包冲突(判重矩阵=组件槽无条件/方法同段/跨类域位相交 Flags 并集)。
- **UTF-16 坐标系统一**:语料含 CJK 注释(Avatar.def),TS 偏移=UTF-16 单元、kode-parser span=字节偏移 → `Utf16Map`(char boundaries 表 + binary_search 钳位)边界换算,全部公开偏移存 UTF-16;golden 与 TS 镜像天然同系零换算。
- **TS 手写语义等价**:`getTagNameRange` 正则(`^<\s*/?\s*${name}\b`)在 Rust 侧于 UTF-16 单元上重扫('<' 期待/\s 跳步/可选 '/'/name 匹配/\b=后邻非词字符或切片尾);`getReferenceTargetName` 同构(首子节点/文本 trim/元素标签/纯空白跳过/混合内容文本优先);接口 wrapper 四拼写 interface/Interface/type/Type;接口不读 Parent(loadInterfaces 口径);悬空引用不产生边。
- **编辑传播方向**(TS 测试实证):`compute_def_rename_edits` 只向后代;闭包冲突面才双向(祖先闭包+后代闭包)。
- **候选宇宙语义无损裁剪**(golden 体积控制):闭包冲突候选=「在他文件声明过的成员名」∪ 探测名 `zzRenameProbeNew`(纯走查 null 路径钉)——只在本文件声明的名字对闭包检查恒 null(生产只查非目标文件),裁剪不丢信息,两侧同规则。
- golden:`crates/kode-server/tests/golden/def-rename-parity.json`(610KB,**5 工作区 / 22 def 文件 / 1,134 符号命中 / 63 符号分析 / 1,527 闭包候选检查**)。探测设计=逐文件每偏移 0..=长度全探测(symbolHits 只存非空+probeCount 全集对账);逐符号三面=同文件冲突候选 × 本文件成员名∪探测名 / 全工作区编辑 / 闭包冲突候选 × 他文件成员名∪探测名。工作区分组=findEntityDefsRootFromFile 逐文件向上走查 entities.xml(None 组=electron-ws scripts/server 无根子树 3 文件;组内全路径字节序,拼平=工作区主序非全局字节序)。
- 生成器:`crates/kode-server/src/bin/dump-def-rename-golden.rs`(dump 函数返纯 JSON,bin println 补尾换行;dump 开头 canonicalize repo_root,root 键已修无双斜杠)。

## TS 镜像(最强形态)

`tests/kodeDefRenameParity.test.ts`:**直接 import 生产 `resolveRenameSymbolAtOffset` / `findDefRenameConflict` / `computeDefRenameEdits` / `findDefRenameConflictInClosure` / `findEntityDefsRootFromFile`**(defRenamer)+ `parseDefDocument` / `getDirectChildElements`(defParser 派生成员名宇宙),逐文件逐偏移复算同一 golden——生产 TS 面 ↔ Rust 面零复算漂移对拍(3.3s)。3 例:工作区分组+组内文件序同集 / 逐文件深等(probeCount/symbolHits/analyses 全集+四项总计钉) / 面定义护栏(kind/surface/ranges 合法性+升序+conflict.name==newName)。

## 单元钉(6 例)

resolve_symbol_open_close_and_tolerance_faces(开/闭标签命中+词尾右侧一格容差)/ conflict_method_same_section_and_property_component_faces(跨段同名合法·同段冲突 surface=段名)/ identifier_gate_and_reference_target_name_forms(非标识符拒·取名四形态)/ workspace_edits_cover_descendant_and_interface_closure(后代编辑+接口源头发起面)/ closure_conflict_ancestor_and_descendant_directions / flag_domain_overlap_gates_property_conflict(域位相交闸)。

## prove-red(三靶,全部 cp 还原 + cmp 字节校验 + grep 钉存在性)

- Rust T1:闭包方向闸反转(`!is_ancestor && !is_descendant` → `is_ancestor || is_descendant`)→ golden 重生成红;
- Rust T2:方法判重矩阵反转(同段→恒真)→ golden 红;
- TS T3:`computeDefRenameEdits` 后代闸反转(`!closure.has` → `closure.has`)→ 镜像红;
- 还原后 Rust 6/6 + golden 2/2 + 镜像 3/3 复绿。

## 过程坑(纪实)

- **golden 文件序是工作区主序**:镜像首版按全局路径字节序拼平对拍红——golden 逐工作区组内字节序、拼平按根序(None 先),不等于全局排序;镜像改为按工作区成对比较后绿;
- **移植 bug 被单元钉即时拦截**:find_def_rename_conflict method 分支初版 `surface=冲突子名`,TS 是 `surface=段名`——测试夹具改插 CellMethods 后钉红暴露,改 section_name;
- **工作区编辑语义误读一次**:单元钉初版期望接口文件进编辑——读 TS 测试证实编辑只向后代(接口是祖先不进),改钉并补接口源头发起面(ROLE 目标→[Hero,Monster,ROLE]);
- **golden root 双斜杠**:dump 传 "." 相对路径时 strip_prefix 失败回退全路径拼接(RootDir 组件="/")→ dump 开头 canonicalize;
- **E0716/E0382 借用链**:结构体字面量里 move 后借用(name 字段先于 file_path)、`unwrap_or_default()` 链式 split 临时量——字段顺序调整+let 提取;
- **跨解析器分歧边界(诚实登记)**:TS tokenizer 允许 `< hp>` 空白形态+Rust xml 解析器名可含 `.-:`+多词容忍——异形标签两解析器会分歧;语料扫描证实 22 文件全部良构标识符标签,分歧作边界不修。

## 诚实边界

- `textDocument/rename` / `prepareRename` LSP 接线、python self 访问改写面、renameInputsDrifted 漂移面未做(批 2);组件 Type 面不在本核(DefFileSemantics 同 TS 口径);todo 行不勾,只补批 1 进度注。

## 门禁(2026-11-16)

- cargo clippy -p kode-server --all-targets -- -D warnings:0(初跑 5 错=本模块 doc `+` 行首被作列表标记/from_ref 消 clone/into_iter 显式调用/let-else 可 ?,修后复跑 0)
- cargo test -p kode-server 全量:1126 ok / 0 failed,RC=0(较上批 +8 = 6 单元 + 2 golden);--lib def_rename 6 passed;--test def_rename_golden 2 passed
- pnpm lint 0 / pnpm compile 0
- pnpm test:unit:851 文件 10369 过 + 8 skip RC=0(+1 文件 +3 例 = 本镜像;其余树面增量属并发会话在途件)
- xvfb-run -a npm run test:demo:editor:25 passing RC=0
- 提交前 lib.rs diff-vs-HEAD 逐块核对 = 仅本批两处 hunks(pub mod def_rename + pub use dump_def_rename_golden)
