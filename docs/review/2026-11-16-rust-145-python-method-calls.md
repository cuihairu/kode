# RUST-145 批 1:CallHierarchy incoming/outgoing 决策核收编 Rust

日期:2026-11-16
范围:audit 面三件中的可收编件(CallHierarchy incoming/outgoing);TypeHierarchy 与 dependencyGraph 如实处置(见「诚实边界」)。

## 收编面

TS 决策核自 `src/entityMappingHelpers.ts` / `src/entityMapping.ts` 下沉:

- `src/backend/pythonMethodCallQueries.ts`(新,纯库零 vscode/fs import):
  - 迁入 `parsePythonMethodBlocks` / `inferMethodSectionFromPythonFile`(语义逐字节不变;`normalizeLookupPath` 即 `normalizeFileIdentity` 直通别名,此处直用);
  - 新 resolve 面 `resolveOutgoingPythonMethodCalls`(目标定位→self. 调用点绑定:精确文件+名优先、同文件无此名回退同名任意文件、dedup 键 `归一路径:名:行:列`)与 `resolveIncomingPythonMethodCalls`(索引分桶→打开文档覆盖仅对已入索引文件→flat 扫描→进程作用域过滤:双方块已知且不同跳过、未知区块保守保留)。
- `src/entityMappingHelpers.ts`:三函数原文删除,re-export 保持既有导入路径(消费者零改动);`EntityMethodSection` 类型 import 保留。
- `src/entityMapping.ts`:`getOutgoingPythonMethodCalls` / `getIncomingPythonMethodCalls` 委托纯核;取消检查与打开文档清单收集留在 manager 包装面。

Rust 同构:

- `crates/kode-server/src/python_method_calls.rs`(新,零 RPC 纯库):JS 正则手写移植保真点(JS `\s` 全集、async 贪婪可选组先试失败回退裸 def 路、方法名列 `line.find(method_name)`=TS indexOf 全行首现语义、self 调用 `\bself\.name\s*\(` 词边界+失败前移一位、UTF-16 列域、0 基截断行 endLine、JS trim 语义空行判定);`resolve_incoming` 保 JS Map 插入序(order Vec + buckets HashMap,覆盖保位)。
- `crates/kode-server/src/lib.rs`:`pub mod python_method_calls;`。
- golden 对拍:`crates/kode-server/src/bin/dump-python-method-calls-golden.rs` + `tests/python_method_calls_golden.rs` + `tests/golden/python-method-calls-parity.json`(8 语料条目:三进程形态/async 前缀/CJK 名/`　` 全角空格截断钩子/零缩进注释截断;12 probes:outgoing 8 + incoming 4,含打开文档覆盖面)。TS 镜像 `tests/kodePythonMethodCallsParity.test.ts` 读同一 golden 驱动生产函数复算深等。
- 单测钉:Rust 7 例(模块内);TS `tests/pythonMethodCallQueries.test.ts` 3 例(re-export 同一函数/async 回溯/路径身份归一)。

## prove-red(四靶,双端)

以 cp 备份+变异+复跑+cp 还原+cmp 字节校验执行:

1. **Rust 空白行截断**:`js_trim_empty` 改恒 false → `　` 行不再截断方法块,gap.py 语料尾部 `self.tail()` 调用丢失(单测 calls.len 红 + golden 偏移变化),还原绿。
2. **Rust dedup 键**:去重键去掉路径分量 → 同名跨文件调用点合并,references 数变少,红;还原绿。
3. **Rust incoming 覆盖**:openTexts 覆盖分支删除 → 覆盖探测结果与无覆盖一致,incoming 面 caller 集不合期望,红;还原绿。
4. **TS 作用域过滤**:callerSection !== targetSection 跳过分支移除 → cell 调用方混入 base 目标 incoming,parity 镜像红;还原绿。

## 取消语义等价改写(如实登记)

原 TS 实现在扫描循环内 `if (token?.isCancellationRequested) return []`(循环中途退出);纯核化后取消检查上移包装面,纯核算毕后入口处复查 `token?.isCancellationRequested` 返回 `[]`。调用方所见契约不变(取消→空数组),但最坏延迟从「循环内即时」变为「本次解析算毕」。调用层次单次解析为毫秒级索引查询,无长循环,维持现状不加循环内检查。

## 诚实边界

- **TypeHierarchy**:VSCode proposed-only API(`createTypeHierarchyProvider` 等),仓库内无 stable 面,不收编;待 API 转正另立项。
- **dependencyGraph**:已 Rust 化(`$/kode/dependency/graph`),本批零改动。
- **配置契约五件套**:本批零新增配置键,不触发。
- **golden 镜像方向**:语义真值源是 TS 生产函数,golden 由 Rust 侧 dump 生成、TS 镜像复算深等——Rust 移植错时镜像红,按 src/ 源码重推。

## 门禁(全绿后提交)

- `cargo clippy -p kode-server --all-targets -- -D warnings`:0
- `cargo test -p kode-server`:绿(含 python_method_calls 7 单测 + golden 2 例)
- `pnpm lint`:0;`pnpm compile`(tsc):0
- `npx vitest run` 全量:859 passed | 1 skipped(860 文件),10397 passed + 8 skipped,EXIT=0(首轮 3 红——globalDataIndex AUD-076 墙钟预算 254ms>200ms、categoryI18n、hotfixSpellingGate——solo 复跑全绿且全量复跑 EXIT=0,归因满载抖动族:全量首轮 load≈40,与本批触碰面无关)
- `xvfb-run -a npm run test:demo:editor`:25 passing,RC=0
