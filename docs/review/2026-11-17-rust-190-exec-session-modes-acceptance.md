# RUST-190 验收纪要:「复用运行会话」与「每次隔离进程」双模式对账

日期:2026-11-17。本纪要对账 RUST-190(旧 EXEC-002,主 todo 排队项)的验收口径与既有交付证据。结论:**两种执行模式均已交付且按任务性质选择,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 复用运行会话 | 常驻 Python 执行服务(RUST-002 判据③):一个解释器进程经 stdin/stdout 长度前缀帧协议承载任意多次编译,只在退出/故障/超时后重建;热更语法闸已从「每次定稿 spawn 一个解释器」切换到常驻服务承载(hotReload.ts 装配注释明记);故障语义两路分明——infra 故障(退出/超时/未就绪/回包不可解析)reject 走热更 fail-open(检查器不可用不拦热更),真语法错误 resolve 不拆服务 | `src/backend/pythonExecService.ts`;`src/backend/pythonExecSyntaxCompile.ts`(纯核适配,零 vscode 零 child_process,工厂注入);`src/hotReload.ts:1096-1109`;`tests/pythonExecService.test.ts` / `pythonExecSyntaxCompile.test.ts` / `hotReloadExecServiceWiring.test.ts` |
| 每次隔离进程 | 单发执行语义面:pythonTestRunner / profileInterpreter 探针 / debugpy 探针族等「每调用一进程跑完即退」;进程生命周期统一走 processManager 受管面(RUST-189 盘点 7/10) | `src/pythonTestRunner.ts` / `src/profileInterpreter.ts` / `src/backend/debugpyPortProbe.ts` / `src/backend/debugpyPreflight.ts`;`src/backend/processManager.ts` |
| 按任务性质选择 | 选择依据写进产品面头注:高频无状态编译→复用(一个进程承载任意多次,与 kodeCoreClient 单进程 stdio 多路复用同构);单发探针/执行→隔离 spawn(无状态可弃,无需会话);两处头注明记理由 | `pythonExecService.ts` 头注(「最频繁又无状态的一面换成常驻」);`pythonExecSyntaxCompile.ts` 头注(失败语义两路不混) |

## 本批增量

- 零代码增量:双模式、选择依据、失败语义两路、复用/重建断言(`service()` 测试句柄)均有既有钉,再造属仪式性重复。

## 诚实条款

- 模式选择是**各装配面按任务性质硬接**(编译→复用,单发→隔离),没有运行时用户配置切换;这是设计选择(任务性质在装配期已知),如实登记,不宣称「用户可选模式」。
- 复用会话的隔离边界:常驻进程只承载**无状态 compile** 任务,不执行有副作用脚本——「绝不默认跨任务污染解释器状态」由任务性质(纯 compile)保证,不是会话机制保证;有状态 REPL 会话是 RUST-191 事项,本纪要不冒充已覆盖。
- 单发面的进程收编度见 RUST-189 盘点(gitRunner/inferPipeline 直 child_process 残差待拍板)。
