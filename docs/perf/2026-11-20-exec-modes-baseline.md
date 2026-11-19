# EXEC-BASELINE-002 执行模式耗时基准(2026-11-20)

任务:EXEC-BASELINE-002(RUST-200 落地)——把「重用模式热态 compile」与「纯进程冷启动/一次性执行」两种执行模式的真实耗时拆开量,建立性能回归对照基线。RUST-200 的验收口径「准确分辨 terminal 窗口与 Python 冷启动耗时」以本基准面交付:重用与冷启动的结构性区分不再是行为论断,而是有数字、有钉、可回归对照的测量面。

## 方法

套件 `tests/perf/execModesBaseline.test.ts`(1 例,`timeout: 120_000`),三组各 N=20 逐次计时(`performance.now()`),首跑热身不计入;P50/P95 经 `repeatStats`(nearest-rank,与 v02Baseline 同源)汇总。计时边界与执行面:

| 组 | 计时窗 | 执行面 |
| --- | --- | --- |
| ① reuse-compile | 每次 `runCompile` 调用到回包 | `pythonExecService` 常驻帧协议服务(预热 1 次含惰性 spawn+握手,不计入;全程断言同一 pid 不重 spawn) |
| ② cold-start | `manager.start`(spawnProcess)到进程 exit 事件 | `ProcessManager` 受管 spawn `python3 -c pass` |
| ③ oneshot-compile | 同② | 每次新 spawn `python3 -c compile(open(Avatar.py))` 到 exit(0)——旧一次性路径形态的每调用合计成本 |

- 基准任务脚本=`tests/fixtures/kbengine-demo-assets/scripts/cell/Avatar.py`(8.9KB,真实 demo 脚本,非空串假任务),①③同任务同内容。
- ②口径注记:`-c pass` 形态下「就绪」的可观测证据=进程自然退出(code 0),即冷启动完成的**上界**(含空指令执行与进程退出收尾,通常 <2ms 尾差)。
- ③与②**分开记,不相减**出「纯 compile」:两组是独立噪声样本,相减只会放大噪声;③本身即产品口径(旧一次性路径每调用付出的全部成本)。
- 量完即收:①`service.dispose()`,②③`manager.dispose()`(受管面,不裸 child_process)。

## 断言(结构判据,非绝对阈值)

- 每样本有限、>0、< `PYTHON_EXEC_TIMEOUT_MS`(5000ms,服务超时上限作宽松天花板)。
- **①中位数 < ②中位数**:重用 vs 冷启动的结构性区分(RUST-200「准确分辨」的可测兑现)。
- ①中位数 < 50ms:热态管道往返+compile 的宽松上界,超出即「重用」名存实亡。
- ①全程同一常驻进程 pid;②③每次 exit 0(测量面真实跑完,非假计时)。

跨机器绝对比较禁止(PERF-015 口径):以上判据在任意机器上结构性成立(热态管道往返与完整进程 spawn 差一个数量级),绝对毫秒数不跨机器比。

## 实测(2026-11-20;测量机当时状态)

环境:Intel i9-10880H @ 2.30GHz / Linux 7.0.0-43-generic x86_64 / Python 3.14.4 / node v24.21.0 / vitest v5.1.0 独跑本套件(无其他套件并发;机器为桌面日常使用态,非隔离基准机——数字是本机当时状态,CI 慢机数字不外推)。

| 组 | n | P50 | P95 | min | max |
| --- | --- | --- | --- | --- | --- |
| ① reuse-compile(常驻热态单次) | 20 | 1.6~2.35 | 2.08~3.34 | 1.34 | 3.41 |
| ② cold-start(python -c pass) | 20 | 17.67~21.17 | 19.96~25.52 | 15.22 | 28.46 |
| ③ oneshot-compile(spawn+compile+exit 合计) | 20 | 23.94~25.92 | 26.75~35.92 | 18.95 | 37.03 |

四次独立跑全绿(数值为四跑区间;run 日志:`2026-11-20-exec-modes-baseline-run.txt`)。

## 结论

- **重用模式单次 compile P50≈2ms,纯进程冷启动 P50≈18~21ms,一次性执行(spawn+compile+exit)P50≈24~26ms**:常驻服务把热更语法闸的单次判定成本压到一次性路径的约 1/10~1/13,把每调用的完整解释器启动(≈20ms)折叠成一次性的握手成本。
- ③比②稳定多出 ≈3~6ms = 同一 8.9KB 脚本的 compile+退出收尾边际成本,量级与①热态单次(P50≈2ms + 帧协议往返)自洽。
- RUST-200 的「准确分辨」落点:重用/纯进程两模式的耗时差是**结构性的一个数量级**,不是噪声可解释的抖动;prove-red 三咬钉死测量面——①每轮 dispose 重建(pid 恒等闸红)/①计时窗注入 30ms(结构中位数判据红:32.69 < 20.67 不成立)/②换非零退出命令(退出码闸红),咬后字节还原,原套件复跑全绿。
- 回归对照用法:后续动 `pythonExecService` 协议/`processManager` spawn 面时,本套件的结构判据自动守恒;若某改动使①中位数逼近②中位数,即「重用」退化,该红。
