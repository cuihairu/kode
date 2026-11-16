# Windows nightly 三+一红修复:canonical 路径磁盘回落 + cancel span 竞态

日期:2026-11-16
来源:nightly run 43803929509(b472875b)win32-x64/win32-arm64 verify 腿红;
自 43706311233(2026-11-15 10:54)起 nightly 连续红。CI/CD(main gate)同
commit 全绿——Windows 特有。本批零 todo 条目,验收记本文档。

## 红三例:canonical `/C:/...` 路径喂 std::fs(确定性)

**症状**(win32-x64 + win32-arm64 同位):
- `index_queue::tests::ingest_refresh_task_replays_time_of_execution_truth`
  (:608「盘上 def 文件应入索引」symbol_count==0)
- `index_queue::tests::ingest_counters_classify_identical_body_only_signature_removed`
  (:650 ingest_signature 0≠1)
- `index_queue::tests::did_change_same_text_via_storm_take_buffered_classifies_identical`
  (:705 ingest_signature 0≠1)

**根因**:`CanonicalUri::from_path` 把 Windows 盘符路径规范成 `/C:/...` 形态
(设计如此,file URI 身份口径),而 `ingest_refresh_task` 磁盘回落臂直接
`std::fs::read_to_string(key.uri.as_path())`——`/C:/...` 在 Windows 上非有
效路径(std 按当前盘根解析 `/C:/...` → ENOENT),读盘恒败 → 全走 removed
逐出臂。三例共享同一首开读盘摄取面,全数命中。Linux 上 `/C:/...` 恰好是
合法绝对路径形态,测试恒绿=平台盲区。

**生产影响**:Windows 生产上「关闭文档回落磁盘」刷新同走此臂——关闭态 def
语料在 Windows 恒被逐出(补全/悬停语料缺失),非纯测试问题。

**修复**:
1. `kode-vfs/src/uri.rs` 新增 `to_native_path()`(磁盘 IO 专用;身份/展示面
   禁用同 VFS-002 禁则):canonical `/C:/...` → 原生 `C:/...`(std 兼容正斜杠
   分隔符),POSIX 形态原样;与 from_path 盘符归一互逆。+2 单测(posix 恒等/
   盘符前缀剥离含小写盘符 file URI 直传形态);
2. `kode-server/src/index_queue.rs` 磁盘回落臂改 `read_to_string(key.uri
   .to_native_path())`(生产面唯一一处 canonical path 直喂 std::fs 的点,
   全仓 grep 核实其余磁盘读皆原生 PathBuf)。

**prove-red**:to_native_path 摘盘符剥离臂(恒等变异)→ uri 单测
to_native_path_strips_windows_drive_prefix 红;还原绿(20 passed)。注:
Linux 无法直接复现 Windows 路径形态红——三例 CI 测试本身即下轮 nightly 的
真验收(诚实体感:本批推后 nightly win 腿应绿)。

## 红一例:cancel() 在途丢弃路径偷走 span(竞态,arm64 先炸)

**症状**(win32-arm64):
`executor::tests::span_table_tracks_outstanding_jobs_and_drains_on_terminal`
(:863「702 取消回执带 span」expect None)。

**根因**:`cancel()` 对在途丢弃也无条件 `state.spans.remove(id)`——排队摘除
窗(取消时 job 还在队)与 worker 弹出窗(popped-but-未登记令牌)竞态:worker
先弹出时,cancel 走在途路径仍把 span 从表摘走 → worker 结算段
`spans.remove` 捞空 → 终态回执 `span=None` → 用例 expect 红。排队摘除窗
内行为正确(span 随摘除回执携带);竞窗在慢 runner(arm64 Windows)更宽,
Linux 纯属时机未炸=全平台潜在竞态。

**修复**:span 回捞两态——`removed.is_some()`(排队摘除=终态即本回执)随表
摘除随回执携带;否则(在途丢弃)只读 `get(id).cloned()` 供取消留痕,span
留表等 worker 终态结算携带。

**回归钉**:`inflight_cancel_terminal_outcome_carries_span`(确定性:起跑后
再取消,不走排队竞窗)——在途取消 span 留表==1;release 后终态回执
Cancelled 带 `span-0349`;终态后表排空==0。prove-red:cancel 变异回无条件
摘表 → 回归钉红(outstanding 0≠1);还原绿。

**测试设计坑(本批踩)**:初版回归钉用票号 801,与既有 cancellable 用例
(:1144 `wait_started(801)`)撞号——hold() 登记表是**全池共享 static**,
票号重叠让 wait_started 被他人登记误触发(cancel 时本测试 job 仍在队=
走了排队语义,断言全乱)。改独立票段 841 后 5×21 连跑稳定绿。前车之鉴:
executor 测试加用例必须先 grep 全文件票号,「互不重叠 ticket 段」约定
(hold() doc 注释)是并行安全的硬前提。

## 门禁

cargo clippy --workspace --all-targets -D warnings = 0;cargo test --workspace
RC=0(167 suites ok);pnpm lint 0;pnpm compile 0;vitest 全量 10348 + 8
skipped RC=0;xvfb-run -a npm run test:demo:editor RC=0(kode-server 二进制
重编后 E2E 同跑绿)。

## 诚实边界

- 三例 Windows 红的最终验收 = 推后 nightly 的 win32-x64/arm64 腿转绿
  (本地 Linux 只能证「变异红/还原绿」+ 纯函数面);
- `to_native_path` 只服务磁盘 IO 面;身份/展示面(to_uri_string/basename/
  as_path)口径零变化;
- cancel() 修复不改变排队摘除语义(回执携带 span 原行为保留);在途丢弃的
  取消留痕日志照旧带 span(get 克隆);重复取消同 id 在 span 表终态摘除前
  仍可读到 span,摘除后日志落 `-`(既有语义);
- nightly 的 linux-x64 腿 43706311233 一度红属另一批次时点问题,本批未触
  (当前 main CI/CD 全绿)。
