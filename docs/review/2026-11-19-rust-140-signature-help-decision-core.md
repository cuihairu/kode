# RUST-140 批 2:SignatureHelp 决策核(方法声明解析 + 签名组装)

日期:2026-11-19
todo.md 行:`RUST-140(旧 LSP-007) SignatureHelp / parameter hints 使用类型 IR,不单独实现一套解析。`
本批边界:**解析决策核 + 签名组装面**——批 1 调用点词法面(30e8d6c6)之上,`EntityMappingManager.resolveMethodDefinition` 决策链同构下沉(实体归属/继承链闭包/接收者段闸/打分破平)+ `formatDefMethodParameter/formatDefMethodSignature` 组装同构 + activeParameter 夹取。`textDocument/signatureHelp` LSP 接线(server.rs/rpc.rs)与组件槽展开(componentSlotName +30 分支)留接线批,本批零接 server.rs 纯库不变。

## 架构(`crates/kode-server/src/signature_help.rs`)

- **类型 IR 复用,零新解析**:候选索引 `method_def_candidates()` 读 HoverEngine 已入库 `corpus_def` 视图(kode-parser DefFile 的 base/cell/client 三段);调用点复用批 1 `get_python_call_at_position`;路径身份/段推断/内建注解复用 RUST-144 `def_param_hints::{normalize_file_identity, infer_method_section_from_python_file, resolve_annotation_direct}`。
- **解析链对齐 TS resolveMethodDefinition**:
  1. 调用方 python 路径 → owner 三元组:`infer_owner_kind_from_python_file`(/components/→component、/interfaces/→interface、.py→entity)+ basename 去 .py;
  2. 本域 = owner 实体 def 继承链闭包**路径集**(`owner_chain_paths`:自身 + parent 链 + interfaces + components,接口 def 不跟随 Parent,环截断——chain_face 同一走查口径);
  3. 接收者段闸(用户令 2026-10-21):receiverSection 在场 = **硬过滤**(段不符剔除,不是降权),发生在打分之前;段缺省不设闸,调用方目录段经 +20 自然偏置;
  4. 打分:ownerKind +40 / ownerName +40 / callerSection +20 / sourceKind local +10;同分规范化 def 路径字典序、再行号稳定破平(TS localeCompare 边界:语料路径全 ASCII,字节序=locale 序);
  5. 本域 miss 且 ownerKind==interface && 段在场 → 全语料回退(TS allowCrossDefFallback);接口无段文件不回退(防误绑无关实体声明)。
- **组装对齐 TS**:形参 argN 与存根生成器同口径;类型注解内建直查,解析值 Any(含 ENTITYCALL/PYTHON 内建)只出名不显 `: Any`(与 production formatDefMethodParameter 对 PYTHON_TYPE_STUB_FALLBACK 同收口);documentation 三段拼接逐字节(`此调用是实体 def 声明的 {section} 方法` + `(接收者 self.{section})` + ` · **Exposed**: 可被客户端远程调用`);activeParameter 超界夹到末形参、零形参恒 0。
- **注册表快照链诚实边界**(RUST-144 同):types.xml/alias.xml 注册表(workspaceRoot≠'')留 TS,本面只有内建直查——语料自洽口径下已解析 `<Arg>` 全部内建命中,链断降级臂由合成钉闭环。
- **发现登记(不冒充修复)**:`definition.rs entity_defs_root` 的 entity_defs 折算分支对树外路径不可达(defs_root 返回 entities 目录时 `path.starts_with("{defs_root}/")` 恒真,折算分支死代码)——现有调用方只喂 entity_defs 内路径故未爆;本面本地折算(defs_root 尾段判断),该面修复归 definition 车道。

## golden 第三面

`crates/kode-server/tests/golden/signature-help-parity.json`(73 py 文件 / probeCount 111677 / hitCount 7609 / resolvedCount 330 / 24 条目):
- **对账锚**:probeCount/hitCount 与批 1 python-call-at golden **同值**(Rust 结构测试 + TS 镜像双侧钉)——决策核消费面 anchored 在批 1 探测口径上,零另起探测;
- 组键 =(行, 方法名, 接收者段),签名四件取组内首见解析(组内确定性:解析只依赖文件+方法名+段),`activations` 逐位记 activeArgument→activeParameter 标亮;未解析命中不入档(hitCount−resolvedCount 差值对账,TS 镜像复算 miss 位必须同落空);
- 生成器 `dump-signature-help-golden`;重生成比对 + 结构完整性(逐文件命中/探针对和、resolvedCount=激活位和、label 组装重算、documentation 拼接重算、段值域、夹取口径、exposed/带参真分布在场钉)。

## TS 镜像

`tests/kodeSignatureHelpParity.test.ts`(生产词法面 + 生产注解链 + defParser 原语,4 例):
1. 语料同集 + 批 1 golden 三计数对账锚;
2. 逐文件复算深等(探针/命中/条目/签名四件/逐位标亮/resolvedCount 守恒)——解析决策链与组装全链独立重推,不读 Rust 结果;
3. 未解析命中位如实落空(复算解析位集合 == golden 激活位集合);
4. 护栏:声明落点 ∈ 语料、label 前缀、段值域、夹取上界、resolvedCount ∈ (0, hitCount)。
坑账:镜像条目排序 comparator 首版把末位三目写进 `||` 链(`a||b||c?-1:1` 整链成条件)→ 纯排序噪声假差;修为显式 cmp 链。

## prove-red(三靶闭环,cp+cmp 字节还原 + grep 钉存在性)

- T1(Rust):接收者段闸改降权(+25)→ `section_gate_hard_filters_before_scoring` 红;**golden 重生成绿=语料不可分辨**(调用方目录段与接收者段在语料上恒同段,+20 偏置已选对)——硬闸 vs 降权的可观察面只在合成钉上,如实登记;
- T2(Rust):破平摘除(路径序+行号)→ `tie_break_line_within_same_file` 红;
- T3(TS):镜像接收者注记摘除 → 深等红 1 例(全部条目带接收者段)。

## 单元钉(15 例)

段硬闸双段同名 / 段缺省目录段偏置 / 本域隔离跨 root 同名 / 接口闭包折入 / 接口无段不回退 / 接口 owner def 缺失全语料回退 / 接口 owner 在语料本域自命中(回退臂分界) / 路径破平 / 行号破平 / owner 归属压目录段 / activeParameter 夹取三臂 / documentation 三段逐字节 / 形参注解边界(内建造型/未知只出名/空只出名/label 拼接) / **RUST-149 横切**:撤根后解析如实 miss + 同路径 def 换代即换签名(stale 替位钉;stale/cancel/cold 对同步纯面 N-A 如实登记)。

## 门禁

- `cargo test -p kode-server`:lib 778/778(含 signature_help 15)+ 全 integration 0 failed(ruff_format::nonzero_format_exit_is_surfaced_as_err 全套件跑一例瞬态红,单跑绿 + 重跑全套绿=共享门 flake 判例再+1,与本面无关);
- `cargo clippy -p kode-server --all-targets` 0(初跑 map_or→is_none_or 一处,修后 0);
- vitest:kodeSignatureHelpParity 4 + kodeReferencesParity 3 + kodeReferencesSemanticParity 4 + kodePythonCallAtParity 3 = 14;
- tsc:`tsconfig.json` 0 + `tsconfig.mocha.json` 0(零 src/ 改动)。

## 坑账(本批新增)

1. **`cargo fmt -p kode-server` 全包跑=53 文件 fmt 噪音**(现 toolchain 与既有版面差异,仓无 fmt CI 门)——checkout 恢复 + 仅重放本批两处接线(lib.rs 两行/python_call_at.rs 可见性);判例:**本仓禁全包 fmt,只 fmt 新文件**;
2. rust 测试侧 serde rename 漏一处 camelCase / `SECTIONS.contains(&String)` 类型错——编译期即拦(批 1 坑③判例再验:先跑绿再 prove-red);
3. 语料空 `<Arg> </Arg>` 不产参(parser 非空才入)——fixture 首版按"空类型只出名"期望红,改两实型;空类型臂归合成钉;
4. TS 排序 comparator 三目优先级吞 `||` 链(见上)。

## 余账(批 3+)

- `textDocument/signatureHelp` LSP 接线(server.rs/rpc.rs)——纯库就绪,接线时 TS 薄壳切 `signature_help`(预算/版本闸留 TS);
- 组件槽展开(componentSlotName +30)——需要 components/<Type>.def 槽位绑定,随槽展开批;
- TS 面生产切换与注册表快照链(workspaceRoot≠'' 注解)——随接线批。
