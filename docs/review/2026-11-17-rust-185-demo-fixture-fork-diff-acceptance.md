# RUST-185 验收纪要:示例项目/真实 engine fixture 集成与 fork 差异测试对账

日期:2026-11-17。本纪要对账 RUST-185(旧 KBE-015,主 todo 排队项)的验收口径与既有交付证据。结论:**示例项目、真实引擎布局 fixture、版本差异测试均已交付且各有钉;本批为纯对账收口(零代码增量),诚实边界见末节。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 示例项目集成 | `tests/fixtures/kbengine-demo-assets` 验收工程:保留官方 `scripts/base\|cell\|client`、`entity_defs`、`entities.xml` 布局,扩展 TrainingAvatar/TrainingMonster/EliteMonster 与多组 mixin(跨文件继承、C3 MRO、别名与重导出、同名类、实体角色隔离、覆盖方法、.def 往返跳转、注释/字符串过滤);被 **29 个测试文件**消费,且进入真编辑器门禁:`test:demo:editor`(xvfb,每批 25 例 RC=0)经 `src/test/electron/runTest.ts --demo` 在真实 VS Code 里跑该工程;打包面(platform-vsix/npm-package)同样引用 | `tests/fixtures/kbengine-demo-assets/README.md`;`package.json` test:demo* 三脚本;CI demo 门禁 |
| 真实 engine fixture | `tests/fixtures/kbengine-tpl-scripts`:官方服务端模板骨架(base/bots/cell/common/data/db/interface/logger + entities.xml + entity_defs),被 12 个测试文件消费;另有 parity-project + golden.json 对拍金样 | `tests/fixtures/kbengine-tpl-scripts/`;`tests/fixtures/parity/` |
| fork 差异测试(版本轴) | ①版本感知链 KB-VER-001:`kbengine.engineVersion` 预设含官方线与 fork 示例(fork-3.12),魔改 fork 自由串,知识库/诊断按版本分支;②版本自动探测 KB-VER-004:引擎树标记面 **legacy version.h 单宏 vs 2.5.10+ kbeversion.h 三宏**两条路径,fork 树实测 kbeversion.h 报 2.5.10,缺失/畸形→null 绝不编造;③兼容矩阵:engineCompatibility(扩展↔引擎支持矩阵校验)+ DBG-COMPAT-06 版本分支回归矩阵(目标 Python × debugpy/扩展版本 × 生产入口组合账本,防修一处另一分支变卦)+ rpcArgTypeCompat | `src/engineVersion.ts`;`src/backend/engineVersionDetect.ts`;`src/backend/engineCompatibility.ts`;`tests/engineVersionDetect.test.ts` / `dbgcompatVersionMatrix.test.ts` / `rpcArgTypeCompat.test.ts` / `engineCompatibility.test.ts` |

## 本批增量

- 零代码增量:三块面均已有钉(29+12 fixture 消费面、demo 编辑器门禁、版本探测/矩阵测试族),本批只做验收对账;再造等价钉属仪式性重复。

## 诚实条款

- 「真实 engine fixture」的真实性边界:demo-assets 是**在官方模板骨架上扩展的验收工程**(官方布局+自造验证实体),不是上游 kbengine demo 仓库的逐字节拷贝;tpl-scripts 是官方服务端模板骨架。语言分析所需的布局/协议/def 形态与真实工程一致,资产级(美术/客户端)不在范围。
- fork 差异的覆盖形态=**版本标记差异(legacy/三宏)+ 版本敏感行为矩阵(兼容矩阵/组合账本)**,本地引擎树为官方 3.x 单棵;未集成第二套真实 fork 资产树,若未来需要 fork 资产级差异(如 fork 自有 def 类型/消息面),应另批建 fork fixture,本纪要不冒充已覆盖。
- 版本预设表(fork-3.12 等)是**示例常量**供选择面板,不主张穷举真实世界 fork;自由串口径保证任意 fork 可表达。
