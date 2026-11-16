# RUST-143 批 1 验收纪实:CodeAction 决策核七纯面下沉 Rust(code_action.rs)

日期:2026-11-16。todo 行:RUST-143(CodeAction 决策核下沉;本批=七纯面+golden 双向门禁,批 2=provider 装配面 LSP 接线)。

## 交付面

- `crates/kode-server/src/code_action.rs`(新建,~1170 行):七纯面同构下沉,正则全手写(仓无 regex crate),文本坐标域 UTF-16 code unit(TS Range character 与 regex match.index 同域),纯库零 RPC;
- `crates/kode-server/src/bin/dump-code-action-golden.rs`(新建):golden 生成器;
- `crates/kode-server/tests/golden/code-action-parity.json`(生成,11 语料/1194 探测/1194 产出):corpus(权威语料)+probes(权威探测面)与 outcomes(Rust 产出)同文件;
- `crates/kode-server/tests/code_action_golden.rs`(新建,2 测试):重生成比对(diff_at 诊断+重生成命令提示)+结构完整性(语料≥10/探测≥300/七面全覆盖审计/七面产出形态校验);
- `tests/kodeCodeActionParity.test.ts`(新建,3 测试):TS 镜像——读 golden corpus+probes 驱动**生产**函数逐探测复算,对拍 outcomes;
- `src/lib.rs`(Rust):两处接线(`pub mod code_action` + `pub use dump_code_action_golden`)。

## 七纯面(逐条对 TS 生产源核过)

1. **def 参数类型→内建注解**(defMethodConsistency.defArgTypeToPythonAnnotation):trim+22 键映射表(UINT*/INT*→int,FLOAT/DOUBLE→float,STRING/UNICODE→str,BOOL→bool,VECTOR2/3/4,ENTITYCALL/PYTHON→Any,PY_DICT/PY_TUPLE/PY_LIST,BLOB→bytes)+ BUILTIN_ANNOTATIONS 闸 {int,float,str,bool,bytes}(typing 泛型名需 import,骨架纯插入不碰文件头,不发射未导入名);
2. **方法骨架代码**(buildMethodStubCode):`    def X(self, arg0: int, arg1):\n        pass|raise NotImplementedError\n`——4 空格缩进,未映射类型退裸 argN;
3. **类块插入点**(codeAction.findPythonClassInsertionPoint):行首 `class\s+<名>(\s|\(|:|$)`,体=类头后到首个缩进<4 的非空行,插入点=末体行下一行(空体=类头下一行且无空行前缀);**末体行赋实际 index**(非计数递增,空行间隔会错位,prove-red 靶 3 实证);
4. **类型替换候选**(completion.findRegisteredTypeSuggestions):boundedEditDistance(列 DP+行极值早退,max 2,UTF-16 域)+距离升序/名字字节序并列+truncate 5;
5. **接收者区间归属**(codeAction.receiverFromDiagnosticLine):`\bself\.(cell|base|client)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)` 手写扫描,方法名 token 与诊断区间 `[startChar, endChar)` 开区间相交归属,提不出→null 不猜;
6. **守卫编辑器**(receiverNoneDiagnostics.buildReceiverNoneGuardEdit / buildReceiverNoneWrapEdit):早退守卫=使用行前插 `if not self.<r>:`+`return`(前导原文复用,空格文件+4 空格/tab 文件+1 tab);包裹式=`if self.<r>:` 包住语句组(2026-10-30 用户令语义)——块界=首个不引用 receiver 的同级非续行语句,括号未闭合的续行内空行/注释不断;
7. **整体重赋编辑器**(behaviorLints.buildFixedDictWholeReassignEdit):`^([ \t]*)(self\.\w*)((?:\s*\[...\]\s*)+)(?:op)?=(?!=)(.*)$` 手写,三行习语 `_fd = base` / `_fd<sub> <op>= <tail>` / `base = _fd`——**下标段必需**(正则必需组语义:运算符/`=` 必须紧贴末组,`self.count += 1` 的空格在组外直接拒绝)、`=(?!=)` 排除比较。

## golden 形态与对拍方向

`{generator, corpus, probes, outcomes}`:serde tag=face camelCase(insertion/stub/suggestions/receiverFace/guardEdit/wrapEdit/fdEdit),产出字段 camelCase(blankPrefix/startLine/endLine)。TS 镜像读 corpus+probes 驱动生产函数复算,逐探测对拍 outcomes(null↔null 平,否则深等)。**镜像红=移植错,按 src/ 生产源码重推**(语义真值源=生产函数)。Rust golden 测试同代码同义反复,防伪靠 8 个独立单元钉。

## 探测面

insertion 13(逐语料真类名+缺失名)/ stub 8(22 键全表扫+mixed+lowercaseUnknown×两 body)/ suggestions 12(11 unknown×8 registered+长名例)/ receiverFace 526(逐行×三值+全行与步 3 宽 2 滑窗)/ guardEdit 267 / wrapEdit 267 / fdEdit 89。非空产出 499。

## Rust 单元钉(8,全绿)

annotation_builtin_gate / stub_signature_shape / insertion_point_body_boundary / suggestions_distance_and_order / receiver_interval_attribution / guard_edit_shape_and_blank_refusal / wrap_edit_truncates_statement_group / fd_edit_requires_subscripts_and_bare_eq。

## prove-red(双端四靶,全闭环;cp 备份+变异+跑测+cp 还原+cmp 字节校验)

- Rust 靶 1:删 fd 下标段必需守卫(`groups == 0` return)→ 紧贴负例 `self.count+=1` 变 Some → fd_edit_requires 红 → 字节还原 → 8/8 绿;
- Rust 靶 2:候选距离排序反转 → suggestions_distance_and_order 红 → 字节还原 → 绿;
- Rust 靶 3:插入点行号改计数递增(`last_body_line += 1`)→ 空行间隔样本红 → 字节还原 → 绿;
- TS 靶:receiverFromDiagnosticLine 区间判据开区间改闭区间 → 镜像对拍红 12 条 → 字节还原 → 3/3 绿。

## 坑账

1. **indent_of 公式写反**:TS `lineText.length - trimStart().length` = 前导空白数,初版写成 `len - 前导空白数`(=去缩进后长度)——use_indent 变 12 导致 `    1)` 判低缩进早退,wrap 多行续行例红。教训:差值语义逐项验,不能凭「长度减什么」直觉;
2. **fd 正则必需组的空格语义**:`(?:\s*\[...\]\s*)+` 失败时 `\s*` 整体回溯不消费——运算符/`=` 必须紧贴 base 或末组尾。`self.count += 1`(空格挡)与 `self.count+=1`(紧贴)判定路径不同:前者无论如何 None,后者只有守卫在才 None。钉初版负例全带空格,守卫删除变异不红(假阳性护栏缺失)——加紧贴负例+语料紧贴样本后靶才闭环;
3. **插入点计数递增 vs 实际 index**:体行连续无空行时两者等价,体行中空行间隔才分化——钉初版无空行间隔样本,变异不红;加 `class A:\n    x = 1\n\n    y = 2\n` 样本(末体行 index 3,计数版错为 2)后闭环;
4. **serde tag 大小写**:`rename_all = "lowercase"` 把 ReceiverFace 变 `receiverface`(全小写),camelCase 才是 `receiverFace`——golden 结构审计测试抓出;
5. **clippy 两处**:while-let(peekable 计划未落地,直接 for 循环)+needless_range_loop(enumerate 改写);
6. **并发会话瞬态红**:全量 cargo test 期间并发会话在途件(dump-semantics/dump-references/dump-diagnostics-golden 等 bin)先后编译红,连坐 `cargo test --test` 目标选择(默认构建所有 bin 测试 harness)——等待并发会话修复后全量复跑绿;期间用 `cargo run -p kode-server --bin dump-code-action-golden`(单 bin 构建)不受牵连完成 golden 重生成。

## 诚实边界(批 2 范围)

provider 装配面留 TS:诊断 code 路由/WorkspaceEdit 构造/l10n 文案/取消令牌/EntityMappingManager 查询(def 方法缺实现面)/kbengine.entity.methodStubBody 配置读取。Rust 侧只承载纯决策与编辑文本生成,零 RPC 面(本批);LSP 接线在批 2。

## 门禁

eslint 0 / tsc 0 / vitest 全量 852 文件 10375+8skip exit 0 / cargo 全量 79 套件 1448 passed 0 failed exit 0 / clippy -D warnings 0 / xvfb demo 25 RC=0 / prove-red 双端四靶闭环 / golden 重生成字节锁(1194 探测)。
