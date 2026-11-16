# ADR-110 — KBEngine API `.pyi` stub 接入方式:静态模板车道(copy-if-absent + Pylance 标准接线),不走编译 .so,不走生成器

- 状态:已接受(2026-11-17,RUST-297 裁决落档;静态模板车道 2026-11-11 起在役,本 ADR 追认并钉否决实测)
- 关联:书 §18 ADR-110、RUST-297、RUST-262(PH4-02 全流程收官)、RUST-168(typings 开关审计,2026-11-17)、PY-009(审计结案:按版本/commit+用户引擎分支覆盖)、ADR-105(Pylance/Pyright 分工第 3 层)
- 证据:`docs/design/kbengine-pyi-compiled-module-plan.md` §4(编译 .so 否决实测记录)+头部状态更新(静态模板车道终态)、`docs/guide/configuration.md` `kbengine.python.stubExport`/`stubDir`/`stubCopy` 节、`docs/review/2026-11-17-rust-168-typings-toggle-audit.md`、`scripts/derive-kbengine-stub-typings.mjs`

## 背景

书 ADR-110:`.pyi` navigation source mapping 接入方式需实测——Pylance/Pyright 的
stub 解析行为有限制(搜索路径/优先级/`reportMissingModuleSource`),不实测不能定。
候选车道三条:①编译引擎 `.so` 后 introspect 生成;②从引擎源码枚举生成
(枚举器+合并器);③静态模板(fork 手工 typings 派生)+copy 接线。

## 决策

**接入方式=静态模板车道,两条生成车道实测否决:**

1. **模板来源**:插件内置 repo 顶层 `typings/` 模板,派生自用户 fork
   `cuihairu/kbengine` 的 typings,**钉点 commit 28d2117**;
   `scripts/derive-kbengine-stub-typings.mjs` 按 fork 布局一类一文件切分;
   kode overlay 三件(`Entity.pyi` 的 `cellData` 声明、`Proxy.pyi` 的
   `__ACCOUNT_NAME__`/`__ACCOUNT_PASSWORD__` 内部属性标注、`_vectors.pyi`)。
2. **落盘与接线**(`kbengine.python.stubExport`,默认 true):激活期
   **copy-if-absent** 复制到 stub 目录(`stubDir` 三档:设置 > 环境变量
   `KBENGINE_STUB_DIR` > 约定 `.kbengine/stubs`;零覆盖铁律——项目内副本
   永不覆盖,覆盖只走 `kbengine.python.resetStubs` 显式命令+用户确认;
   激活自动复制步另受 `kbengine.python.stubCopy`(默认 false)窄闸)。
   Pylance 接线走**标准机制**:managed `python.analysis.extraPaths` 段
   (`${workspaceFolder}/` 变量形式)+ `python.analysis.stubPath` +
   `reportMissingModuleSource` 抑制;关闸只撤接线不删盘上文件。
3. **否决实测(诚实记录)**:
   - **编译 `.so` 车道**:2026-11-09 实测否决——编译产物 24MB `KBEngine.so`
     import 即段错误、`Script` 单例缺失,依赖链不抵收益;实测记录原样保留
     在 kbengine-pyi-compiled-module-plan.md §4;
   - **pyrefly stubgen 车道**:对无标注代码全落 `Incomplete`,不采用
     (CFG-017 实测,与 ADR-105 第 2 层同一结论);
   - **源码枚举生成器(枚举器/合并器 Phase 1/2)**:未再点火——fork typings
     已覆盖成员集,签名质量即 fork 手工质量;如未来发现 fork 缺成员再回该车道补枚举。

## 后果

- 正面:导航与类型信息由 Pylance 按**标准 stub 机制**消费,零私有协议;
  fork 手工签名质量直接继承;copy-if-absent+显式 reset 保证用户手改永不丢;
  旧动态生成链(引擎 checkout 拼接/精选目录回退/托管目录比对重写)与
  `stubSourceMode`/`stubEngineTypings` 设置一并退役,面收敛。
- 负面/约束:引擎 API 变更要回 fork 更新 typings 再重新派生(模板有滞后窗);
  钉点升级属显式动作(改 28d2117 锚需走 PY-009 同款审计:按版本/commit+
  用户引擎分支覆盖);Pylance 侧行为(搜索路径优先级)依赖其实现,不设 kode 控制面。
- reopen 条款:fork typings 出现结构性缺员(枚举面大量缺口)时重启枚举生成车道
  (须新实测对比);Pylance stub 解析行为破坏性变更时重评接线方式。

## 边界(诚实)

- 本 ADR 只裁决「接入方式」;「types.xml 自定义类型→用户 Python→引擎 API stubs
  →生成→源导航」**全流程**已由 RUST-262(PH4-02)收口:PY-010 源映射/
  PY-011 stub 逆向跳源/PY-013 增量原子写/PY-016 gitignore 守卫/PY-020 真机导航收官。
- Pylance/Pyright 对 stub 的具体解析限制(书要求「需要实测」)的实测落点=
  RUST-168 开关审计(2026-11-17,extraPaths 变量形式/stubPath 写点/抑制通道逐项)+PY-009/011 审计;
  未做 Pylance 版本矩阵全量实测,该扩展面随 Pylance 闭源演进,kode 不承诺跨版本行为。
