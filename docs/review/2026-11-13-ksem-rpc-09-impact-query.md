# KSEM-RPC-09 实现 RPC 修改影响查询

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-09 [P1]「实现 RPC 修改影响查询。验收:修改方法/Arg 后列出确定调用点及不确定候选;索引缺失显式说明而非返回完整零影响。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 修改方法/Arg 后列出确定调用点及不确定候选 | `impact_query(change, sites, coverage)` 三桶分诊:`RpcChange::{MethodChanged, ArgChanged}` → `ImpactReport{definite, uncertain, coverage}`;确定 = 方法名字面量命中 ∧ 引用已解析 ∧ 接收者绑定目标类;不确定候选 = 动态方法名(None)/接收者类未知/引用未解析/ArgChanged 遇动态展开;**绝不静默归入不受影响**(过近似纪律);异名与绑定别类 → 不进任何列表 |
| 索引缺失显式说明而非返回完整零影响 | 索引覆盖态由消费方显式声明 `IndexCoverage::{Complete, Partial{uncovered}, Missing}`;`coverage_notice()` 在 Partial/Missing 必有显式说明(「不构成零影响结论」);**零影响红线钉在 API 形状上**:`no_impact_claim()` 只在「覆盖完备 ∧ definite+uncertain 皆空」才返回结论文本——索引缺失/不全时调用方**拿不到**「零影响」这句话,误报防线不靠调用方自觉 |

## 2. 设计纪律(纯库面消费契约,引擎语义引用既有面)

- 分类是**过近似**:宁可进不确定候选,不可漏报。方向可达性(RPC-05)、逐位类型(RPC-06)、广播接收面(RPC-08)都已有专面,本批不重复裁——影响查询按「引用形态是否解析 + 接收者绑定」的解析事实分桶;
- `RpcUsageSite` 是消费方转述的最小事实表(method_name/receiver_class/reference_resolved/is_broadcast/has_dynamic_args):动态方法名给 None、接收者未知给 None、未解析给 false——「不知道」在契约里是一等公民,不是错误;
- 组件广播面的查找落点在组件 def 模块(RPC-08 已核),契约规定此类条目 `receiver_class` 填**组件类名**——防「宿主类≠目标类被误排除」;
- ArgChanged 遇 `has_dynamic_args`(`*args`/`**kwargs`,RPC-06 红线同源)降不确定:该位是否被传位数不可知;MethodChanged 不按实参裁(命中方法本体即确定);
- 覆盖态不由本模块推断(消费方对自己的索引最清楚),但结论权被收走——这是「显式说明而非完整零影响」的结构化实现。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/impact.rs` | 新模块:`RpcChange` 两态/`RpcUsageSite` 最小事实表/`IndexCoverage` 三态/`ImpactReport{definite, uncertain, coverage}` + `no_impact_claim`(零影响红线)+ `coverage_notice`(缺口显式说明)+ `impact_query`/`classify_site`(六步判定次序,1 动态名→候选/2 异名→排除/3 引用未解析→候选/4 类未知→候选/5 别类→排除/6 类命中→Arg 动态展开降级);测试 14 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod impact` 注册 + 模块文档 RPC-09 条目 |

## 4. 诚实边界

- 分桶只按解析事实;「接收者绑定目标类」的继承展开(子类调用父类方法受父类变更影响)由消费方在 `receiver_class` 转述时展开,快照合并规则归 BAS-05 面;
- 不确定候选的**收敛**(逐步解析把候选升级为确定/排除)是消费批次的迭代动作,本批只保证候选不丢;
- `IndexCoverage::Partial` 的 `uncovered` 由消费方给自由文本范围描述,本模块只透传拼接,不校验范围语法;
- 无 TS 装配、无 LSP 消费——报告形状(数组+覆盖态+两个结论入口)供后续消费批次接线。

## 5. 证据

- `cargo test -p kode-server --lib semantics::impact` 14/14(字面量+绑定→确定/动态名→候选不丢/异名双排除/未解析带类名仍候选/类未知候选/别类排除/广播按查找类命中/Arg 变更动态展开降级+普通位确定/方法级变更不按实参裁/索引缺失零影响不可得+说明必有/Partial 说明带未覆盖范围/完备+空=零影响可得/不确定候选阻断零影响/五条目三桶混分);
- **prove-red = 变异三发全咬合**:(1) 零影响结论无视覆盖态 → 1 例红;(2) 引用未解析静默丢进不受影响 → 2 例红;(3) ArgChanged 不降级动态展开 → 1 例红;恢复 14/14;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 339 含新 14;首轮 `ruff_lint::nonzero_check_exit_is_surfaced_as_err` 单例抖动=假 ruff 桩在满载下 spawn 失败,负载 4.5 复跑全绿,solo 复跑 2/2);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
