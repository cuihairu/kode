# IDE-LINT-012:receiver-none 快速修复语法/语义边界验收(真实 VS Code)

**验收原文**(todo.md):「验收 lint 快速修复的语法和语义边界;多行调用、同一行两个不同
receiver、EOF、同级后续语句与缩进均可在真实 VS Code 应用;不把第一个 receiver 的修复
套给第二个,不无提示改动无关后续逻辑。」

**对象**:`kbengine.receiverNone` 的 None 守卫快速修复(`Wrap with null guard` / `Insert
None guard`,KBEngineReceiverNoneGuardCodeActionProvider)。

## 方法

真机套件 `src/test/electron/suite/lintQuickFixBoundaries.test.ts`(`runTest.js --lintfix`,
与 field 共用 demo 资产+5000 外部根装配;夹具由套件自写),每案独立夹具文件,走真实链
`publishDiagnostics → executeCodeActionProvider → workspace.applyEdit → 断言最终文本`。
证据落 `docs/perf/2026-11-06-lint-quickfix-boundaries-run.txt`。运行命令:
`xvfb-run -a node out/test/electron/runTest.js --lintfix`(5 passing,RC=0,复跑稳定)。

## 五条边界与判定

| 边界 | 夹具形态 | 判定(全部通过) | 证据行 |
| --- | --- | --- | --- |
| ① 多行调用 | 括号未闭合续行 `self.client.send(\n "hello",\n 1,\n )` | 包裹把整段调用纳入,续行重缩进连贯 | `lintfix.multiline` |
| ② 同一行两个不同 receiver | `self.cell.a(); self.client.b()` | a 诊断只出 cell 守卫、b 诊断只出 client 守卫;整行上下文 4 动作各带各的 | `lintfix.sameline` |
| ③ EOF | 末行使用、无尾换行 `self.client.last()` | 包裹 applyEdit 成功、位置不越界、无尾换行不损坏 | `lintfix.eof` |
| ③b EOF 早退 | 同上 | 早退插入落位、文本精确 | `lintfix.eof.guard` |
| ④ 同级后续语句与缩进 | `client.a/client.b/if client:/client.c` + `base.other` | 包裹同级+更深整体进一级,首个不引用本 receiver 的同级语句截断 | `lintfix.siblings` |
| ⑤ 不无提示改动无关逻辑 | ①④ 的无关行 | 无关行逐字节不变(断言整文件文本精确等于期望) | ①④ 内 |

## 修复(bug)

同一行两个不同 receiver 时,原 provider 取**行首个** `self.<receiver>.`——诊断落在
第二个 receiver(如 `self.client.b()`)但光标/诊断只覆盖它时,会给出**第一个** receiver
的守卫(把第一个的修复套给第二个)。已修:新增 `receiverFromDiagnosticLine`,从诊断自身的
方法名区间(与 `self.<receiver>.<方法>` 的方法名 token 相交)归属提取;区间内定位不到
则不猜、不出。`tests/receiverNoneGuardQuickFix.test.ts` +4 例(cell/base 各守各、双诊断
整行 4 动作、别名/错位不出)。

## 已知边界(如实)

- 早退守卫插入在**同行混双 receiver** 的语句前,会整行跳过(当该 receiver 为 None 时该
  行其余调用也不执行)——包裹式(首选)不会;这是行级守卫插入的固有语义,用户选早退式即
  接受此控制流,不在本次「跨 receiver 误套」范围内。
- 别名调用(`peer = self.cell; peer.foo()`)的快速修复不出(区间内无 `self.<receiver>.`,
  不猜)——与「诊断行提取不出接收者不出」既有口径一致。
