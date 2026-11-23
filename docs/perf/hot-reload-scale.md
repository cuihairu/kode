# 热更新规模基准(RUST-413 / 旧 HR-QA-001,2026-11-22)

- 车道:tests/perf/hotReloadScale.bench.ts(bench 专用 lane,与主 unit 门无交集)
- 跑法:`npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadScale.bench.ts`
  (最大档 `KODE_HRS_FILES` 缺省 50000,档位 200/2k/10k/最大档;输出追加
  docs/perf/hot-reload-scale-run.txt,`KODE_HRS_OUT` 可覆盖;M5-SSH 挂载根
  `KODE_HRS_SSH_ROOT` 缺省 `~/mnt-ssh-loop/kode-ssh-e2e/proj`,文件数
  `KODE_HRS_SSH_FILES` 缺省 200;无挂载点=本臂诚实跳过)
- 环境:node v24.21.0 / linux / 14 cpus / 200+2,000+10,000+50,000 文件(基准机同
  docs/perf/hardware.md §1);M5-SSH=sshfs 127.0.0.1 自环(真实 sshd 会话,FUSE 通道)
- 口径:热更保存流水线纯核(HotReloadSavePipeline)+ 真实盘上脚本树(tmpdir 生成,
  每文件唯一类名,确定性内容)+ 真实 readSnapshot(读盘+sha256)+ 真实定时器;
  只观测不改行为;断言只有确定性语义命中面,墙钟一律不进断言——阈值化归
  RUST-414 后续批次按需收编,本批先建测量。

## 五面实测(2026-11-22 全档;M5-SSH 端到端 2026-11-23 补,提交在库记录)

| 面 | 场景 | 关键值 | 语义闸 |
|---|---|---|---|
| M1 规模矩阵 | 200/2k/10k/50k 文件过滤扫描+吸收(定稿即发 debounce=0/flush=0,窗=0+透传语法闸=单读盘+sha256) | 每文件吸收 perFile 0.18ms→0.09ms(规模收敛,无超线性);吞吐 5.5k→11.6k files/s;吸收墙钟 36ms/199ms/962ms/4.31s;readLatency(含爆发排队)p50 25ms→3.28s;过滤每事件 ~0.01ms(50k 全扫 376ms) | 每档全部吸收(emitted=N)/revision 全 1/过滤全收 |
| M2 单文件持续保存 | 同文件 100 次连续保存,逐次 offer→emit 真延迟(Promise 等待非 poll 量化) | Save→队列 p50 1.51ms / p95 1.82ms / p99 2.59ms / max 15.96ms(§19.10 候选线 P95≤30ms 之下一个量级);持续吞吐 554 saves/s | 100 全发(无丢版)/revision 1..100 单调/全 save 源 |
| M3 Git checkout 500 | 500 文件一窗爆发(生产配置 debounce=500/flush=500/默认阈值 50) | 预览滞留墙钟 1038ms(=500 去抖+500 冲口,与配置精确一致);显式放行 0.66ms | auto 发送 0 次/500 全滞留/放行后 500 全发 revision 全 1 |
| M4 写入风暴 | 100 文件×(save 后紧跟 disk-change)同窗重叠 | 风暴墙钟 1009ms(去抖+冲口);100 发非 200 | 每发 coalesced=2/coalesceReason 含 disk-save-overlap |
| M5 远端 SSH/workspace | 远端形态路径规范化(WSL/UNC/远端 share/盘符)+ 规范化成本 | canonicalize 100k 次 283ms(~2.8µs/次,零 IO 纯词法) | 四形态规范化键与预期逐一相等 |
| M5-SSH 远端端到端(SSHFUSE) | sshfs 127.0.0.1 自环=活 SSH 会话(真实 sshd+FUSE 通道),200 文件全链(过滤→吸收→读盘→哈希),与 M1 同口径并排 | 过滤 perEvent 0.01ms(零 IO,与本地一致);吸收 perFile 0.46ms(本地盘 0.17ms,≈2.7×);readLatency p50 81.1ms / p99 86.7ms(本地盘 p50 23.8ms / p99 24.6ms,≈3.5×);吞吐 2.2k files/s(本地 5.8k) | 200 全吸收(emitted=N)/revision 全 1/过滤全收 |

## 读法与诚实边界

1. **量级结论**:每文件吸收成本在 200→50k 全档收敛于 ~0.1ms(读盘+sha256+定稿),
   无超线性放大;50k 文件爆发总吸收 4.31s 是 libuv 线程池读盘排队(readLatency
   p50 3.28s 即排队时延),非事件循环长阻塞(哈希在异步微任务分片执行)——
   生产配置下该爆发还会先落批量预览闸(M3),不自动全仓热更。单文件持续保存
   p95 1.82ms,远低于 §19.10 候选线 30ms(不含配置 debounce 口径与本面一致)。
2. **读路径激活条件(本批实测发现)**:纯核 due() 只在
   `readSnapshot && (稳定窗>0 || 语法闸)` 时读盘(hotReloadSavePipeline.ts:429);
   窗=0 且不注入语法闸=空壳 settle(diskHash 空串,去重面失效)——生产装配必注入
   其一,基准用窗=0+透传语法闸=单读盘(生产形状;两拍稳定窗归 HR-PR-09 虚拟钟覆盖)。
3. **过滤每调用重规范化 roots**:isWatchableScriptFile 每次调用都对 roots 做
   canonicalizeScriptFilePath(hotReloadSavePipeline.ts:208,函数体内),50k 事件
   纯词法过滤 376ms——观测记录,非本批修;归 RUST-414 段耗时账定夺。
4. **readLatency≠单读固有成本**:含全爆发并发排队;固有成本=perFile(wall/N)。
   两列都保留:前者答「50k 爆发时中位文件等多久才哈希上」,后者答「每文件净成本」。
5. **远端端到端已覆盖(M5-SSH,2026-11-23)**:sshfs 127.0.0.1 自环=活 SSH 会话,
   fuse 通道——读写/读盘/哈希全链走真实 sshd 会话与 FUSE 延迟。同档(200 文件)
   并排:过滤面零 IO 纯词法,与本地盘一致(无 SSH 放大);吸收面(读盘+哈希)每文件
   0.46ms vs 本地 0.17ms(≈2.7×),readLatency p50 81.1ms vs 本地 23.8ms(≈3.5×)——
   即 SSH FUSE 通道把单读盘延迟拉高 ~3.5×,但聚合每文件成本仍 <0.5ms 量级,不构成
   量级回退(界=首测 ×10 余量)。vscode-remote 真形态另有 fsPath 钉 376ec986。
   无 sshfs 挂载的环境(如 CI)本臂诚实跳过,不假绿。
6. **阈值化待建**:本批断言只钉语义命中;若后续要把规模墙钟纳入夜间门,应走
   KODE_PERF_BOUND_* 同款宽松上界纪律(RUST-027),不直接钉绝对值。
