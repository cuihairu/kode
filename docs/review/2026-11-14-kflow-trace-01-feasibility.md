# KFLOW-TRACE-01(FLOW-022)运行时采集可行性核实

日期:2026-11-14。任务:todo.md FLOW-022「核实运行时采集可行性。验收:评估 debugpy 停止栈、Python profile/trace、引擎消息钩子、日志和 py-spy 各自能获取的数据/代价;采样栈不冒充完整请求轨迹。」

本文只核实与记录,不实现采集(采集入口是 FLOW-025 的独立增量)。红线沿三图契约(docs/design/kflow-three-graph-contract.md):**采样栈不冒充完整请求轨迹**(R2:runtime 证据必须带采集器+时间;R4:跨进程因果只走消息关联 ID,禁止按帧名相同/时间邻近宣称因果)。所有结论给出可回查出处;本机实测命令与输出见附录。

## 0. 环境事实(所有渠道的前提)

- 本机 demo 引擎二进制链接 Python 3.14;用户目标引擎版本为 CPython 3.7.3(出处:docs/design/demo-hot-reload.md §6)。**任何调试/采样组件的版本配对以引擎目标版本为准,不以开发机为准**。
- Python 3.7.3 的 debugpy 配对已锁定:debugpy==1.7.0 + ms-python.debugpy@2024.0.0(出处:docs/zh/guide/python-debugger-compatibility.md §1;requirements 见 scripts/requirements/debugpy-py37.txt)。
- 本机内核 yama ptrace_scope=1(实测 `/proc/sys/kernel/yama/ptrace_scope` = 1):py-spy 类外部读取器默认只能读直系子进程。

## A. debugpy 停止栈(交互式断点面)

- **可获取的数据**:断点命中时该进程的完整 Python 帧序列(文件/行号/函数名/实参局部值),经 DAP `stackTrace` 逐帧读取。停在断点时的栈是**完整事实**(不是采样),可跳源码。异常停止时含异常位置与栈(满足 FLOW-024「异常位置」字段面)。
- **代价**:每次命中停世界(该进程内全停);单进程单会话;不产生时间上连续的轨迹——两次断点之间的执行不可见。
- **版本/装配面**:3.7.3 引擎须按 §0 锁定表安装;kode 现有自动路径存在已知旧假设(autoDebugpy.ts `EMBEDDED_PYTHON_VERSION='3.12.13'`、`MIN_DEBUGPY_VERSION='1.8.0'` 会错误拒绝 3.7 所需的 1.7.0——出处:python-debugger-compatibility.md §4,该缺口原文记录,本文不把它写成已修复)。
- **边界(不得宣称)**:debugpy 面没有消息关联 ID,跨进程只能各进程各会话分别停;不能宣称「请求轨迹」,只能宣称「某断点的停止栈」。

## B. Python sys.setprofile / sys.settrace(受控逐事件面)

- **可获取的数据**:逐线程 call/return/exception 事件(函数/文件/行号),`frame.f_back` 可取真实帧链;纯 Python 机制,3.7.3 与 3.14 都可用,嵌入引擎的脚本线程同样生效(引擎每 tick 从 C++ 进入 Python,帧链从被调度的实体方法起)。
- **实测代价(本机 Python 3.14.4,3 层调用×20k 次,附录 A1)**:baseline 19.8ms;`sys.setprofile` 55.0ms(**2.8x**);`sys.settrace` 146.7ms(**7.4x**)。单次 `frame(3,20)` 形态产生 5 call + 5 return 事件(事件量=帧数×2,不随循环体膨胀)。
- **代价结论**:`settrace` 常开不采纳(逐行事件,7x 级);`setprofile` 围绕单个方法/单 tick 开关(受控入口,FLOW-025 形态)开销可承受,但**绝不默认开启**——采集入口必须独立可关、有界缓冲(FLOW-025 验收原文)。
- **边界**:单进程;C++ 引擎 tick 之间的间隔不可见(Python 面只见被调度的调用);无跨进程消息语义。

## C. 引擎消息钩子(消息/派发面)

- **可获取的数据**:Python 层能看到的「消息」只有**派发后的实体方法调用**(exposed 方法、引擎回调钩子)。原始 wire 消息在 C++ 侧:logger 进程是独立 PythonApp(`kbe/src/server/tools/logger/logger.h:49`,出处:docs/knowledge/api-loginapp-dbmgr-logger.md),demo 侧无 login/db/logger 入口脚本(同出处 §脚本布局)。
- **判定**:Python 层没有原始消息钩子可挂;不改引擎拿不到消息级事件流。**未经协议核实不得擅改 wire 消息**(todo.md FLOW-026 验收原文)——消息是否已有可用关联 ID 归 FLOW-026 核实,本文不预判。
- **可用的派发面替代**:对实体方法入口做受控插桩(B 渠道 setprofile 即可看到派发进入的第一个 Python 帧,无需改引擎)。

## D. 日志(证据点面)

- **可获取的数据**:序列证据点。demo 资产已有真实通道:`evidenceLog(msg)` 追加写 `$KBE_DEMO_EVIDENCE` 指向的文件;引擎未编译 log4cxx 时脚本层 INFO 只进 logger 转发面,stdout 看不到(出处:tests/fixtures/kbengine-demo-assets/scripts/common/KBEDebug.py:30)。
- **代价**:近零(受环境变量开关,未设即空操作)。
- **边界**:日志是点不是栈(无帧序列、无时长),跨事件只能按时间戳+内容做**候选关联**;按 R4 不得宣称因果。

## E. py-spy(采样面)

- **可获取的数据**:外部采样栈(进程不配合也能读);`dump` = 瞬时完整栈,`record --rate N` = N Hz 采样序列(speedscope 格式,样本含帧名/文件/行)。上游支持 Python 2.2–3.x 系列(含 3.7;具体以目标进程符号可读为准)。
- **kode 已交付面**:PDBG-003 py-spy profiling entry(Servers 树 `py-spy dump --pid <pid> --nonblocking`,按解释器环境解析/安装 py-spy,权限失败附 ptrace 指引:Linux ptrace_scope=0/sudo/cap、容器 SYS_PTRACE、Windows 同用户/提权;出处:docs/features.md 255-256,PDBG-004/005 已覆盖 ssh 远程与远程进程选择)。
- **本机实测(附录 A2)**:本次核实临时把 py-spy 0.4.3 装到 `~/.local/bin`(pip --user,探针后已卸载——`covExtensionCommands` 门禁钉着「本机未装 py-spy」形态,装着会打红两例);**在当前沙箱 shell 内对外部 python 进程 dump/record 均 Permission Denied**(ptrace 被会话沙箱拒绝,yama=1 之上还有一层);目标进程即使 `prctl(PR_SET_PTRACER_ANY)` 仍被拒。判定:py-spy 能力本身成立(PDBG-003 测试链与上游文档),**本沙箱 shell 不可用作采集现场**,须在真实终端/CI 宿主按 PDBG-003 指引运行(真需要时 PDBG-003 会按解释器环境一键安装)。
- **边界**:采样必然漏样本间的调用——**采样栈不冒充完整请求轨迹**(任务原文);无逐请求关联;受 ptrace 权限约束。

## 汇总对照

| 渠道 | 数据面 | 连续性 | 跨进程 | 开销 | 门槛/约束 |
| --- | --- | --- | --- | --- | --- |
| debugpy 停止栈 | 断点处完整帧+局部值+异常位置 | 断点间不可见 | 各进程独立会话 | 停世界/次 | 3.7.3 须 debugpy 1.7.0 锁定配对;kode 自动路径存在已知版本假设缺口 |
| setprofile(受控) | 逐 call/return/exception 事件+帧链 | 开启期间完整(单线程) | 无 | 实测 2.8x | 纯 Python 可嵌入;绝不默认开启 |
| settrace | 逐行事件 | 完整 | 无 | 实测 7.4x | 常开不采纳 |
| 引擎消息钩子 | Python 层只见派发后方法调用;wire 面 C++ | — | wire 关联 ID 未核实 | 需改引擎才能拿消息流 | FLOW-026 红线:未核实不改 wire |
| 日志(evidenceLog) | 序列证据点 | 稀疏 | 仅时间戳候选关联 | 近零 | 无栈无时长 |
| py-spy | 采样栈/瞬时 dump | 采样(漏样本间) | 无逐请求关联 | 低(采样) | ptrace 权限;沙箱 shell 不可作现场 |

## 对后续条目的结论

1. **FLOW-023 协议**:每渠道作为独立 `runtime-source` 证据类型建模,必带采集器标识+时间戳+采样率标记(R2);跨进程因果字段留给消息关联 ID 位,**无 ID 时只允许候选关联语义**。
2. **FLOW-024 首选来源**:受控 setprofile(B)——真实帧顺序/文件行/异常位置都能拿到,且嵌入 3.7.3 可用;py-spy dump 作免停补充;debugpy 停止栈作交互深查。
3. **FLOW-025 形态预定**:独立开关+有界缓冲+开始/结束/异常/丢弃计数;默认关闭;settrace 不进产品面。
4. **红线重申**:任何采样/日志来源都不得在 G3 呈现成完整请求轨迹;因果只走 FLOW-026/027 核实过的关联 ID。

## 附录:本机实测记录

### A1. setprofile/settrace 开销(Python 3.14.4,本机)

```
baseline 19.8ms  setprofile 55.0ms (2.8x)  settrace 146.7ms (7.4x)
events per frame(3,20): {'call': 5, 'return': 5, 'c_call': 1, 'c_return': 0}
```

(3 层调用内环 20 次迭代×20k 次调用;探针函数空体,数字是回调机制本身的下界开销。)

### A2. py-spy 现场探针

```
$ cat /proc/sys/kernel/yama/ptrace_scope  →  1
$ py-spy dump --pid <spawned python> --nonblocking
Permission Denied: Try running again with elevated permissions by going 'sudo env "PATH=$PATH" !!'
```

目标进程 `prctl(PR_SET_PTRACER_ANY)` 后同结果——判定为会话沙箱拒绝 ptrace(非 py-spy 能力问题);现场须按 PDBG-003 的 ptrace 指引在真实终端运行。
