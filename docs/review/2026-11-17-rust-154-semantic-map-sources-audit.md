# RUST-154 审计结案:entities.xml + *.def + types.xml + *.py 四源映射在同一语义图中保留 sources

日期:2026-11-17
性质:审计结案(基线零改动)——四源已由 kode-parser 统一解析、Rust semantics 层同一语义图承载,sources 全程保留。

## 四源统一解析(kode-parser)

crates/kode-parser/src/lib.rs:1 钉「`.def` / entities.xml / types.xml / alias.xml 逐字节解析器」;模型全部带行锚:PropertyDef.line(model.rs:56)/MethodDef.line(:87)/ComponentDef.line(:105)/EntityEntry.line(:495)/TypeDecl.line(:553)/AliasDecl.line(:676)。json.rs:23 语料收集四类排序遍历确定性。

## 同一语义图(Rust semantics 层,crates/kode-server/src/semantics/ 28 模块)

- **nav**(NAV-01/RUST-110,nav.rs):实体跨语言可逆导航链三腿=entities.xml 注册位 → `.def` 声明位 → Python 实现位;Python 腿按标准布局推断(Root/Base/Cell/Client),可逆=Python 文件反向回链实体;同名重喂=替换(文件更新语义),remove_python_file 对称清理;
- **store**:SnapshotStore def 解析按引用类别分池(entities/interfaces/components 三池,ReferenceKind,引擎 Parent 按池递归 entitydef.cpp 出处);
- **types**(kode-types::TypeGraph,graph.rs:232):types.xml/alias 进同一图——`from_type_graph` 递归(alias/ARRAY/FIXED_DICT/UserType,rpcargs 深审-2 桥,显式 `<Arg>PYTHON</Arg>` 才是合法 PYTHON);
- **snapshot**:EntitySnapshot(snapshot.rs:72)=parent_chain/interfaces/properties/base·cell·client_methods/components/conflicts/issues——单实体语义全量视图;
- **doclass**(RUST-112):四源语料类别判别(Python 实体脚本/组件脚本/def 三池/XML 语料路径),重复注册三重复面只报事实。

## sources 保留(逐面)

1. **类型图 provenance**(kode-types/provenance.rs:59-88):声明/定义行(parser 1 基)+TypeSourceKind 出处(Direct=None/Def=名 span+行,methods.rs:105 origin_for)——图节点不丢出处;
2. **nav 行号双口径如实**(nav.rs 头注钉死):注册位=parser 1 基,类位=kode-python AST 0 基,逐字段注释;类缺失腿在类位 None 不造行号;未在册不产幽灵条目;
3. **TS 消费面同口径**:entityTypeStubs 生成 `# source: .def:N -> types.xml:M`(:634)+generatedSourceLenses「原始定义: types.xml:line」(:62);STRUCT-06 implementedBy def↔py 绑定解析(悬停仅声明臂);
4. **环/缺失诚实**:resolve_parent_chain 环截断+精确诊断(model.rs:772),EntitySnapshot.issues 承载缺失父/接口/未解析组件。

## 边界(如实登记,非缺口)

nav/snapshot 等纯库面无 RPC 无 TS 消费——消费契约 `$/kode/semantics/*` 已起步(cellDataKeys,KSEM-CELL-04),其余域接线按 todo 各行点火;本行要求的「同一语义图+sources」存在性已满足。

## 结论

四源映射在同一语义图(store 池+TypeGraph+nav 三腿+snapshot)且 sources 全程保留(行锚+provenance+双口径不换算+不造行号纪律)已系统性满足。基线零改动。
