# RUST-140 批 1:SignatureHelp 调用点词法面下沉 Rust(验收纪实)

日期:2026-11-16
todo.md 行 401:`RUST-140(旧 LSP-007)SignatureHelp / parameter hints 使用类型 IR,不单独实现一套解析。`
本批边界:**调用点词法解析面**(批159 TS `getPythonCallAtPosition` 同构下沉)。def 方法签名解析(resolveMethodDefinition,类型 IR 面)与 `textDocument/signatureHelp` LSP 接线留批 2。

## 架构

- 新模块 `crates/kode-server/src/python_call_at.rs`:纯函数 `get_python_call_at_position(line, character) -> Option<PythonCallAtFace>`(单行词法,零引擎状态)。
- **UTF-16 单元域扫描**(TS 字符串逐单元语义精确同构):`encode_utf16()` 后全扫描在 `Vec<u16>` 上——正则 `\b`/字符类、字符串逃逸 `i += 1` 单元跳步、`i < character` 逗号比较全部同坐标系;匹配 token 全 ASCII,无跨系换算。
- 手写匹配(仓内无 regex crate,python_lexical_mask 先例同口径),TS `/g` exec 非重叠语义同构:命中后从匹配尾续扫;分支序 = alternation——①字面 `self.base/cell/client` → receiver_name="self" + section 映射;②通用 ident → receiver_name=token(如 `self.foo(` 走此臂,无段);`\b` = 起点前邻非 \w。
- 光标闸:character < call_open 不认;实参表字符串感知深度扫描(`()[]{}` 深度 + 引号/逃逸),顶层逗号(`depth==1 && i < character`)计 active_argument;闭合调用要求光标不越过闭括号(未闭合=边打边求助,视为延伸行尾);一行多调用取起点最靠后者(嵌套=最紧包含)。
- golden:`crates/kode-server/tests/golden/python-call-at-parity.json`(73 个 .py 语料文件 / **110,444 探测位 / 7,534 命中**,1.5MB)。探测设计 = 每文件每行(`'\n'` 切 + 尾 `'\r'` 剥 = lineAt 同语义)每位置 0..=行长全位置探测,golden 只存非空命中 + probeCount 全集对账(null↔null 平凡相等,存非空 + 计数 ≡ 全存储)。语料收集自收 .py(collect_corpus 只收 def/xml,且不可扩——扩了会改既有 golden 的 fileCount)。

## TS 镜像(最强形态)

`tests/kodePythonCallAtParity.test.ts`:**直接 import 生产 `getPythonCallAtPosition`**(pythonLanguageUtils)逐位置复算同一 golden——生产 TS 面 ↔ Rust 面零复算漂移对拍。3 例:.py 语料同集/逐文件 probeCount + hits 深等 + probeCount/hitCount 总计钉/护栏(section ∈ 三段值或 null,activeArgument ≥ 0)。

## 单元钉(9 例)

section_receiver_faces(方法名上不认/`(` 上触发/逗号 `i < character` 判定的 0↔1 边界)/ cell_client_object(self.非段走通用臂 receiverName=self 无段;对象调用 receiverName=变量名)/ string_aware_commas_and_escape(字符串内逗号/括号不算,逃逸引号不闭合)/ nested_brackets_depth / unclosed_extends_and_closed_rejects_after_close / two_calls_pick_latest_start / nested_calls_innermost_wins(嵌套双活取内层)/ word_boundary_no_midword_match(`myself.cell.y(`:0 位 ident 匹配尾失败,1 位被 \b 拒,6 位合法命中 receiver=cell)/ property_read_and_plain_calls_rejected。

## prove-red(五靶,全部 cp 还原 + cmp 字节校验)

- Rust T1:字符串感知闸死(in_string 分支清空)→ string_aware 钉红 + golden 重生成红;
- Rust T2:`\b` 闸移除 → word_boundary 钉红(receiver cell→self);
- Rust T3:tie-break 取首(pop→first)→ nested_calls_innermost_wins 红(嵌套 winner 内层→外层);
- TS MUT:golden 单点 section 翻转(base↔cell)→ 镜像 deep-equal 红;
- 还原后 unit 9/9 + golden 2/2 + 镜像 3/3 复绿。

## 过程坑(纪实,prove-red 纪律强化)

- **假红靶两次**:\b 与 tie-break 靶初次选点不敏感——①词中位置被非重叠 exec 的「命中后跳匹配尾」吞掉(`xself.y(` 的 1 位永远扫不到,TS 同);②相邻双调用探针处前一候选已被闭括号闸剔除(单候选时 first==pop)。可观察面 = 「早位匹配失败 + 内部位被 \b 拒」(`myself.cell.y(`)与「嵌套双活」(两候选同活,取后者);
- **陈旧备份吞钉**:T3 恢复用了加钉前的 /tmp 备份,把两枚新钉从盘上抹掉(T3 首跑绿=假绿)。教训 = 每轮变异前必须刷新备份文件,恢复后 grep 钉存在性再跑;
- **golden 尾字节双换行重蹈**:dump 函数返纯 JSON(不 push '\n'),bin `println!()` 补行——references 惯例直接沿用,未再犯;
- **golden 测试 serde rename 漏配**:测试侧 `GoldenFile` 忘加 `#[serde(rename_all = "camelCase")]`,dump 侧是 camelCase → "missing field probe_count";新 golden 测试必须先跑绿再做 prove-red;
- **分支结构 bug 被单元钉即时拦截**:初版 try_match_at 分支 1 消费 "self.base." 后共享代码再查 `.`(已指向方法名)→ 字面臂恒失败全落通用臂(receiver 变 "base");重构为两臂各自读方法后 8/8 绿。

## 诚实边界

- def 方法签名解析(resolveMethodDefinition:实体归属/继承链/段闸,类型 IR 面)与 `textDocument/signatureHelp` LSP 接线未做(同 RUST-138/139 口径:server.rs/rpc.rs 并发在途,只落纯库,生产服务面仍是 TS);todo 行不勾,只补批 1 进度注。

## 门禁(2026-11-16)

- cargo test -p kode-server 全量:1118 ok / 0 failed,RC=0(较上批 +11 = 9 单元 + 2 golden)
- cargo clippy -p kode-server --all-targets -- -D warnings:0
- pnpm lint 0 / pnpm compile 0
- pnpm test:unit:849 文件 10366 过 + 8 skip(+1 文件 +3 例 = 本镜像)
- xvfb-run -a npm run test:demo:editor:25 passing RC=0
- 提交前 lib.rs diff-vs-HEAD 逐块核对 = 仅本批 hunks
