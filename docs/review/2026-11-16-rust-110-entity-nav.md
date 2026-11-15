# RUST-110 验收:entities.xml → .def → Python 跨语言可逆导航

日期:2026-11-16。验收对象:todo.md RUST-110(旧 SEM-008)「`entities.xml` 注册映射 → `.def` → Python 实现,跨语言可逆导航」。

## 1. 判据词 → 实现面映射(crates/kode-server/src/semantics/nav.rs,KSEM-NAV 纯库面)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| entities.xml 注册映射 | `register_entity(file, &EntityEntry)` → `RegistrationSite{file, line(parser 1 基), attributes 原样}` | 条目属性文档序保留;`flag("hasBase"/"hasCell"/"hasClient")` 布尔读取:`true`/`1`(大小写不敏感)= true、其余 = false、缺属性 = `None`(TS 向导 boolean 字符串化写法同构) |
| `.def` | `declare_def(entity, def_file, facets)` | 实体名 = def 文件名去 `.def`(消费方映射,`entity_name.rs` 跳转面同口径);`def_facets` 段事实消费方喂入(空段是否计段由消费方口径定) |
| Python 实现 | `script_layout(path)` 路径推断 + `feed_python(path, &AstSymbols)` | KBEngine 标准布局:根件 `scripts/<Entity>.py`、段件 `scripts/{base,cell,client}/<Entity>.py`(引擎只装这三段,其余目录不产腿);同名顶层类事实直取 kode-python AST(类位 0 基原样、bases 原样);`PyFacet::Root<Base<Cell<Client>` BTreeMap 迭代序确定 |
| 跨语言可逆导航 | `forward(entity)` / `reverse_from_file(py_file)` / `remove_python_file` | 正向 = 实体名 → 三腿链;反向 = Python 文件 → 实体(文件名去 `.py`,与实体同名顶层类是引擎脚本绑定要求)→ def → 注册位;`remove_python_file` 对称清理反向映射 |

## 2. 关键语义保证

- **腿独立 Optional,缺哪腿如实 `None`**:类缺失(文件在、同名顶层类不在)→ 腿在、类位/结束行 `None` 不造行号;
- **不产幽灵条目**:未注册也未声明 def 的实体名脚本 `FeedOutcome::Ignored(EntityNotRegistered)` 整体不喂入;仅声明 def 未注册也算在册(Python 腿可挂);
- **多 root 同名歧义归 RUST-111**:注册位先到先得(RUST-105 `entity_registrations` 同口径),本模块不判歧义;
- **行号双口径逐字段注释钉死**:注册位 parser 1 基 / 类位 kode-python AST 0 基(仓内 Python 面口径),本模块不换算;
- **更新语义**:`declare_def`/`feed_python` 同键重喂 = 替换(文件更新语义,不叠加);`register_entity` 先到先得。

## 3. 测试与 prove-red

- 9 例内嵌单元(全链四腿确定序/布局推断表含 `\` 混合+段下多层拒+非 `.py` 拒+空名拒/未在册忽略无幽灵+仅 def 在册可挂/非标准布局忽略/类缺失诚实 `None`/反向+对称删除+重复删 false/注册先到先得/重喂替换不叠加/`flag` 真值表);
- prove-red 三靶(cp 备份 + cmp 字节还原):① `base` 腿分支改判 Root → 布局表+全链 2 例红;② 撤在册闸 → 幽灵条目钉红;③ 撤反向映射清理 → 对称删除钉红。

## 4. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 1355 绿(含 nav 9;kode-parser 130 golden 零扰动)/ rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 5. 结论

三腿链全落(注册位/声明位/实现位),正反向查询面对称,诚实边界(类缺失/未在册/歧义缓判)显式登记。消费接线(RPC 面/TS 侧跳转 UI)不在本行判据内,属各域账行。整行 `[x]` 勾账。
