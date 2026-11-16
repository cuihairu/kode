# RUST-131-W 生产文件事件(rename/delete)接线验收

日期:2026-11-16
任务行(todo.md:408):`RUST-131-W (生产接线/验收) [P1] 将 rename/delete/跨根移动清理接入生产文件事件,统一撤销符号、引用、diagnostics、解析缓存和生成源映射,禁止晚到旧任务复活;RUST-095 同面以本项验收,避免两份状态。`

## 结论

Rust 服务轨道接入 LSP `workspace/didDeleteFiles` / `workspace/didRenameFiles`
生产文件事件:旧 URI 全链撤销(晚到旧任务复活禁令),rename 新 URI 经执行
时刻真相重放回读;TS gate/wiring 发帧面 + 真二进制 E2E 契约面全链钉死。

## 撤销面逐项对账(todo 行五面)

| 面 | 处置 | 落点 |
|---|---|---|
| 符号 | `HoverEngine::remove` → `SymbolIndex::remove`(detach_file + 倒排/继承边) | hover.rs:469 / index.rs:300 |
| 引用 | 解析注册表反向依赖随键撤销(`ParseRegistry::invalidate`:forward.remove + reverse 逐名摘除) | dep.rs:304(经 index.remove 连带,无独立调用点) |
| 解析缓存 | 同上 `registry.invalidate` 内 `cache.invalidate(key)` | dep.rs:316(连带) |
| diagnostics | pull 形态:`textDocument/diagnostic` 对已逐出键 open_buffer=None → 空 items(既有形状,无独立撤销面需要建) | server.rs handle_diagnostic |
| 生成源映射 | **本轨无独立存储面 = 诚实 N/A**(Rust 轨未接入生成源映射;不预造) | 侦察确认,登记边界 |

另两面对账:store overlay+盘缓存(`DocumentStore::remove`,VFS-012 既有);
队列待执行刷新 + 风暴缓冲(新 `IndexQueue::purge_key`,purge_root 单文件版)。

## 设计

- **evict_uri 全链**(delete 主干,rename 旧侧共用):不可解析/根外 URI 诚实
  跳过(`session.key_for` 拒绝 UNROOTED 铸键)→ `purge_key(identity)` →
  `store.remove` → `hover.remove`。同步序执行,泵不可能穿插;复活唯一通道
  是残留待执行任务——已全部摘除。
- **rename = 逐旧 + `request_close(new)`**:执行时刻真相重放(overlay 优先
  回落磁盘,读盘失败 = 逐出)——didOpen(new) 先到则未保存修订胜出,后到则
  自身入队兜底,未打开则回读盘上新文件;跨根移动新旧各归其根
  (key_for 按 URI 前缀各发其根)。复用 VFS-012/didClose 既有语义,零新状态。
- **TS 发帧面**:`gate.notifyWorkspaceFileEvent(method, params)`(口径同
  notifyFileChanged:只有已存活 client 才发,不拉进程,静默降级);
  wiring 挂 `onDidRenameFiles`/`onDidDeleteFiles`(LSP 形状直传);
  delete 载荷双形并读(`files ?? uris`,processOwnership 同口径——fake 桩
  delete 臂历史形状 uris)。
- **不加新 health 键**:ingest 键集被 protocolContract/
  ingest_classification_dispatch/kodeCoreDifferentialInvalidation 三处钉死;
  purge 记账复用既有 `ingest.purged`(purge_root 同计数器)。

## 测试(13 例)

- **Rust 分派层 7 例**(tests/workspace_file_events_dispatch.rs,进程内
  ServerState + 真盘文件):
  - `delete_before_pump_blocks_late_task_resurrection`——防复活靶:didOpen
    待执行任务在泵前被删除事件摘除,请求入口 freshen/泵后符号恒空;
  - `delete_unopened_disk_file_evicts_resident_symbols`——未打开依赖
    (close 后盘上驻留语料)真删盘 + 事件后旧 URI 无符号/无 overlay;
  - `rename_on_disk_moves_symbols_to_new_uri`——真盘移动,旧侧撤销 +
    新 URI 回读盘;
  - `rename_open_document_overlay_follows_to_new_uri`——打开缓冲区移动
    (didOpen new 后到,overlay 未保存修订胜出);
  - `rename_across_roots_moves_symbols_between_roots`——跨根移动各归其根;
  - `delete_skips_unparseable_and_out_of_root_uris`——坏/根外 URI 跳过
    不误伤他文件;
  - `delete_purges_storm_buffered_change_for_same_identity`——风暴缓冲
    同身份事件一并摘除,移交路径不复活。
- **gate 单测 3 例**(kodeCoreGate.test.ts):发帧形状/未启动静默 false
  不拉进程/通知口抛错收口。
- **wiring 装配 1 例**(kodeCoreGateWiring.test.ts):ts 回落零开销点火
  不炸 + dispose 链撤干净。
- **真二进制 E2E 2 例**(workspaceFileEventsE2e.test.ts,真盘 + spawn
  kode-server):delete 后旧 URI hover 无结果 + `ingest.purged` 记账
  (经 didChange 风暴缓冲使 purge 可观测);rename 旧侧撤销独立于新侧
  入库 + 新 URI didOpen 后有结果(mock-vs-wire 契约面:notify 帧形状
  对线上契约)。

## prove-red(三靶,均 cp 备份+变异+cmp 字节还原)

1. 摘 `evict_uri` 的 `purge_key` 调用 → **恰 2 例红**(泵前删除防复活 +
   风暴缓冲摘除),其余 5 例绿——purge 面被钉死为复活禁令的唯一执行点;
2. 摘 `hover.remove` 调用 → **5 例红**(全部逐出依赖靶);
3. 摘 rename 的 `request_close(new)` → **恰 2 例红**(disk 回读两靶)而
   overlay-follows 靶仍绿——didOpen(new) 路径与 request_close 路径互不
   掩护,判别面正确。

## 诚实边界

- **事件顺序契约**:VS Code 对重命名的 didRenameFiles/didClose(old)/
  didOpen(new) 发送序无保证——执行时刻真相设计覆盖全序(逐旧先清,
  new 侧 overlay/盘/缺失三态由重放裁决);didClose(old) 若晚到,其
  刷新任务对已逐出键重放 = 读盘失败 → remove no-op,无复活通道。
- **RUST-082/RUST-079-W 前置注记**:两者仍开(082 余面 = 未打开依赖的
  磁盘 create/change 镜像接线;079-W = 快照代际旧响应丢弃)。本项满足
  082 验收里「删除/重命名不留陈旧条目」切片;create/change 切片不在本项。
- **引用/解析缓存的撤销不是新代码**:随 `SymbolIndex::remove` 既有连带
  (RUST-131 库层已收口),本项接线使其在生产事件上生效。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- `cargo test -p kode-vfs -p kode-index -p kode-parser -p kode-server`:
  RC=0,86 目标 1310 过 0 红
- `pnpm lint`:0;`pnpm compile`(tsc):0
- vitest 全量:844 文件 10340 过 + 8 skip,RC=0
- `xvfb-run -a npm run test:demo:editor`:25 passing,RC=0
