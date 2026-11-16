# 持久化格式候选基准(RUST-128)

日期:2026-11-16
任务行(todo.md):`RUST-128 (旧 IDX-011) 持久化格式候选 SQLite/redb/自定义二进制;先做 cold start、读写放大、文件数基准。`

## 结论(选型裁定)

**解析产物持久化主向 = 自定义二进制 packed-log 单文件**(PersistStore 的
家族内演进形态,生产接线随后续任务点火);SQLite 作二档候选保留记录;
redb 实测出局。

判据(5000×32KiB,贴 RUST-129 实测 def 语料形态 ~34KB/文件):

| 维度 | persist-store(现状) | packed-log(主向) | sqlite-relaxed | redb |
|---|---|---|---|---|
| 写全量 5k×32K | 11277ms(每写 fsync) | **454ms**(批量 fsync) | 247ms | 7102ms |
| 冷读全量 | 374ms | 299ms | **92ms** | 331ms |
| 随机读 P50 | 63µs | 55µs | 20µs | **6µs** |
| 空间放大 | **1.00** | **1.00** | 1.02 | 3.29(出局主因) |
| 写放大 | 1.12 | **1.00** | 1.02 | 2.62 |
| 文件数 | 5000(出局主因) | **1** | 1 | 1 |
| 依赖 | 零 | 零 | rusqlite(bundled C) | redb(纯 Rust) |

- **per-write fsync 是写墙钟的主宰**:同批数据 persist-store 11.3s vs
  packed-log 0.45s(25×)——差价全在每条目 fsync+rename+目录 fsync;
  缓存语义(miss=重建,崩溃只丢缓存不丢正确性)不该付每写 fsync 的税。
- **文件数是结构性优劣**:file-per-entry 5k 条目 = 5000 inode,Windows
  AV/备份/同步工具放大真机成本;真冷盘(重启后)5k 次开文件+stat 亦劣于
  单文件顺序读(无 root 未实测,判据为推理,诚实登记)。
- **redb 空间放大 2.1-3.3×** 且耐久写无优势,三轴皆无胜面,出局。
- **sqlite 是合格二档**:随机读最强(6-20µs)、单文件、空间 1.02-1.07;
  relaxed(每条目 fsync 关闭)已够缓存语义。若后续出现查询/事务需求
  (如跨代际增量失效索引)可回选;代价是 bundled C 构建依赖进编译链。
- **packed-log 的崩溃面**:批量 fsync 窗口内崩溃丢尾部条目,开库按记录
  校验和截断撕裂尾(截到最后一好记录),活下来的前缀仍完整可用——
  条目级原子性换批量写吞吐,RUST-127 单条目原子性语义严格性让位,
  miss 重建兜底正确性(登记为有意取舍,非遗漏)。

## 方法

- 基准面:`cargo run -p kode-vfs --release --example persist_format_bench
  -- --base-dir /var/tmp/kode-persist-bench`(dev-dep:rusqlite 0.41 bundled
  与 kode-mcp 同版、redb 2.6.4;不进生产 lib 依赖)。
- 五候选:persist-store(生产面 RUST-127 协议)/ sqlite-durable(WAL+
  synchronous=FULL,每条目独立事务)/ sqlite-relaxed(journal OFF+
  synchronous OFF)/ redb(默认耐久,每 commit fsync)/ packed-log(自定义
  `[key16][len4][payload][checksum8]` 追加日志,批量 fsync,开库全扫建索引,
  撕裂尾截断)。
- 指标:写全量墙钟/冷读全量墙钟/随机读 1000 采样 P50·P95/空间放大(落盘
  字节÷payload)/写放大(/proc/self/io write_bytes 增量÷payload)/文件数。
- payload = LCG 非零字节(零页去压失真);key 走 RUST-126
  `persist_cache_key` 真契约;正确性闸 = 冷读逐条目字节全等断言 +
  packed 随机读校验和断言,任一不齐即 panic(本轮四场景×五候选全过)。
- **诚实边界**:
  - 冷读为页缓存暖口径(非 root 无 drop_caches)。LSP 重启场景 OS 缓存
    大概率仍热(上会话刚写),对主场景有代表性;真冷盘数字需 root 补测。
  - /tmp 为 tmpfs(write_bytes 恒 0),写放大只在盘载口径(/var/tmp,
    ext4)可测;tmpfs 表仅作 CPU/内存下限附录。
  - clippy 终清理(hex 分组/去 return)非行为变更,两轮跑数与终构建一致。

## 盘载口径(ext4,/var/tmp;主表)

```
=== 场景:1000 条目 × 8 KiB/条 ===
| 候选            |    写全量ms | 冷读全量ms | 随机P50us | 随机P95us | 空间放大 | 写放大 | 文件数 |
| persist-store   |    2192.0 |      19.9 |     15.0 |     33.2 |      1.00 |   1.50 |    1000 |
| sqlite-durable  |    1162.5 |      10.5 |      7.2 |     11.7 |      1.07 |   4.17 |       1 |
| sqlite-relaxed  |      37.0 |       5.9 |     10.2 |     19.0 |      1.07 |   1.07 |       1 |
| redb            |    1478.5 |       9.7 |      2.4 |      3.0 |      2.12 |   4.46 |       1 |
| packed-log      |      23.6 |      14.8 |     14.5 |     31.4 |      1.00 |   1.00 |       1 |

=== 场景:5000 条目 × 8 KiB/条 ===
| persist-store   |   10904.6 |     455.4 |     17.4 |     35.8 |      1.00 |   1.50 |    5000 |
| sqlite-durable  |    5389.1 |      44.9 |      8.0 |     15.4 |      1.07 |   4.26 |       1 |
| sqlite-relaxed  |     127.2 |      24.9 |      7.9 |     24.0 |      1.07 |   1.07 |       1 |
| redb            |    6335.8 |      90.5 |      3.3 |      4.4 |      3.30 |   4.50 |       1 |
| packed-log      |     117.6 |      83.4 |     14.7 |     27.3 |      1.00 |   1.00 |       1 |

=== 场景:1000 条目 × 32 KiB/条 ===
| persist-store   |    2358.7 |      64.3 |     58.8 |     96.6 |      1.00 |   1.12 |    1000 |
| sqlite-durable  |    1240.8 |      16.2 |     14.9 |     31.7 |      1.02 |   2.55 |       1 |
| sqlite-relaxed  |      46.1 |      16.6 |     19.5 |     33.4 |      1.02 |   1.02 |       1 |
| redb            |    1314.8 |      37.6 |      7.5 |     10.8 |      2.07 |   2.61 |       1 |
| packed-log      |      89.6 |      61.2 |     54.8 |     75.5 |      1.00 |   1.00 |       1 |

=== 场景:5000 条目 × 32 KiB/条 ===
| persist-store   |   11277.1 |     373.7 |     62.6 |     87.9 |      1.00 |   1.12 |    5000 |
| sqlite-durable  |    6173.2 |     149.1 |     15.9 |     28.6 |      1.02 |   2.59 |       1 |
| sqlite-relaxed  |     246.6 |      92.2 |     20.2 |     37.7 |      1.02 |   1.02 |       1 |
| redb            |    7101.6 |     330.9 |      6.1 |     15.4 |      3.29 |   2.62 |       1 |
| packed-log      |     454.1 |     299.0 |     55.0 |     75.9 |      1.00 |   1.00 |       1 |
```

## 附录:tmpfs 口径(CPU/内存下限;write_bytes 不上块层恒 0)

```
=== 场景:5000 条目 × 32 KiB/条 ===
| persist-store   |     451.6 |     317.6 |     62.4 |     97.5 |      1.00 |   0.00 |    5000 |
| sqlite-durable  |     319.6 |     131.2 |     18.0 |     37.5 |      1.02 |   0.00 |       1 |
| sqlite-relaxed  |     228.4 |      86.2 |     19.2 |     41.7 |      1.02 |   0.00 |       1 |
| redb            |     591.1 |     268.4 |      7.0 |      9.6 |      3.29 |   0.00 |       1 |
| packed-log      |     291.2 |     311.9 |     56.7 |     80.1 |      1.00 |   0.00 |       1 |
```

(其余三场景 tmpfs 数值与盘载同构:耐久写差价收窄到 fsync-free 的
CPU 开销,冷读/随机读同量级;完整输出在执行记录。)

## 坑账

1. **tmpfs 上测写放大恒 0**:`/proc/self/io write_bytes` 计块层下盘,
   tmpfs 无块层——首轮全 0 的「写放大 0.00」不是省 IO 是测不到;
   盘载口径必须 `--base-dir` 指向真实磁盘路径。
2. **packed 冷读首版走了随机路径**(逐键 fd try_clone+seek 读):493ms
   假信号;生产冷启动 = 开库顺序扫收(单遍收集进内存缓存),改为
   `open_with(collect)` 单遍形态后 299ms——基准实现必须贴生产形态,
   不然测的是实现错误不是格式。
3. **rusqlite `prepare_cached` 0.41 无此方法**(API 面变化),prepare
   提升循环外即可;redb 2.6 `iter` 需 `ReadableTable` trait 在作用域。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- `cargo test -p kode-vfs`:87+6+8 全绿(dev-deps 编译链通过)
- 基准四场景×五候选正确性闸全过(字节全等+校验和)

## 执行记录

- 盘载口径:/var/tmp/kode-persist-bench(ext4),四场景全表见上
- tmpfs 附录:/tmp,5000×32K 场景见上;完整 stdout 在会话执行日志
- 选型裁定:packed-log 主向(生产接线随后续任务点火);RUST-126 key 契约
  与 RUST-127 PersistStore 崩溃安全协议照旧有效(file-per-entry 保留为
  小语料/精细原子性形态;packed 演进形态需新的撕裂尾语义设计)
