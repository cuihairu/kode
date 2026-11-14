# RUST-002 审计与整改：常驻 Core 与可复用执行服务

日期：2026-11-15。审计对象：todo.md RUST-002「Core 是常驻进程，语言请求不得 spawn Python/Rust 进程；运行脚本须独立的可复用执行服务」。方法：三条判据逐条核对到调用点，结论只认读到的代码。

**结论：判据①②审计通过（既有实现已满足，本批零改动）；判据③是真差距，已修——把最高频的 Python 脚本执行面（热更保存语法闸，每次定稿一次）从「每次新起一个解释器进程并等它退出」换成常驻解释器 + stdin/stdout 帧协议的**可复用执行服务**，与 Rust Core（单进程 + stdio 多路复用）同构。**

## 1. 判据①②：审计通过（零改动）

| 判据 | 出处 | 裁定 |
|---|---|---|
| ① Core 是常驻进程 | `backend/kodeCoreGate.ts:418-424` `ensureClient()`：`this.client && this.clientServerPath === this.config.serverPath` 时**直接返回既有实例**，不按请求新建 | ✅ 单一常驻实例，按 serverPath 复用 |
| ② 语言请求不 spawn Python/Rust 进程 | 请求全走该常驻实例：`:394-402` `client.request(method, params, opts)`、`:364-370` 命令级 `$/kode/rpc` 亦同一实例；进程仅 `backend/kodeCoreClient.ts:163` spawn 一次，`:447-475` 只在**意外退出**时按重启窗口（10s/3 次，`RESTART_MAX_DEFAULT`）respawn + 重握手 | ✅ 无按请求 spawn |

Rust 分析面（def 校验、process topology、self-flow 等）全部走这条 stdio 管道，不另起进程。

## 2. 判据③：真差距，已修

### 2.1 差距

Python 脚本执行面此前全是**一次性进程**：`hotReloadPythonCompile.ts` 每次调用 `spawn` 一个新解释器、喂源码、等它退出、读 stdout。热更语法闸接在其中——**每次保存定稿都起一个解释器进程**。这就是「运行脚本须独立的可复用执行服务」要治的病。

### 2.2 常驻执行服务（`backend/pythonExecService.ts`）

- **帧协议**（双向）：`<十进制字节长度>\n<恰好那么多字节>\n`。长度前缀使多行源码跨帧无损传递，换行只作分隔不进载荷；回包全为 ASCII（JSON），故长度=字符数，`decodeFrame` 可按字符切片消费。
- **生命周期**：**惰性 spawn**（首次 `runCompile` 才起）→ 等 `ready` 帧握手 → 逐帧兑现 → 退出/故障/超时即拆、下次调用重建。`dispose()` 是永久关闭，后续如实报「已关闭」不重建。
- **并发语义**：协议是单请求-单回包。并发指令进 **FIFO 队列**（不拒、不乱序）。
- **超时不摘队**：迟到的帧会串到下一条请求上造成错位。故超时即拆掉整个子进程、在途请求同批按故障失败，下一次调用惰性重建——宁可重付一次进程启动，也不交出错位的判定。
- **执行器语义红线**：解释器侧**只 `compile()` 不执行**，用户代码永不运行（继承旧一次性编译路径的语义，迁移不得扩大权限）。只 import `json`/`sys`/`traceback`。

### 2.3 失败语义两路分叉（`backend/pythonExecSyntaxCompile.ts` 纯核）

闸门 fail-open 语义的根，两路不可混：

- **执行服务故障**（进程退出/超时/未就绪/回包不可解析，`outcome.infra`）→ **reject**，并拆掉服务待重建。闸门据此 fail-open：**检查器不可用不得拦热更**。
- **真语法错误** → resolve `{ok:false, errors:[行]}`，**不拆服务**（进程健康，下一条照常复用）。

混为一谈会让解释器抖动把热更静默放行成「无错」，或让语法错误被当成故障吞掉。

### 2.4 装配与生命周期（`hotReload.ts`）

`buildRealSyntaxGate()` 每次配置面重建都换句柄：新建 `createExecServiceCompile`（解释器由同一 `resolveProfileInterpreter()` 解析，故服务在创建时已固定解释器，解释器路径变更自然刷新），旧的 `previous?.dispose()`；`setupHotReload` 的 `subscriptions` dispose 面同步释放当前句柄。

**TS 少参数容忍坑（真缺陷，本批被抓出）**：闸门契约是 `compile(interpreter, content)` **两参**，执行服务核是 `compile(content)` **单参**。若直接写 `handle.compile`，TS 的少参数容忍会把 `interpreter` 绑进唯一形参——**解释器路径落进 content 位**，每次编译的「源码」其实是 `/usr/bin/python3`，恒判语法错、恒拦。而 `blocked` 诊断只进流水线、不上 status 日志，故**静默失败**（表现为合法文件从不发送）。修法：`compile: (_interpreter, content) => handle.compile(content)`，显式忽略解释器形参并留注释钉死该坑。

**删除死码**：`src/hotReloadPythonCompile.ts` 删除——其唯一消费者就是旧一次性闸门。

## 3. 测试

- `tests/pythonExecService.test.ts`（真 python3 集成，8 例）：惰性 spawn + **同一 pid 承载多次编译**；语法错返回 `ok:false` 且**服务存活**；并发 FIFO；超时拆服务（注入吞帧假进程，避免真实解释器响应过快导致假绿）；dispose 语义；**只 compile 永不执行**（写 marker 文件断言不存在）；服务源码自检。
- `tests/pythonExecSyntaxCompile.test.ts`（纯核，5 例）：两路失败语义分离；**语法错不拆服务**；故障 reject + 重建；解释器解析不到 reject；懒创建。共享游标保证服务重建后不复读首帧。
- `tests/hotReloadExecServiceWiring.test.ts`（接线，2 例）：**不注入 `pipelineFaces.syntaxCheck` 替身**，逼出真闸 `buildRealSyntaxGate`（唯一真起解释器进程的路径，此前从未被任何测试驱动）。语法错文件 → 传输 0 次；合法文件 → 1 次。观测面取**传输是否被调**——`blocked` 只进流水线诊断不上日志，`runAction` 还受动作名/发送通道约束，都不是闸的判据。

prove-red：把服务改成不复用（每次新建）后，pid 复用断言与「服务存活」断言**红**；还原（`cp` + `cmp` 字节校验）后 15/15 绿。

## 4. 诚实边界

- 常驻服务只覆盖**热更语法闸**这一面。其他一次性进程面（`inferPipeline.ts` pyrefly、`venvInterpreterPicker.ts` 解释器探测、`gitRunner.ts`/`remoteConnection.ts` ssh、`processManager.ts` 杀进程树）不属本判据的「运行脚本」范围，未动、不声称已动。
- 常驻解释器是**按解释器路径单例**的（重建配置面才换句柄），非全局多解释器池；不声称支持并发多解释器。
- 超时拆服务是**粗粒度**策略（整服务重建而非单请求丢弃），取舍理由见 §2.2；不声称实现了请求级取消。

## 5. 门禁

`tsc` RC=0；`npm run lint`（`eslint src --ext ts`）RC=0；`test:unit` 822 文件 **10225 passed + 8 skipped** RC=0；`xvfb-run -a npm run test:demo:editor` 25 passing RC=0。

锚点：`perfCallChainDoc.test.ts` ANCHORS 面不含 `src/hotReload.ts`（核过），本批 `hotReload.ts` 增删行不改锁步表；`docs/perf/2026-baseline.md` 无相应面，无需锁步。