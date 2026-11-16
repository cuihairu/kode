# RUST-180 验收纪要:配置合并视图(来源、优先级、冲突、最终值)不阻塞语言请求

日期:2026-11-17。本纪要对账 RUST-180(旧 KBE-010,主 todo 排队项)的验收口径与既有交付证据,并补齐最后一块命名钉(取数面执行归属)。结论:**视图四维度与「不阻塞语言请求」均已交付,本批补命名验收钉 `crates/kode-server/tests/config_resolve_lane.rs` 后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 来源(逐键出处) | 合并可视化面板出处徽章与键详情(file:line 引用),CFG-06 hover 追加来源证据块(来源层 custom/defaults、生效值、CFG-02 单位证据、敏感键脱敏) | `src/configVisualizerModel.ts`(selectKey 回包三值对照+出处+片段);feat d0ed217d(KODE-CFG-VIZ-001);feat 00cb65bb(SEM-036) |
| 优先级 | 三态主轴 defaults→override→final(覆盖胜出即优先级可视化),显式重申不扩主轴(restated 如实标注) | `src/configVisualizerModel.ts` §4.1 三态主轴;d0ed217d |
| 冲突 | 仅看被覆盖键过滤;重名表整表替换全标注;CFG-08 项目配置跨文件冲突显式给来源(pathConflicts,binding-type/literal-shape/open);CFG-09 关系检查(端口冲突按绑定面×协议族×部署角色,不全局去重) | d0ed217d;feat 9aa0c041(SEM-038);feat c8ba2183(SEM-039) |
| 最终值 | final 态合成 + 最终配置虚拟文档(`kbengine.config.showFinal`,合成来源与覆盖口径文档头注) | `src/serverConfigMerge.ts`(批112);d0ed217d |
| 不阻塞语言请求 | 架构三层面:①serving 面(hover/completion/definition/diagnostic)主线程**内联**,永不经过 worker 池;②视图取数(`$/kode/config/resolve`/`$/kode/config/derive`)归池**交互泳道+纯 CPU**(TS 读盘传文本,handler 纯解析);③交互预留位恒准入,后台两类硬顶都拦不住交互面;真实阻塞 IO 泳道不串道由 RUST-076-W mkfifo E2E 钉死。本批新增命名钉把 `$/kode/config/resolve`/`derive` 的归属显式固化(防未来误入 IO 表或后台泳道) | `crates/kode-server/src/executor.rs`(ExecutionLane/PoolLane/rpc_lane_class 单一分类源);`tests/executor_ownership.rs`(全量归类断言+IO 表陈旧防);`tests/lane_gate_e2e.rs`(真阻塞不串道);**本批** `tests/config_resolve_lane.rs` 2 例 |

## 本批增量

- `crates/kode-server/tests/config_resolve_lane.rs`(新,2 例):取数面注册存在性 + 泳道 Interactive/Cpu 命名钉;语言 serving 面内联对照钉。prove-red 双变异(假面名单→注册断言红 RC=101;泳道断言改 Background→分类断言红 RC=101),cp+cmp 字节还原。
- TS 侧消费链既有缓存纪律不变(`src/serverConfigResolve.ts` ensureConfigResolved 单槽:generation+epoch+双指纹防过期落槽,RPC 失败走 TS 回落核并如实标注 `resolver:'ts'`)。

## 诚实条款

- 「不阻塞」是**架构归属属性**(两轨零共享+交互预留位),不是时延 SLA;池被打满时视图取数可能排队,但语言 serving 面路径上没有任何池等待点。
- 视图本体(KODE-CFG-VIZ-001)与来源/冲突半面(CFG-05/06/08/09)均为既往批次交付,本批不重复实现,只做验收对账与命名钉;`docs/design/config-visualization.md` 仍为界面设计事实源。
