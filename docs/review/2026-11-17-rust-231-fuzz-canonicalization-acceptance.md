# RUST-231 验收纪要:XML/DEF 非法输入不 panic/hang + path canonicalization 无碰撞(纯对账)

日期:2026-11-17。本纪要对账 RUST-231(旧 QA-002,主 todo 排队项)的验收口径与交付证据。结论:**两维全部既有面+既有测试钉——kode-parser blind.rs 头注即「QA-002 基础版」(确定性伪随机变异语料),canonicalization 侧 HR-MOD-009 词法规范化+HR-MOD-006 碰撞即拒,零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 测试钉 |
| --- | --- | --- |
| XML/DEF 非法输入不 panic | `kode-parser` 字节级 XML 状态机+容错恢复(SYNTAX-002/003);crate 铁律「任何输入不 panic」(lib.rs 头注);`.def`/entities.xml/types.xml/alias.xml 四解析器 | `tests/blind.rs::blind_mutations_never_panic`(LCG 确定性伪随机变异语料,seed 固定 CI 可复现;断言不 panic+诊断结构化 span 在界内+树不丢)+`blind_truncations_keep_prefix_tree`;`parser_units.rs::error_recovery_truncated_never_panics_never_drops_tree`/`mismatched_and_stray_close_recover`/`unterminated_comment_and_cdata_report_but_keep_tree`/`duplicate_attribute_keeps_first`/`unknown_entity_keeps_literal_with_diag` |
| 不 hang(终止性) | db-clone RelationGraph 嵌套/环引用 fail-closed;blind 变异含截断面(树保留=解析有界) | `kode-db-clone/tests/fuzz.rs`(环引用检出+终止不 panic 断言,xorshift64 确定性 PRNG 免第三方依赖 CI 可复现) |
| path canonicalization 无碰撞 | `src/backend/hotReloadModuleIdentity.ts::canonicalizeScriptFilePath`(HR-MOD-009 词法规范化,纯字符串零 IO)+resolveHotReloadModuleIdentity | `tests/hotReloadModuleIdentity.test.ts`:坏转义原样保留不抛/盘符统一大小写保留/UNC 保留/`..` 卷出根交解析器拒/**多根多命中 ambiguous 列全候选拒绝解析不猜(HR-MOD-006 碰撞即拒,不静默择一)**/相邻目录假包含不命中(/ws/scripts2 不顶替 /ws/scripts)/out-of-root 如实 |
| 外围同类面 | db-clone 归档/规则/BLOB fail-closed;kbengine-protocol framing 内存上限红线 | `kode-db-clone/tests/fuzz.rs`(畸形归档/奇数 hex/负 BigUInt/未知 tag)+`kode-kbengine-protocol/tests/framing_fuzz.rs`(三长度形状/粘包拆包/内存上限,PRNG 驱动) |

## 自我验收证据

- `cargo test -p kode-parser -p kode-db-clone -p kode-kbengine-protocol` RC=0:全绿(blind.rs 双例+parser_units 容错族+fuzz.rs 4 例+framing_fuzz 12 例在册)。
- `npx vitest run tests/hotReloadModuleIdentity.test.ts` RC=0。
- 对账方法:blind.rs/lib.rs 头注自证 QA-002 谱系;两维逐一锚定实现文件+测试函数名。

## 诚实条款

- **blind.rs 是确定性盲样抽验,非持续 fuzz**:头注自认「arbitrary/proptest 纲要随 fuzz 单后置(本单为确定性盲样)」;语料=固定种子变异真引擎夹具,非无限随机流。升级到持续 fuzz 属可补强项非缺口(基线=fail-closed 断言面已成立)。
- **canonicalization 是词法形态非 realpath**:HR-MOD-009 头注自认「符号链接消解与 fs 级大小写语义需 realpath/平台 API」——刻意纯字符串零 IO(热更面输入已是工作区文件 URI);「无碰撞」以 HR-MOD-006 碰撞即拒交付(不静默择一),非以 realpath 消解交付。
- "hang" 维无独立超时断言——终止性由环检出+树保留+状态机有界输入承载,如实记账。
