# RUST-184 验收纪要:Space/Watcher 按真实引擎协议实现,协议未验证不宣称 mutation/subscription

日期:2026-11-17。本纪要对账 RUST-184(旧 KBE-014,主 todo 排队项)的验收口径与既有交付证据,并补齐诚实面钉。结论:**协议面已按真实引擎协议审计钉死且只做查询只读,零 mutation/subscription 宣称,本批补 `tests/spaceWatcherProtocolHonesty.test.ts`(2 例)后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| Watcher 按真实引擎协议 | 逐组件 queryWatcher 请求号逐条钉到引擎版本源码:目标 kbengine@f85ad81,请求号出自 `kbe/res/server/messages_fixed_defaults.xml` `<组件::queryWatcher>` 段(dbmgr 41006/loginapp 41003/baseappmgr 41004/cellappmgr 41005 等 8 条),回包 65502 出自 `console_helper.h` CONSOLE_WATCHERCB_MSGID;`verifyWatcherProtocolAgainstAudit` 把审计表与生产映射逐条咬合,「不沿用未验证常量」 | `src/watcherProtocolAudit.ts`(IDE-LIV-002);`tests/watcherProtocolAudit.test.ts`(键集相等/引据指名/组件枚举位一致) |
| Space 按真实引擎协议 | 对运行中 cellappmgr 发 `Cellappmgr::querySpaces`(50003,同 XML 段),回包走 CONSOLE_PROFILE_CB(65503);快照与广播发现的 cellapp 组件身份逐个对账(对得上/对不上都点名);geomappingPath/scriptModuleName/cells 缺失如实标「未知」绝不猜邻居值 | `src/liveSpacesVerification.ts`(IDE-LIV-004);`src/backend/kbengineProtocol.ts`;`tests/ideLiv004LiveSpacesVerification.test.ts` |
| 只做查询只读 | 协议导出面全是查询/回包形状:WATCHER_QUERY_MSG_IDS(8 组件)、CELLAPPMGR_QUERY_SPACES_MSG_ID、CONSOLE_WATCHER_CB/PROFILE_CB;logger 通道的 register/deregister log watcher(702/703)是引擎日志流协议面(读侧),非 watcher 写通道 | **本批钉** 导出消息常量零 mutation 动词 + 查询面正控 |
| 不宣称 mutation/subscription | 文档宣称面扫描:features(英/中/指南英/指南中)含 space/watcher 的行零「支持/提供/启用 + mutation/subscription/订阅/写回」句式;诚实非宣称并存——「log viewer 尚未完成官方 logger watcher 协议适配」「不依赖 logger watcher 协议」如实降级不冒充;运行时查询面板的「观察清单增删与结果订阅流」是**已实现的客户端面**(watchList 增删校验 + pollIntervalMs ≥500ms 轮询),非引擎协议订阅宣称,不属违规 | **本批钉** 文档宣称句式扫描;`src/runtimeQueryWebView.ts`(清单/轮询实现);`docs/guide/features.md:49,63` |

## 本批增量

- `tests/spaceWatcherProtocolHonesty.test.ts`(新,2 例):
  - 协议面形状钉:`kbengineProtocol.ts` 导出消息常量(≥5 非空守卫)零 mutation 动词(set/write/create/delete/modify/remove/subscribe/mutate/update),WATCHER_QUERY_MSG_IDS 8 键 + 50003 + 65502 正控在册;
  - 文档宣称钉:四份 features 文档 space/watcher 行零宣称句式(英文动词加 `\b` 词边界——设置名 `runtimeQuery.enabled` 的 "enable(d)" 不是宣称动词,首版无边界误报已修);
  - prove-red 双变异(动词表注入 `query`→查询常量即红;宣称句式放宽为 `/订阅/i`→zh 522 行即红),cp+cmp 字节还原。
- TS 生产代码零改动(协议面/审计面/面板均为既有交付)。

## 诚实条款

- 「按真实引擎协议」的保证形态=**协议号审计钉**(请求/回包号逐条指名引擎文件与 XML 段,verify 咬合生产映射,漂移即红),不是对引擎全部消息面的穷举覆盖;未审计的消息面不存在于生产导出(本批动词钉防未审计写通道悄悄长出)。
- mutation/subscription 禁令针对**引擎协议层**(watcher 写操作/推送订阅);运行时查询面板的客户端观察清单与轮询订阅流是已实现 UI 面,文档描述如实,不构成违规。
- logger 通道 register/deregister log watcher(702/703)属引擎日志流协议(读侧订阅通道),在导出面存在但不属 watcher 观察 mutation;log viewer 对该协议的适配状态文档已如实标注「尚未完成」。
- 门禁附记:lint 0,unit 全量 874 文件 10615 过(含本批 2 例;上批拼写门超时本批复过)。
