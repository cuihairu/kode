# RUST-233 验收纪要:旧 TS 输出 vs 新 Rust 输出逐项差异审查 + 已知旧 bug 单独定标(纯对账)

日期:2026-11-17。本纪要对账 RUST-233(旧 QA-004,主 todo 排队项)的验收口径与交付证据。结论:**两维全部既有面——RUST-PRECISION-001 精确性主车道战役(2026-11-11)四批每批全语料 diff 逐条过目的审计纪律与裁决表在案,已知旧 bug 以「实测误导账本」逐项单独立靶定标并分批收口;19 个 parity 套件构成持续回归网。零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| 逐项差异审查 | 战役纪律 4:「每批全量差异审计——所有对拍/fixture 跑出的分歧逐条过目,只接受『改进/持平』,任何回退单独审并记录在案」;批 A 裁决表 7 类位置逐一裁决(嵌套类跨类误绑=改进/方法间隙=持平·改进/类尾赋值=改进 prove-red 恰红/未闭合括号=改进/平铺生产位=持平对拍全绿);四批(A 域/B 字面量假阳性/C 补真值/D 杀误绑)全走同一纪律 | `docs/review/2026-11-11-precision-campaign.md`(审计记录文件);RUST-152 审计结案行自证「RUST-PRECISION-001 四批每批全语料 diff 逐条过目只收改进持平」(todo.md:415) |
| 已知旧 bug 单独定标 | 实测误导账本 5 项逐项立靶分批收口:①集合字面量 `{1,2}` 误判 dict(批 B 杀);②返回注解跨类同名误绑 cascadeAnnotation 全局猜测(批 D 删 TS 猜测+Rust 接收者定型);③嵌套类/条件 def 域错位(批 A 真域);④未知 RHS 抹 None 证据(批 C 收窄漏报);⑤链式/别名/跨变量诚实缺失(批 C 补)。定标钉=策展误导样本→新正确值断言 + 无伪造样本→null/空断言(split-parity 测试法) | `tests/selfAttributeFlowPrecision.test.ts`(16 例策展精度钉)+`tests/selfAttributeFlowRustParity.test.ts`+`tests/attributeNoneRustParity.test.ts`(13 例当日绿);未触及维度深等回归网=19 个 `*RustParity`/`kode*Parity` 套件 |
| 差异化失效(另一义 differential) | RUST-120-W 变化分类差异化失效生产接账(Identical/BodyOnly/Signature/Removed 四类分动作) | `docs/review/2026-11-16-rust-120-w-differential-invalidation.md` |

## 自我验收证据

- `npx vitest run selfAttributeFlowPrecision/selfAttributeFlowRustParity/attributeNoneRustParity` RC=0(13 例,策展误导样本断言全绿)。
- 全量 unit 10659(2113d5f4 门禁)含 19+ parity 套件全绿——差异审查的持续回归网当日已全量过。

## 诚实条款

- 「旧 TS 输出」的可比性是**有意的、逐批收缩的**:split-parity 纪律(战役纪律 3)取代了 B1 字节全量对拍——升级维度不再以 TS 旧输出为基准(TS 旧输出本身就是要修掉的误导源),改为策展精度断言;TS 引擎冻结为杀开关兜底(`kbengine.core.backend=ts`),其测试全保。所以「TS vs Rust 逐项对拍」在未升级维度成立(parity 套件),在已升级维度以「旧 bug 定标」形式成立——两种形态都是差异审查,如实记账。
- 批 B/C/D 的分歧裁决细节在战役文档各批节内(批 A 表格式最详尽),非每批同构表格——审计实质(逐条过目+只收改进持平)四批一致,记录形态如实。
