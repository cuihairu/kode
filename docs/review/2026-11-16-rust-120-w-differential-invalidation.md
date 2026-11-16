# RUST-120-W:变化分类差异化失效接生产(验收纪实)

日期:2026-11-16
任务行(todo.md):`RUST-120-W (生产接线/验收,2026-11-15 用户审计拆项) signature/body-only 等变化分类的差异化失效接生产(现指纹级零重建,细分随 CST 增量);验收口径=按变化类别差异化失效生产实测。`

## 结论

差异化失效全链接入生产,按变化类别实测分化成立:

| 变化类别 | index 层动作 | hover generation | 悬停视图 | health 记账 |
| --- | --- | --- | --- | --- |
| Identical(纯内容指纹命中) | 零重建零登记 | 不 bump | 保持旧事实(零写) | `ingestIdentical` |
| BodyOnly(模型逐类全等) | 零变异零 bump | 不 bump | 保持旧事实(零写) | `ingestBodyOnly` |
| Signature(模型不等/负缓存) | replace+重灌 | bump(读者失效) | 反映新事实 | `ingestSignature` |
| Removed | detach | — | — | `ingestRemoved` |

## 三层架构

1. **kode-index 层**(`ingest_classified`):签名事实(records + Parent + RefSet)全等 → BodyOnly,零变异零 bump;不等 → `replace_file_with_records` + Signature。unit 解析 None 时按负缓存 detach + 保守 Signature(refs_known = 旧 refs 在场或首次入库)。
2. **kode-server hover 层**(`HoverEngine::update → ChangeCategory`):Identical = 指纹命中早退零写;Def/Entities/Types/Alias 逐类 parse 后模型 `PartialEq` 相等 → BodyOnly 视图零写;不等 → 重灌 Signature。generation 只在 Signature 时 bump —— 语义 = 持有快照的读者闭包全存活。
3. **队列层**:`IngestCounts`(Rc<RefCell>)按类别计数 → `IndexQueueSnapshot` 4 键 → server.rs health `ingest.ingestIdentical / ingestBodyOnly / ingestSignature / ingestRemoved`(TS 侧 `tests/protocolContract.test.ts` 契约 12→16 键锁步)。

## 失效语义判据(诚实边界)

- **位置位移 = Signature,是正确失效语义而非漏判**:`DefFile` 含 `name_span: Span + line` 等已登记位置,前置插入使全部行锚位移 → 模型不等 → Signature,持行锚数据的读者(悬停/补全/跳转)必须重读。BodyOnly 的真实样本 = 尾注/等位替换(全部已登记位置不变)。
- **指纹 = 纯内容 FNV-1a**(bytes+len rotate,不含 version):同文本新版本 → registry cache hit → `rebuilt=false` → Identical。
- **py 文件不进本车道**:Rust 索引只收 def/entities/types/alias 语料;Python 文档的按版本缓存失效走既有 TS `flowVersionKey` 车道,不在本项口径内。
- **保守守卫是防御纵深**:unit None 负缓存臂在正常流(refscan 仅在重建时跑)不可达,零成本保留,不声称有生产触发路径。

## 验收实测

- **dispatch 层**(`crates/kode-server/tests/ingest_classification_dispatch.rs`):server 分派全链 didOpen→hover(signature=1,悬停 UINT32)→同文本 didChange(identical=1,signature 不变)→尾注(bodyOnly=1)→类型变更(signature=2,悬停 UINT16)。
- **TS E2E**(`tests/kodeCoreDifferentialInvalidation.test.ts`,真实二进制):同一序经生产 `mirrorDocument` 链,四记账键同分化;二进制缺失时跳过(与 kodeCoreServingE2E 同口径)。
- **单元层**:kode-index 分类测试 8 例、hover_units `update_classifies_identical_body_only_and_signature`(generation 判据+悬停视图)、index_queue 计数四类全链 + storm/take_buffered E2E 形状复刻。
- **golden 字节不变实证**:workspace cargo test 含 hover_golden / semantic_golden 字节比对全绿——分类接线不改变任何既有输出字节。
- **prove-red 三靶全红且 cp+cmp 字节还原**(分类门移除即全 Signature 化、计数不接线即 4 键恒 0、identical 指纹臂删除即重解析)。

## 坑账(复现与规避)

1. **didOpen JSON 形状**:`text` 必须在 `textDocument` **内部**(`DidOpenParams { textDocument: TextDocumentItem }`,kode-protocol camelCase)。dispatch 复刻测试初版把 `text` 放顶层 → serde "missing field `text`" → `handle_did_open` 的 `else { return }` **静默丢弃**。TS gate 层形状本来就正确,故只有手写 JSON 的测试踩中。教训:分派层 `let Ok(..) = .. else { return }` 是静默面,复刻协议形状时以 DTO 定义为准。
2. **E2E 版本账打架**:`serveHoverFromRust` 腿自带 `mirrorDocument(document.version)`;测试传入的 version 必须与 gate ledger 同步,否则走 close+open 回退多出一次 Signature 记账。
3. **风暴窗 300ms**:didChange 的执行时刻不与请求同步(请求入口 drain 才执行),E2E 须 waitFor 轮询 health;health 查询本身不驱动 pump。
4. **陈旧二进制假红**:`target/debug/kode-server` 早于源码改动时,E2E 测的是旧逻辑;跑 E2E 前先 `cargo build -p kode-server --bin kode-server`。
5. **BodyOnly 样本必须尾注**:前置注释/插入会位移全部已登记行锚,正确判类是 Signature;尾注(位置全不变)才是 BodyOnly 真实样本。
6. **census 对账**:新增 `ChangeCategory::as_str` 使 index.rs pub fn 集合漂移,`docs/review/2026-10-29-r2-index-inventory.md` census 行同笔追加(文档锁步纪律)。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- `cargo test -p kode-index -p kode-server`(含 workspace golden 字节比对):全绿,0 failed
- `pnpm lint`:0;`tsc --noEmit`:0
- vitest 全量 + xvfb demo:见下节(执行记录)

## 执行记录

- vitest 全量:843 文件 passed + 1 skipped,10333 tests passed + 8 skipped,exit 0
- xvfb-run -a npm run test:demo:editor:25 passing,Exit code 0
