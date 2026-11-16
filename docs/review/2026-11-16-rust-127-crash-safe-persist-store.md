# RUST-127:缓存崩溃安全写入 + 损坏可清理重建(验收纪实)

日期:2026-11-16
任务行(todo.md):`RUST-127 (旧 IDX-010) 缓存崩溃写入用临时文件+原子 rename/WAL 等,损坏可清理重建。`

## 结论

kode-vfs 新模块 `persist_store.rs`(`PersistStore`):解析产物落盘缓存的
崩溃安全存储协议,消费 RUST-126 `persist_cache_key` 契约(key→payload
字节存储,身份以盘为准)。

- **临时文件 + 原子 rename**(RUST-127 行主句):写入永远先落
  `{dir}/tmp-{keyhex}-{pid}-{nanos}.tmp`,`write_all` + `sync_all`(fsync)
  到盘后 `rename` 到 `{dir}/{keyhex}.bin`。同卷 rename 原子(POSIX/Windows
  同卷语义),读者看到的条目要么旧要么新,永无半态;rename 后追加目录
  fsync(best-effort,平台不支持不致命)。
- **帧格式** `[KODEPS01][payload_len u64 LE][payload][指纹 u64 LE]`:魔数+
  版本给格式身份(旧格式/外杂质 → 损坏),尾指纹复用
  `content_fingerprint_bytes`(内容+长度混合,与 kode-vfs 既有
  `content_fingerprint` 同算法;str 版改为委托,字节面新增,payload 任意
  字节非 UTF-8)。
- **损坏可清理重建**:读侧命中坏帧(过短/魔数错/长度不符/指纹不符)=
  立即删除该条目 + 按未命中 `Ok(None)` 返回——坏字节永不出库,调用方按
  miss 重建,零正确性损失。写侧任何一步失败都尽力清 temp(半途失败不留
  毒 tmp)后原样上抛。
- **孤儿 tmp 清扫**:`open` 即扫 `tmp-*` 前缀文件(rename 前崩溃的残留),
  只动本店命名形态,外来文件(notes.txt 等)不误伤;`clear` 同口径,返回
  删除的本店条目数。
- `remove` 幂等(NotFound 视为已删);`write` 兜底 `create_dir_all`(open
  后目录被外部删不杀死后续写)。

## 诚实边界

- **WAL 不做**:单条目 rename 原子已给全有或全无;WAL 解决多条目事务
  语义,本面无此需求,RUST-128 格式基准(SQLite/redb/自定义二进制)按需
  回看——「等」字面的技术选型按需取用,不预造。
- **原子性是文件系统语义**:进程内测试钉的是协议形状(tmp 用后即清、
  损坏帧必清理且永不被服务、孤儿 tmp 开库即扫、外来文件不动),真掉电/
  kill 注入不在单测射程。
- **payload 为不透明字节**:解析产物序列化格式、压缩、整库索引形态属
  RUST-128 基准面(cold start/读写放大/文件数);本面不锁 payload 内容,
  也不预造 server 侧接线(无消费者的装配层不做)。
- key 因子来源接线仍随真实持久化消费面(RUST-126 既定口径),本面只存
  已算好的 `PersistCacheKey`。

## 验收实测

- **9 例单测**(persist_store.rs 内):
  `write_then_read_roundtrip_with_clean_layout`(roundtrip + 恰好一个
  `{hex}.bin` + 写后无残留 tmp)、`overwrite_same_key_replaces_content_
  atomically`(覆盖不堆积)、`missing_entry_reads_none_not_error`、
  `empty_payload_roundtrips`、`corrupted_payload_byte_is_cleaned_and_
  reads_miss`(保长翻字节→指纹不过→miss+清理+重建复绿)、
  `truncated_frame_is_cleaned_and_reads_miss`、`foreign_magic_frame_is_
  cleaned_and_reads_miss`、`open_sweeps_orphan_tmp_but_keeps_foreign_
  files`、`remove_is_idempotent_and_clear_keeps_foreign_files`(clear 只
  计本店条目,外来文件留)。
- **prove-red 三靶全红且 cp+cmp 字节还原**:
  ①摘 `read` 损坏清理面(直接返 miss 不删文件)→ 3 例红(坏条目留在
  库内);②摘 `decode_frame` 指纹校验 → 坏字节帧被当有效服务,1 例红;
  ③摘 `open` 的 `sweep_tmp_files` → 孤儿 tmp 残留,1 例红。

## 坑账

1. **clippy collapsible_if**:`clear` 内「本店形态 → 删除成功且是条目才
   计数」双层 if 折叠——`||`/`&&` 混合须显式括号保语义(is_tmp 短路后
   `is_entry` 兜底不计),两次变异才折干净。
2. **let-else 暂存值生命周期**:`entry.file_name().to_str()` 直接 let-else
   E0716(OsString 临时值在语句尾释放)——先绑 `let file_name = ...` 再
   `to_str()`。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- cargo test(kode-vfs/parser/index/server):CARGO-RC=0,85 个 test 目标
  全 ok,0 failed(首轮退出码 101 为负载抖动假红,grep 未捕到失败面,
  落盘日志复跑净——管道真退出码纪律)
- `pnpm lint`:0;`tsc --noEmit`:0(纯 Rust 批,TS 面零变化,门禁照跑)
- vitest 全量 + xvfb demo:见执行记录

## 执行记录

- vitest 全量:843 文件 passed + 1 skipped,10334 tests passed + 8 skipped,
  exit 0(首轮 RC=1 无失败面输出,tail 截断吞细节;落盘日志全量复跑净 =
  负载抖动假红,管道细节禁 tail 单行纪律再验)
- xvfb-run -a npm run test:demo:editor:25 passing,Exit code 0
