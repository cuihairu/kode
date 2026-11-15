# RUST-114 验收:symbol 名称重命名策略(用户代码可改/内建生成不可直接改/冲突预检)

日期:2026-11-16。验收对象:todo.md RUST-114(旧 SEM-012)「symbol 名称重命名策略:用户代码可改,内建和生成代码不可直接改;冲突预检查」。

## 1. 判据词 → 实现面映射(crates/kode-server/src/semantics/rename_policy.rs,KSEM-RENAME 纯库面)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| 用户代码可改 | `SymbolOwner::UserCode`(source `AssetLayout`) | assets 语料 = doclass `DocClass` **单一真源同口径**(Python 实体/组件脚本、def 三池、entities.xml/types.xml/alias.xml);非布局 py(如 tools/gen.py)诚实落 Unknown 不算用户代码 |
| 内建不可直接改 | `SymbolOwner::EngineBuiltin`(source `EngineMeta`) | 名称命中 RUST-113 `EngineMetaLayer` 任一类别(或指定类别;version 透传未声明不猜)——引擎 API/回调/内建对象/常量名是引擎调用/注册点固定契约,`detail` 携带锚点出处(`引擎契约锚 <文件:行>(category=…)`);外部 override 命中同样算内建(fork 契约) |
| 生成代码不可直接改 | `SymbolOwner::Generated`(source `GeneratedPath`) | 路径落在 `<managed_dir>/stubs/` 段级匹配下(TS managedDir 口径,目录名消费方供给默认 `.kbengine`,支持自定义目录名/嵌套)——生成物直接改会被下次生成覆盖(零覆盖铁律);**路径判定优先于内建名命中**(生成物里的内建名同样是生成物) |
| 冲突预检查 | `conflict_precheck(registry, kind, old, new)` → `ConflictReport{noop, old_status, conflicts}` | 同名类别空间复用 RUST-111 `MultiRootRegistry` 消解面:新名同 kind 已有登记即冲突事实(winner+shadowed 全携带,显式序);跨 kind 同名不冲突(类别隔离同口径);旧名未登记 = `OldNameStatus::NotRegistered` 事实照报不 deny;old==new = `noop` 旗标不与自身判冲突 |

## 2. 关键语义保证(诚实边界)

- 判定序固定:生成物路径 → 引擎元数据 → assets 布局 → `Unknown`(provenance `OwnerSource` 逐条携带,Unknown 时 detail=None);
- 伪前缀不误伤:`.kbengine/stubs` 段级匹配,`notkbengine/stubs` 不产 Generated(测试钉);
- 编辑执行面零越界:本面只做策略判定,def 成员级冲突(同段方法/属性段/组件域/继承闭包)已由 TS defRenamer(IDE-NAV-008/IDE-AUD-061)覆盖不重复建模;重命名闭包执行与 rename/delete 清理链接线归 RUST-131/131-W;
- 无 RPC、无 TS 消费,消费接线属各域账行。

## 3. 测试与 prove-red

- 9 例内嵌单元:四类内建归类带锚点 detail / category=None 全类别扫描 / 生成物路径优先于内建名(嵌套+自定义目录名+伪前缀不误伤)/ 用户代码 assets 布局五路径+组件脚本 / Unknown 诚实(含非布局 py)/ 外部 override 命中算内建 / 冲突预检 winner+shadowed 全携带 / clean+noop+旧名未登记 / 跨 kind 同名不冲突;
- prove-red 三靶(cp 备份 + python3 变异 + cmp 字节还原):① 内建归类失效(查名错位)→ 3 例红;② 生成物路径优先倒置(meta 先判)→ 1 例红;③ 冲突预检丢同 kind winner → 2 例红。**坑账**:首轮靶1 变异 `let hit = None;` 编译挂(类型不定)非测试红,不合格——重打为查名错位变异(编译保持通过)。

## 4. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 101 套件 1389 绿(rename_policy 9)/ rustfmt 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 842 文件 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 5. 结论

判据词全落:归属三分(用户代码/内建/生成物,provenance+锚点 detail)+ 冲突预检(winner+shadowed 全携带、跨 kind 隔离、noop/旧名缺失诚实事实)。整行 `[x]` 勾账。
