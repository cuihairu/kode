# RUST-201 验收纪要:hangs / 空闲 session / 进程退出 / pipe 阻塞 / 输出丢失 五故障类

日期:2026-11-17。本纪要对账 RUST-201(旧 EXEC-013,主 todo 排队项)的验收口径与既有交付证据。结论:**五故障类均有诊断/测试面(其中 pipe 阻塞以架构规避而非注入测试承载),本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 故障类 | 交付面 | 证据 |
| --- | --- | --- |
| 命令 hangs | 三层钉:就绪探针挂起超时不误标 running(sampler 与超时竞速、硬超时先清);装死进程(收信号不退出)超时升级击杀;常驻服务编译超时/握手超时即拆进程不串帧(注入吞帧子进程精确复现) | `tests/processManager.test.ts:162`(probe 挂起超时)/`:31`/`:117`(KR-AUD-39 装死升级击杀);`tests/processManagerGapArms.test.ts:83`;`tests/pythonExecService.test.ts:75` |
| 空闲 session | 常驻服务请求间空闲存活:一个常驻进程承载多条编译且 pid 不变(空闲期不计 timeout——超时是单请求计时器,空闲等待无计时器);空闲语义=等待下一条指令而非闲置回收 | `tests/pythonExecService.test.ts:18`(惰性 spawn+多编译 pid 不变) |
| 进程退出 | spawn 即失败如实报未就绪不悬挂;dispose 如实报已关闭不假装成功;故障(退出/超时/未就绪/回包不可解析)→ 语法闸 fail-open 且服务拆掉、下一次 compile 换新句柄重建(共享游标续序列不复读首帧) | `tests/pythonExecService.test.ts:119`/`:107`;`tests/pythonExecSyntaxCompile.test.ts:57`(reject fail-open+拆掉重建,`:63` 断言换新句柄)/`:17`(共享游标) |
| pipe 阻塞 | **架构规避而非注入测试**:常驻服务 wire 恒读 stdout/stderr 双流(消费端永不停止读取,子进程不会因 pipe 满而挂死);logHub 有界轮询(25ms 时间片+单轮 64KB+pending 10000/8MB 上限);pythonTestRunner 输出 1MB 上限截断——无「消费端停止读取」的代码路径,无专项 stall 注入测试 | `src/backend/pythonExecService.ts`(wire);`src/backend/logHub.ts:71-75`;`src/pythonTestRunner.ts:192` |
| 输出丢失 | 三面记账:超限丢弃最旧且统计明确(pendingDropped 可查);超上限截断带标记(`truncated at`);读界切开的半行/多字节字符保留不损坏 | `tests/logHub.test.ts:154-163`(AUD-025);`tests/pythonTestRunner.test.ts:360-370`(截断标记)/`:375`(小输出不截断退出码信号如实);`tests/logHub.test.ts:104`(AUD-024) |

## 本批增量

- 零代码增量:五故障类均有既有钉或架构面,再造属仪式性重复。

## 诚实条款

- pipe 阻塞的形态是**恒读+有界轮询的架构保证**(消费端无停止读取路径),不是 stall 注入测试;若未来出现可暂停消费的执行面(如手动暂停读取),阻塞测试随面设计。
- 「诊断」的形态是**故障注入测试钉**(hangs/退出/丢失均可注入复现)+**记账面**(dropped/truncated 可查),不是运行时诊断命令;慢执行排查面见 RUST-200 拍板项。
- 空闲 session 无主动回收(常驻服务闲置常驻,dispose 只随窗口关闭/配置重载触发)——设计选择(冷启动成本高于闲置内存),如实登记。
