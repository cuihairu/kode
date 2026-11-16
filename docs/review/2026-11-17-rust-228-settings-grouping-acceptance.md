# RUST-228 验收纪要:设置分组(本批真增量)

日期:2026-11-17。本纪要对账 RUST-228(旧 UI-011,主 todo 排队项)的验收口径与交付证据。结论:**分组维是真缺口(153 键单 configuration 块,设置页无分组标题),本批落地 8 个带标题分组块;默认简洁维既有默认值口径如实记账。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 设置分组 | `contributes.configuration` 从单块 153 键拆为 **8 个带标题分组块**(title 走 nls 双语+order 1..8):Performance(性能与监控,13)/Semantic Checks(语义检查,32)/Python Language Service(Python 语言服务,39)/Type Stubs(类型桩,6)/Engine & Project Paths(引擎与项目路径,8)/Runtime & Hot Reload(运行时与热更,37)/Generator & Tools(生成与工具,12)/General & Views(通用与视图,6);VS Code 设置页按块标题出目录分组,153 键导航性成立;**键一字未动**(键改名=破坏用户设置,分组是展示层拆块,属性定义逐字节保真) | 本批 `package.json`(8 块)+`package.nls.json`/`package.nls.zh-cn.json`(8 标题双语);钉 `tests/settingsGrouping.test.ts` 4 例(块结构/order/双语标题/键集合不丢不重/分组归属抽检/plugins 不造空组) |
| 默认简洁 | 基础质量项默认开(诊断/语言服务/桩导出),高噪音高级项默认关(`kbengine.metrics.fileReadDetail=false`/`kbengine.debug.autoDebugpy=false` 举证);分组后默认体验=8 块目录按需深入,不逐键扫 153 项 | `package.json` 各键 default;既有钉 `tests/featureToggles.test.ts`(开关默认值契约)/`tests/runtimeQueryWebView.test.ts`(操作面默认关) |
| 消费面随动 | 运行时枚举布尔开关的复现配置摘要(IDE-REL-007)改分组块聚合口径,开关清单随 153 键全集如旧 | 本批 `src/activate/utilityCommands.ts:590-607`;既有钉 `tests/extension.test.ts` IDE-REL-007 绿 |

## 本批增量(feat 01f39748)

- `package.json`:configuration 拆 8 块(json round-trip 字节保真验证后落盘,属性定义零改动)。
- nls 双语 8 标题键。
- `src/activate/utilityCommands.ts`:复现摘要开关枚举改分组块聚合(数组形态兼容)。
- 9 个测试访问点随动(聚合键集合同旧单块口径,门意图不变):manifestI18n/configSwitchGifs/configReadPaths/hotReload/featureToggles/runtimeQueryWebView/httpRequests/lintRuleRegistry(+docsCommands/configMarkdownDescription/hotReloadAssetsRootWatch 三件本就数组兼容无需改)。
- 新钉 `tests/settingsGrouping.test.ts` 4 例;prove-red:变异 performance 块标题键 → 红(RC=1)→ cp+cmp 字节还原 → 绿。
- 门禁:lint 0 / compile 0 / unit 10656 全绿(10652+4)。

## 诚实条款

- **plugins 分组未建**:全仓无插件子系统(PLUG 202..217 家族判例=无宿主/loader 的整子系统不建),mcp/generator/gitHistory 等落 Generator & Tools 块;待拍板家族若未来落地插件面,再立 plugins 分组(设置锁已钉「不造空组」)。
- 分组是**展示层拆块**,不改任何设置键名/默认值/语义;用户既有 settings.json 全部原样生效。
- 「兼顾高级选项」由默认值口径承载(基础开/高噪音关),未引入「高级/简单」两档视图切换(VS Code 无此清单原语,如实)。
