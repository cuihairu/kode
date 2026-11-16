# RUST-227 验收纪要:多根工作区 active project 选择与跨根跳转完整归属

日期:2026-11-17。本纪要对账 RUST-227(旧 UI-010,主 todo 排队项)的验收口径与既有交付证据。结论:**active project 用户选择与跨根归属展示均有既有面与测试钉,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 用户可选择 active project/root | `kbengine.project.selectActive` 命令:QuickPick 列出全部 profile(显示名 label+稳定 ID description),选中走 setActiveProfile(memento 持久化+onDidChangeActiveProfile 事件,真实切换恰发一次,RUST-186 口径);无 profile 时如实说明跳过选择器不打扰;Esc 零写入;稳定 ID 语义=改名/改根不漂移(IDE-PRJ-001) | `src/activeProfile.ts:71-101`;`src/activate/generators.ts:351-355`;package.json:117(onCommand)+:759(contributes);钉 `tests/activeProfile.test.ts`+`tests/projectProfiles.test.ts` |
| 选择结果常显 | 语言服务状态灯(RUST-219):就绪态文本缀 profile 名·资源根名——当前活动归属随时可见,切换即刷新(onDidChangeActiveProfile 触发链) | `src/backend/languageServiceStatus.ts:12,56`(RUST-219 钉 9 例) |
| 跨根跳转归属 | 根感知解析族:getWorkspaceRootForDocument(前缀匹配+首根回落)21 消费者(hover/codeLens/definition/引用全走)——跨根跳转解析到**正确根**的注册表数据,归属以解析正确性交付;服务端根注册表(RUST-069-W:id 发号/化身隔离/永不复用/未知根诚实)+findFilesAcrossRoots+KR-AUD-54 | `src/definitionWorkspace.ts`(getWorkspaceRootForDocument);RUST-186 钉 8 测试文件;`src/kodeCoreGate.ts:514`(新进程根注册表握手) |
| 逐值出处归属 | 配置合并视图(RUST-180):出处徽章 source-badge+catalogSource+sourceComments 逐值显示配置来自哪里(含工作区层次),与 active profile 联动 | `src/configVisualizerPanelHtml.ts:80,223,537-562`(RUST-180/CFG-06 钉) |

## 本批增量

- 零代码增量:选择 UI、归属常显、根感知解析、逐值出处均有既有实现与钉(activeProfile/projectProfiles/languageServiceStatus/definitionWorkspace/configVisualizer 套件),再造属仪式性重复。

## 诚实条款

- 跳转目标文件**不做**「此文件属于 root X」的文字徽标——VS Code 自身的路径/标签页展示承载文件位置,扩展侧归属以「解析到正确根的数据+状态灯常显 profile·根」交付;显式 root 徽标属展示增强,另批。
- 首根回落([0] 回退)是无文档上下文的共享回退语义(RUST-186 判例),不是归属建模缺口;未知根按 RUST-069-W 诚实上报不猜。
- 「active project」与「active profile」同义(本产品建模为 ProjectProfile,含 assetsRoot/engineRoot);QuickPick 是唯一切换入口,无独立树视图点击切换面(如实)。
