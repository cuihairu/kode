# RUST-103(旧 SEM-001)验收:稳定 ID 定义逐面核

日期:2026-11-16。验收对象:todo.md RUST-103「定义稳定 `SymbolId`、`TypeId`、`EntityId`、`RootId`、`Location`、`Origin`」。方法:判据词表逐项映射现有定义面(文件:行)+ 稳定性语义 + 测试钉。**验收勾账,零新生产码**——定义面由 KSEM-BAS 批1(2026-11-12)与 kode-types 基础版落齐,本笔逐面验读。

## 1. 判据词表 → 定义面映射

| 判据词 | 定义面 | 稳定性语义 | 测试钉 |
|---|---|---|---|
| `SymbolId` | `crates/kode-index/src/symbol.rs:64` `pub type SymbolId = usize` | 索引实例内 arena 句柄(槽位,free-list 回收)——**句柄类,不跨重建**;稳定身份契约不在它(见 EntityId 行) | kode-index 全套(attach/lookup 面) |
| `TypeId` | `crates/kode-types/src/graph.rs:14` `pub struct TypeId(pub u32)` | 节点表下标,**构建完成后不变**(源码注释自锚:「SEM-001 的 TypeId 基础版」) | TypeGraph 构建/边面随消费方测试 |
| `EntityId` | `crates/kode-server/src/semantics/id.rs:58` `SemId{root,kind,name,facet}`(SemKind::Entity) | **结构相等即身份相等**的四元组(root×kind×name×facet)= 全账本的稳定身份契约;同名跨根/Base/Cell 分面/同名异 kind 三隔离轴显式钉死 | id.rs 5 测试(cross_root_not_equal / base_cell_not_equal / kind_isolation / same_signature_equals / root_id_compatible_with_vfs_key) |
| `RootId` | `crates/kode-vfs` `RootId(pub u32)`(复用不另造,`semantics/id.rs` 文档头声明) | workspace 根身份,vfs 分配; incarnation 隔离(RUST-069-W:移除后重加=新 id,旧化身不复活) | id.rs `root_id_compatible_with_vfs_key` + root_lifecycle E2E |
| `Location` | `crates/kode-server/src/semantics/types.rs:20` `Span{line,col}`;`Symbol{file: DocumentKey, line: usize}`(kode-index symbol.rs:68-76,1 起行号,文件级符号约定 1);snapshot 符号/方法/组件面 `line: Option<usize>`;解析器域 `kode_parser::Span`(字节偏移) | 行列/偏移均结构性;位置信息按域分层(语义=行列,解析器=偏移,索引=file+line) | semantics 277 例内嵌消费 |
| `Origin` | `crates/kode-server/src/semantics/facts.rs:57` `Origin{Declared / Derived{chain} / Unknown{reason} / Conflict{candidates,reason}}` | 诚实来源四态:声明确定/推导(链逐步保留)/未知(带因)/冲突(候选并存不任取) | facts.rs 5 测试 |

## 2. 稳定性契约的层级(如实边界)

- **稳定身份 = SemId 结构四元组**(BAS-03):跨进程可重建、可对账(同输入同 ID);`semantics/id.rs` 文档头显式声明该契约与三隔离轴;
- **句柄类 ID**(SymbolId arena 槽、TypeId 节点下标)是各自数据结构内的稳定下标,**不承诺跨重建稳定**——稳定身份由结构四元组承担,句柄只在持有数据结构内有效;这是设计决策(id.rs 文档头),不是缺口;
- `TypeId` 自锚「基础版」:节点表下标稳定性成立;IR 完整度(RUST-104-W Optional/Unknown 节点补齐)是另一账,不在本行;
- 语义模块为纯库面(消费契约 QueryRequest/Response 待各域接线,既有登记):本行判据是「定义」,定义面全落;域接线验收随各域账行,不在此勾。

## 3. 消费面现状(定义不是孤岛)

- `TypeId`:semantics/rpcargs.rs:796 实际分配并消费(TypeGraph 节点);
- `SemId`:snapshot/facts/deps/query/refs 等语义模块互链(纯库面内);
- `RootId`:kode-vfs DocumentKey/server RootId(语义/vfs/server 三层共用);
- `Symbol{file,line}`:kode-index hover/completion 语料消费;
- `Origin`:facts 事实面四态在语义查询面流出。

## 4. 门禁(验读)

`cargo test -p kode-server --lib semantics` 277 过 0 败(2026-11-16 实跑);id.rs 5 例 + facts.rs 5 例内含;无新生产码,无锚点位移(不动 ANCHORS 面)。

## 5. 结论

判据词表六项定义面全落、稳定性语义显式(结构四元组=契约,句柄=域内)、隔离轴有测试钉、消费面在库内互链。整行 `[x]` 勾账。
