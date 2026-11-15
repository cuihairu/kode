# RUST-111 验收:多 root 同名消解(显式查找顺序 + 歧义 diagnostics)

日期:2026-11-16。验收对象:todo.md RUST-111(旧 SEM-009)「支持多个 root 的同名实体/组件/类型,显式查找顺序和歧义 diagnostics」。

## 1. 判据词 → 实现面映射(crates/kode-server/src/semantics/roots.rs,KSEM-ROOTS 纯库面)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| 多个 root 的同名实体/组件/类型 | `MultiRootRegistry`(显式优先序 root 表 + `(NameKind, name)` → 各 root 命中桶) | `NameKind{Entity, Component, Type}` 三名称空间隔离:同名实体(root-a)与同名类型(root-b)互不歧义 |
| 显式查找顺序 | `add_root`(0 最高;重加同名 root = 移到队尾 = 重排序信号)+ `resolve` 按序取最高优先 root 命中为 winner | **引擎真源边界如实登记**:KBEngine 每进程只装一个 assets root,引擎不合并多 root;查找顺序是 IDE 约定(VS Code 多根工作区文件夹序),由消费方供给,本模块不把顺序说成引擎语义 |
| 歧义 diagnostics | `resolve` 返回 `NameResolution{winner, shadowed}` + `ambiguities()` 枚举全表 ≥2 root 命中的 (kind,name) 为 `AmbiguityFact{kind, name, winner, shadowed}` | 歧义事实供消费方发 diagnostics;**消解决定性**——「歧义」不改变 winner(恒显式序最高优先),shadowed 只作事实附随 |

## 2. 关键语义保证

- winner 恒按显式优先序,与喂入序无关(测试钉:root-b 先喂、root-a 后喂,resolve 仍 root-a 胜);
- shadowed 按显式序排列(确定性,消费方可展示消解链);
- 跨类别同名不互歧义(逐 kind 独立桶 + 测试钉);
- 查无名 → `winner: None` + 空 shadowed,不产事实;
- 序外 root(`register` 未 `add_root`)自动垫底(最低优先,到达序),不拒收不丢数据;
- 同 root 内重复定义检测归 RUST-112(独立面):本模块按 `(root, kind, name)` 唯一键存储,同键重喂 = 替换,同 root 不产歧义事实;
- RUST-105/RUST-110 各面先到先得登记保持不变,消费方应先用本面消解出 winner 再喂那些面(模块 doc 显式)。

## 3. 测试与 prove-red

- 7 例内嵌单元(显式序胜+shadowed 记录/重加 root 重排翻转 winner/类别隔离/查无名 None/歧义枚举含 shadowed 序+单命中不产/同键重喂替换不产同 root 歧义/序外 root 垫底);
- prove-red 三靶(cp 备份 + cmp 字节还原):① 消解排序反转(取最低优先)→ 4 例红;② `ambiguities()` 撤 `len>1` 过滤 → 2 例红;③ shadowed 清空 → 3 例红。

## 4. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 1362 绿(含 roots 7)/ rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 5. 结论

多 root 同名(实体/组件/类型)三面全落:显式查找顺序(消费方供给的 IDE 约定,引擎真源边界诚实)、逐 kind 消解(确定性 winner)、歧义事实枚举(shadowed 全携带)。诊断发射/TS 消费接线属各域账行。整行 `[x]` 勾账。
