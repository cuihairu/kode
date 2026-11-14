# RUST-026 审计+补齐:宿主事件循环延迟、Core CPU/内存/线程/磁盘 IO 监测

日期:2026-11-15。审计对象:todo.md RUST-026(旧 PERF-009)。**结论:宿主两维现役在案;Core 侧 CPU/内存/线程/磁盘 IO 原为零,本批经 health 报文补齐(Linux /proc,非 Linux 诚实 None)。**

## 维度 → 采集面

| 维度 | 采集面 | 位置 |
|---|---|---|
| 宿主事件循环延迟 | IDE-MET-005:宿主事件循环延迟自激活即采样,metrics channel showSummary 面可读 | src/loggingWiring.ts(IDE-MET-005/006 采样注记) |
| 宿主 CPU/内存 | IDE-MET-006:宿主 CPU/RSS 自激活即采样 | 同上 |
| Core 内存/线程/磁盘 IO/CPU(本批新增) | `$/kode/health` 报文新增 `resources`:CoreResources{rssBytes, threads, diskReadBytes, diskWriteBytes, cpuTimeMs}——Linux 读 /proc/self/status(VmRSS/Threads)+/proc/self/io(read_bytes/write_bytes,只计真实存储 IO,不含页缓存)+/proc/self/stat(utime+stime,CLK_TCK=100 标准假设);**非 Linux 或 /proc 不可读 = null 诚实降级,绝不伪造零值** | kode-protocol/src/lib.rs(CoreResources)+kode-server/src/server.rs(read_core_resources) |

## 观测语义注记(实现中两次实测修正)

- `/proc/self/io` 的 read_bytes 只计 read() 类系统调用:二进制经 mmap 载入不经 read(),年轻进程读/写计数可为 0——**0 是合法读数不是缺数**,测试只断在场与正值字段(RSS>0、threads≥1),IO/CPU 计数不断数值;
- cpu_time_ms=0 同理:CPU 不足 1 tick(10ms)的年轻进程合法为 0;速率由调用方两次采样差分。

## 采样方式

- 健康快照(拉模式):`client.health()` 即取 Core 资源快照;TS 类型 KodeCoreHealth.resources 已扩展;
- CPU 速率与 IO 增量:调用方按差分派生(协议只给累计值,不假装有速率);
- 阈值告警/自动重启联动属 RUST-027/028 范围,不在本条。

## 门禁

- Rust:cargo test -p kode-server --lib 430 绿(含 core_resources_reads_proc_fields 新钉)/clippy -p kode-protocol -p kode-server -D warnings 0;
- TS:lint 0/tsc 0/e2e 7 例(真二进制断言 resources 在场+RSS 正值)/kodeCoreClient 15 例;
- prove-red:health_report 临时 resources:None → e2e 红(1 failed)→ cp/cmp 还原+重编 → 7/7 绿。
