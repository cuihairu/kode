# 延迟结果分组报告(RUST-023,2026-11-15)

RUST-023 要求延迟结果按 cold/warm、idle/busy、SSD/network FS、local/remote、root 数量分组。本报告把现有量测按五轴归位;**能测的轴给实测,环境不具备的轴如实标 N/A 并写明缺什么**,不造假(SER-14 口径)。机器与偏差细则见 hardware.md §1/§2。

## 轴 1:cold/warm —— 已测(v02 基线 + coldHover 面)

| 场景 | cold 首击 | warm p50 | warm p95 | 来源 |
|---|---|---|---|---|
| large-30k hover | 16.3-17.9ms | 0.25-0.26ms | 0.42-0.44ms | v02 基线(2026-11-15 复跑双轴同值域) |
| large-30k completion(py) | 0.73-0.75ms | 0.03ms | 0.08ms | 同上 |
| large-30k definition(py) | 648-702ms(含首次解析) | — | — | 同上 |
| big-py hover | 9.3-9.9ms | 3.78-3.99ms | 4.65-5.96ms | 同上 |
| multi-root hover | 1.75-2.52ms | 0.23-0.25ms | 0.34-0.46ms | 同上 |
| 预热后失效 cold hover | 59.74ms | — | — | docs/perf/cold-hover-run.txt H5 |

结论:热态全亚毫秒~毫秒级,冷态成本集中在首次解析/扫描,与 2026-11-04 基线报告结论一致。

## 轴 2:idle/busy —— 已测(扫描窗口内外 hover 对照)

- busy(初始扫描进行中 hover):coldHoverDuringInitialScan n=5 p50=0.16ms、**p95/max 81.47ms**(docs/perf/cold-hover-run.txt H1,largeFiles=30000)——扫描期宿主争用产生长尾,但 P50 不劣化;
- idle(扫描完成 + 缓存热):warmHover p50=0.03ms p95=0.17ms(H4)。
- 附加证据:宿主延迟分段(KODE-PERF-006)进程拓扑重算 ~260ms@1000def 是本树最高单次阻塞(同步段),已单独立卡跟踪。

## 轴 3:存储介质(tmpfs vs 机械盘) —— 本批双跑实测(页缓存条件,见下方诚实边界)

同参数双跑(KODE_PERF_ASSETS_OUT 轴开关,largeFiles=30000,2026-11-15):

| 指标 | tmpfs(/tmp,内存盘) | ext4/机械盘(/home,LVM) | 差 |
|---|---|---|---|
| startup.fullPyScanWall(large-30k) | 2,807.96ms | 2,851.86ms | +1.6% |
| activation.defScanWall(large-30k) | 738.22ms | 797.04ms | +8.0% |
| multi-root defScanWall | 10.11ms | 15.47ms | +53%(绝对值 5ms 级) |
| warm hover p50(large-30k) | 0.26ms | 0.25ms | ~0 |
| big-py warm hover p50 | 3.78ms | 3.99ms | +5.6%(单跑抖动域) |
| 峰值 RSS(scan,large-30k) | 328.89MB | 321.35MB | ~0 |

**诚实边界**:两跑的资产都是生成后立扫(先写后读),文件内容在页缓存里,本对照量到的是文件系统/元数据路径开销的**上界**(≤8%),**不是真冷盘读成本**——drop_caches 需要 root,本机不可用,故「冷缓存 × 机械盘」未测。结论措辞:存储介质在页缓存热条件下对 provider 延迟无可测影响;真冷盘读影响未测,标 N/A(root)。

## 轴 4:root 数量 —— 已测(v02 基线 multi-root 场景)

- 1 根(large-30k)vs 3 根独立资产根(multi-root,含同名实体 Avatar/同名类 Inventory):warm hover p50 0.23-0.25ms vs 0.25-0.26ms——多根无回归;多根成本在扫描/内存(multi-root 全量 .py 扫描 2.04-2.64ms 为小语料;RSS 随根累加,见 v02 报告 §内存)。

## 轴 5:network FS / local/remote —— 未测,环境不具备(N/A)

- 本机无 NFS/SMB 挂载,无 Remote SSH/容器宿主;两轴缺的不是代码是**环境**,如实 N/A。取得环境后复用本批轴开关(KODE_PERF_ASSETS_OUT 指向挂载点)即可零改码补测。

## 条件敏感性警示(强化 PERF-015 纪律)

同机同码:全量 .py 扫描墙钟 2026-11-04 基线 10,408.82ms vs 2026-11-15 双跑 2,808-2,852ms(3.7×)——差异来自页缓存与机器负载条件,不是代码变化。**跨日/跨条件比较绝对速度前必须核对测量条件**;单跑数字一律带 n 与条件注。

## 复跑命令

```bash
# tmpfs 轴(默认)
KODE_V02_OUT=/tmp/v02-axis-tmpfs.txt npx vitest run --config vitest.bench.config.ts tests/perf/v02Baseline.bench.ts
# 机械盘轴
KODE_V02_OUT=/tmp/v02-axis-hdd.txt KODE_PERF_ASSETS_OUT=/home/cui/workspaces/.perf-assets-hdd \
  npx vitest run --config vitest.bench.config.ts tests/perf/v02Baseline.bench.ts --testTimeout 600000
```
