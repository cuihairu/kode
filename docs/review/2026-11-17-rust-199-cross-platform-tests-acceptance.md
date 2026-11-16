# RUST-199 验收纪要:三平台 环境变量/引号/编码/杀进程树 测试面——三维既有钉 + POSIX 树杀腿补钉

日期:2026-11-17。本纪要对账 RUST-199(旧 EXEC-011,主 todo 排队项)的验收口径与交付证据。结论:**环境变量/shell 引号/编码三维既有测试钉齐备;终止进程树 win32 臂已钉而 POSIX 臂缺钉,本批补 5 例后勾行。**

## 验收口径 → 交付证据映射

| 维度 | 交付面 | 证据 |
| --- | --- | --- |
| 环境变量 | `${env:NAME}` 注入环境展开(variableSubstitution 面)+ binPath `${env:}` 占位替换(serverManager 面)+ KBE_ROOT 环境变量传递 | `tests/variableSubstitution.test.ts:96`;`tests/serverManagerGaps.test.ts:161`(`:34` 注记三件套);`tests/debugConfigBootstrap.test.ts` |
| shell 引号 | win32 ComSpec `/d /c` 整行引号组装(空白/引号 token 自包引号,平台 mock 跨宿主跑)+ curl 参数两平台引号臂(POSIX 单引号 `'\''` 转义逐字面钉 / win32 双引号臂) | `tests/processManager.test.ts:273-321`(WIN-3);`tests/quickActionRunners.test.ts:117-118`(linux 臂字面)+同族 win32 臂 |
| 编码 | UTF-8 跨块多字节不损坏(StringDecoder 保留读界切开的多字节字符,append 不产生 replacement) | `tests/logHub.test.ts:104`(AUD-024) |
| 终止进程树 | win32 taskkill 三臂(退出 0 真/非 0 回落 child.kill/error 无 child false)既有钉;**POSIX 臂本批补钉 5 例**:组长负 pid 组杀信号原样传组/组杀 ESRCH 回落 child.kill 单 pid 不碰正 pid/无 child 回落正 pid 单杀/两路全抛 false 如实/child.kill 结果透传不虚报;平台经 `deps.platform` 注入不依赖宿主;R2-F23 无效 pid 闸既有钉 | **本批** `tests/processManagerPosixKill.test.ts`(5 例);既有 `tests/processManager.test.ts:324`(win32 三臂)/`:105`/`:117-121`(R2-F23) |

## 本批增量

- `tests/processManagerPosixKill.test.ts`(新,5 例):POSIX killProcessTree 四臂+回落结果透传,`vi.spyOn(process, 'kill')` 注入+try/finally 恢复,平台走 `deps.platform`(linux/darwin 双注)。
- prove-red:变异 `process.kill(-pid)` → `process.kill(pid)`(丢组杀语义)→ 3 例红(RC=1)→ cp+cmp 字节还原 → 复绿(RC=0)。

## 诚实条款

- 三平台覆盖形态:**win32 分支经平台 mock 在任何宿主验证 + POSIX 分支在 Linux 宿主真跑 + darwin 经 `deps.platform: 'darwin'` 注入验证分支逻辑**;真 Windows/macOS 运行时端到端不在 CI 矩阵内(CI=ubuntu runner,darwin 夜构建=编译口径)——如实登记,分支逻辑全覆盖≠三平台运行时端到端验证。
- 「环境变量」的形态是**变量替换与传递测试**(binPath/env 占位展开),不是全量 env 矩阵(每个变量×每平台的组合测试);代码面 env 直传 process.env(serverManager:326),无独立 env 组装器,故无组装器单测面。
- 编码面=日志流 UTF-8 边界(StringDecoder);Windows 控制台 GBK 输出场景在 kode 无消费面(引擎日志流协议假定 UTF-8,consoleLogTail/logHub 同口径),GBK 容错未实现不宣称。
