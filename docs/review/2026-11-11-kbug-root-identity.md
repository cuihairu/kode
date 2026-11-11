# KBUG-ROOT 多工程根同名实体隔离 —— 修复纪实(2026-11-11)

账本:`todo.md` KBUG-ROOT 组(审计基线 `10f4b85e`)。缺陷 = 实体名 → def
路径登记是**全局首见单射**(`HoverEngine.def_by_name: BTreeMap<String,
String>`),跨工程根(多 workspace folder / 根外文档)同名实体互相借路径:
A 根先入库 `Avatar.def` 后,B 根 entities.xml 上 F12/hover/补全全部指向
A 根文件。

## 缺陷定位(修前)

- `crates/kode-server/src/hover.rs:387`:`update()` 首见登记
  `def_by_name.entry(name).or_insert(path)`;
- `crates/kode-server/src/definition.rs:185`:entities 臂无根限定查询
  `def_by_name.get(word)?` → 首见落点;
- `crates/kode-server/src/hover.rs:562`:hover 实体臂同图查询(defFile/
  defExists 跨根借用);
- `crates/kode-server/src/completion.rs:348`:实体条目全图遍历(他根实体
  冒进本根补全);
- 对拍 golden 生成器(definition/hover/completion 三 dump)统一按
  `RootId::UNROOTED` 入库,把四个独立 fixture 项目混成一个隐式根 ——
  旧 golden 里可见跨工程借用实录(parity-project 的 Avatar 落
  kbengine-demo-assets 路径);
- 生产装配面:TS 端 `KodeCoreClient` 默认 initialize 参数**不带
  rootUri/workspaceFolders**,Rust 侧所有文档落 UNROOTED —— 根隔离即使
  Rust 支持也从未生效。

## 修复

1. **引擎(KBUG-ROOT-02/03/04/05)**:`def_by_name` 改
   `BTreeMap<(RootId, String), Vec<String>>`(根 × 实体名 → 入库序去重候选):
   - `update()`:按 `key.root` 推入候选(`or_default` + `contains` 去重);
   - `remove()`:逐候选组剔除被关路径,空组落盘(关 B 根只清 B 根候选,
     A 根候选不动;重开重建);
   - 新查询口 `def_candidates(root, name)`;hover 实体臂 = 根内首候选
     (信息面,defExists = 候选非空);definition 实体臂 = **唯一候选才
     落点**,同根同名多候选歧义 → null(TS 面兜底,不硬猜首见);
   - `completion::push_entity_items` 只遍历查询方根(条目 detail = 根内
     首候选);`<Parent>` 取值面同样定域。
2. **对拍 golden(KBUG-ROOT-01)**:新 `golden_corpus.rs` 把
   `PARITY_CORPORA` 四个语料工程各注册为独立资源根,三 dump 生成器入库/
   查询键 = 各自工程根(复刻生产多工作区语义)。重生成后 54→54 落点全保,
   4 处跨工程借路径修正为各自工程路径(kbengine-demo-assets/kbengine-tpl-
   scripts 的 Account、parity-project 的 Avatar/Monster)。
3. **生产装配(KBUG-ROOT-06)**:
   - `kode-protocol::InitializeParams` 增 `workspace_folders`
     (LSP `workspaceFolders`,camelCase);`server.rs` initialize 逐个
     注册为资源根;
   - `KodeCoreInitializeParams` 增 `workspaceFolders`;
     `KodeCoreGate.setInitializeParams()` 注入握手参数(此后每个客户端
     实例握手即携带,含自动重启重建);`kodeCoreGateWiring.ts` 在首次
     ensureClient 前把 `vscode.workspace.workspaceFolders` 映射传入;
   - 替身服务器 initialize 回显 `receivedWorkspaceFolders`,客户端侧
     单测钉「参数真的上路」(`tests/kodeCoreClient.test.ts` KBUG-ROOT 例)。
4. **TS 对拍面(KBUG-ROOT-01)**:三个 parity 复算
   (kodeDefinitionParity/kodeHoverParity/kodeCompletionParity)语料视图
   同步根域化:`corpusRootOf(file)` = CORPORA 前缀归属;候选按
   根 × 实体名入库序;definition 唯一候选才落点、hover 报根内首候选、
   completion 按根列条目 —— 与 Rust 引擎同口径复算 golden(3 套件 11/11 绿)。

## prove-red 与回归

- 新套件 `crates/kode-server/tests/root_scope_dispatch.rs`(真实
  ServerState + handle_message,LSP 级):
  - **修前红 7/7**:跨根落点(A 先入库 → B 根查询落 A 路径)、入库顺序
    决定落点、根外文档借已注册根、hover 报他根首见、关闭后 B 根借 A 根
    路径(F12 返回 A)、同根同名歧义硬猜首见、补全冒他根实体;
  - **修后绿 8/8**(含 workspaceFolders 注册面例:只带 workspaceFolders
    的 initialize 两根同名各落各根;该例对 server.rs 注册回路单独
    prove-red —— stash 掉注册回路 1 failed,恢复 8/8)。
- golden 重生成比对:definition 54→54,仅 4 处跨工程借用修正(方向均为
  「他根首见 → 本根路径」);hover/completion golden 同步重生成,三个
  Rust golden 套件 + units 全绿。
- TS:parity 3 套件 11/11;kodeCoreClient 13/13(新增握手上行例)。

## 门禁

- Rust:`cargo clippy -p kode-protocol -p kode-server -p kode-python
  --all-targets -- -D warnings` 0;`cargo test` 三 crate 56 个二进制全 ok。
- TS:`npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
  `npm run test:unit` 8682 过,3 例满载抖动单跑全绿
  (typeStorageColdBuildPhased F13 / hoverDeadlineContext 剩余 15ms 时钟
  判定 / kodeCoreInteractiveBudget TIME-04 —— TIME-04 属本战役 TIME 批
  自有测试的竞态窗:cancel 探测(100ms+50ms 轮询)可被 delayRpc=0 快速
  响应先结算,已改 delayRpc=1000 定死取消先手,套件单跑 6/6、全量复跑
  不再红);`xvfb-run -a npm run test:demo:editor` 25 RC=0。
- **非本批红(已定性)**:`selfAttributeFlowRustParity` fixture 全量例
  在 `KodeHotReload.py@199` Rust `types:['list']` vs TS `[]` —— 用
  **干净 HEAD 构建的 kode-server**(stash 本批全部代码改动后重建)复跑
  同样红,系并发会话 f1ad8318(hot-reload)提交的 fixture 引入的
  主线既有对拍红,与本批无关,待 hot-reload 车道收口。

## 命令

- prove-red/绿:`cargo test -p kode-server --test root_scope_dispatch`
- golden 重生成:
  `cargo run -p kode-server --bin dump-definition-golden -- . >
  crates/kode-server/tests/golden/definition-parity.json`(hover/completion
  同式)
- parity:`npx vitest run tests/kode{Definition,Hover,Completion}Parity.test.ts`
- 干净 HEAD 定性:`git stash push -- <本批码文件> && cargo build -p
  kode-server && npx vitest run tests/selfAttributeFlowRustParity.test.ts`
  (同红)→ `git stash pop`
