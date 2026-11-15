# RUST-112 验收:文档类别区分与重复定义检测

日期:2026-11-16。验收对象:todo.md RUST-112(旧 SEM-010)「Python base/cell/client 文件与实体 `.def`、组件绑定区分、重复定义检测」。

## 1. 判据词 → 实现面映射

| 判据词 | 实现面 | 语义 |
|---|---|---|
| Python base/cell/client 文件 | `classify_document` → `DocClass::PythonEntity(PyFacet)` | KBEngine 布局:根件 `scripts/<Entity>.py` + 段件 `scripts/{base,cell,client}/<Entity>.py`(nav `script_layout` 同口径);非该布局的 `.py`(如 `scripts/common/Helper.py`)诚实落 `Other` |
| 实体 `.def` 区分 | `DocClass::Def(ReferenceKind)` | `def_kind_from_key` 三池口径(倒数第二段 `interfaces`/`components`,无池目录段默认 `Entity`);def 池间不串接 |
| 组件绑定区分 | ① `DocClass::PythonComponent(Facet)`(`scripts/{base,cell}/components/<Name>.py`,引擎组件只装应用侧,`client/components` 诚实落 `Other`)② `resolve_pool_ref` def 属性类型名三池归类 → `Component` / `Entity` / `Interface` / `Ambiguous` / `NoPoolHit` | 组件脚本与实体脚本、组件绑定与实体/接口引用逐面分开;多池同名命中 = `Ambiguous` 全列不任取 |
| 重复定义检测 | 三面:① `duplicate_defs`(跨文件同池同名 def,只报事实不选 winner)② `duplicate_registrations`(entities.xml 同名条目)③ `duplicate_py_classes`(同文件重复类定义) | 行号口径逐面钉死:注册条目 = parser 1 基;Python 类 = AST 0 基;文件清单键升序确定性 |

## 2. 引擎真源锚点

- **entities.xml 同名条目**:引擎静默复用已有模块 `registerNewScriptDefModule`(entitydef.cpp:255-262),第二条目及其属性断言不生效、作者无感知 → 本面如实报(与 TS `entitiesXmlAnalysis` 的 warning 诊断同口径);
- **跨文件同池同名 def**:引擎装载序依文件系统,无显式优先序——与 RUST-111 的 IDE 显式序消解不同,本面**只报事实不选 winner**;
- **同文件重复类**:Python 模块属性后见覆前,引擎无诊断,kode 如实报;
- 文件内重复(同 def 同段同名符号、重复 `<Type>` 标签)已由 lint `duplicate-definition` / `duplicate-type-tag` 覆盖,本面不重复建模。

## 3. 实现要点

- 池判别键数值化:`ReferenceKind` 未派生 `Ord`,用 `kind_rank` / `rank_kind`(实体 0/接口 1/组件 2)进 `BTreeMap`,桶序 = 枚举声明序;
- `classify_document` 判别序 = `.py`(组件布局优先于实体布局)→ 已知 XML 名(`entities.xml`/`types.xml`/`alias.xml`)→ `.def`(三池)→ `Other`;
- `resolve_pool_ref` 排除非 `.def` 与非同名文档,恰一池命中给单变体,≥2 池给 `Ambiguous`,零命中 `NoPoolHit`;
- 纯库面:无 RPC、无 TS 消费,消费接线属各域账行。

## 4. 测试与 prove-red

- 测试 9 例:def 三池路径判别 / Python 实体四腿 + 组件 base·cell + `client/components` 落 Other + 非布局落 Other / XML 三档 + 其他文件 / 跨文件同池重复(含 nested)/ 跨池同名不合并 + 单文件不产事实 / 注册重复全列 / Python 重复类全列 / 池引用三命中 + 查无 / 多池命中 `Ambiguous` 全列;
- prove-red 三靶(cp 备份 + cmp 字节还原):① 组件脚本判别失效 → 判别钉红;② 重复判重丢池维度(跨池合并)→ 跨池隔离钉红;③ 多池命中不产 `Ambiguous` → 歧义钉红。

## 5. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test 六 crate 1371 绿(doclass 9)/ rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 6. 结论

判据词全落:Python 实体/组件脚本与实体 `.def` 三池逐面区分、组件绑定(脚本面 + def 属性引用面)、重复定义三面检测。整行 `[x]` 勾账。
