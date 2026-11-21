/**
 * EXEC-008 固定扩展完整调试链 真机验收(--exec008):真实 VS Code(由
 * runTest.ts 的 test-electron 拉起)+ 固定调试器扩展目录
 * (ms-python.debugpy@2024.0.0 + ms-python.python@2024.0.1)+ 目标解释器
 * (Python 3.7.x + debugpy 1.7.0 listen + wait_for_client)。驱动面=vscode.debug
 * API(等价 F5),真实调试器=固定扩展的 bundled debugpy adapter;断言全链:
 * 断点(预置,VS Code 在 initialized 窗口下发)→startDebugging(attach)→DAP
 * 'stopped'(reason=breakpoint,行 9)→stackTrace 顶帧→scopes/evaluate(a==21,
 * b 未定义)→next(单步)→'stopped'(行 10)→evaluate(b==20)→disconnect(断连)。
 *
 * 协议要点(排障实测定):debugpy 的 attach 响应延后到 configurationDone 之后,
 * 且目标在 configurationDone 后自行恢复运行到断点——断点必须在 initialized
 * 窗口(setBreakpoints 阶段)由 VS Code 下发,不能等 startDebugging 返回后再
 * setBreakpoints/continue,否则对已运行目标 1.7.0 不回 stopped(实测 run3 挂
 * 死根因)。故本套件用 vscode.debug.addBreakpoints 在 startDebugging 之前预置。
 *
 * 目标进程须已在本机 listen(:5678),工作区=KODE_EXEC008_WORKSPACE(含
 * entity_debug.py),证据出=KODE_EXEC008_OUT。目标不可达/断点未命中/单步
 * 未至 10 行时如实红。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import * as assert from 'assert';

const evidenceOut = process.env.KODE_EXEC008_OUT
  ?? path.resolve(__dirname, '../../../..', 'docs/acceptance-evidence/evidence/EXEC-008-fixed-extension-chain.log');

function ev(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
    fs.appendFileSync(evidenceOut, `${stamped}\n`);
  } catch (error) {
    console.error('证据落盘失败:', error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 等待下一个 DAP 'stopped' 事件。注意:onDidReceiveDebugSessionCustomEvent
 * 只转发「自定义」事件,标准 DAP 事件(stopped/output…)被 VS Code 消费后
 * 不会到达该 API(dbglive 同坑),必须走 registerDebugAdapterTrackerFactory
 * 的 onDidSendMessage 才能看到 adapter → VS Code 的全部 DAP 消息。 */
class StoppedWaiter {
  private pending: { resolve: (b: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null;
  private disp: vscode.Disposable;
  constructor() {
    this.disp = vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
      createDebugAdapterTracker: (): vscode.DebugAdapterTracker => ({
        onDidSendMessage: (message: Record<string, unknown>): void => {
          if (message.type !== 'event' || message.event !== 'stopped' || !this.pending) {
            return;
          }
          const p = this.pending;
          this.pending = null;
          p.resolve((message.body ?? {}) as Record<string, unknown>);
        }
      })
    });
  }
  wait(ms = 90000): Promise<Record<string, unknown>> {
    if (this.pending) {
      this.pending.reject(new Error('previous waiter not consumed'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('timeout waiting stopped event'));
      }, ms);
      this.pending = {
        resolve: b => { clearTimeout(timer); resolve(b); },
        reject: e => { clearTimeout(timer); reject(e); }
      };
    });
  }
  dispose(): void { this.disp.dispose(); }
}

describe('EXEC-008 fixed extension full debug chain', function () {
  this.timeout(300000);
  const waiter = new StoppedWaiter();
  after(() => waiter.dispose());

  before(async () => {
    ev(`HOST: ${vscode.env.appName || 'vscode'} ${vscode.version || ''}`);
    const ws = vscode.workspace.workspaceFolders?.[0];
    ev(`WORKSPACE: ${ws?.uri.fsPath ?? '(none)'}`);
  });

  it('breakpoint -> connect -> stop -> step -> variables -> disconnect', async function () {
    const ws = vscode.workspace.workspaceFolders?.[0];
    assert.ok(ws, 'workspace folder present');
    const uri = vscode.Uri.file(path.join(ws.uri.fsPath, 'entity_debug.py'));

    // 1. 预置断点(行 9 b=delta*2):VS Code 会在 initialized 窗口(setBreakpoints
    //    阶段)把工作区断点下发给 adapter,目标 configurationDone 后恢复运行
    //    即自动命中——不能等 startDebugging 返回后再设(实测对已运行目标不回)。
    await vscode.debug.addBreakpoints([new vscode.SourceBreakpoint({
      uri, range: new vscode.Range(8, 0, 8, 0)
    })]);
    ev(`BREAKPOINT-ADD: workspace=${(vscode.debug.breakpoints ?? []).length}`);

    // 2. 先挂好 stopped 等待器再 startDebugging(防竞态)
    const stopP = waiter.wait();

    // 3. connect (startDebugging == F5 path)
    //    python: 钉死 adapter 解释器。debugpy adapter 本身是 Python 进程
    //    (扩展 bundled 的 debugpy 1.7.0 经 PYTHONPATH 提供),不钉的话 ms-python
    //    会走自动解释器发现,空工作区下可能弹「选择解释器」quickpick 在
    //    headless/xvfb 永不关闭 → startDebugging 挂死;钉 3.7 与目标同构。
    const cfg = {
      name: 'KBEngine Py37 attach',
      type: 'debugpy',
      request: 'attach',
      connect: { host: '127.0.0.1', port: 5678 },
      python: '/usr/bin/python3.7',
      justMyCode: false,
      logToFile: true,
      trace: 'verbose'
    };
    const ok = await vscode.debug.startDebugging(ws, cfg);
    assert.strictEqual(ok, true, 'startDebugging returned true');
    const activeSession = vscode.debug.activeDebugSession;
    assert.ok(activeSession, 'active debug session exists');
    const session: vscode.DebugSession = activeSession;
    ev(`CONNECT: startDebugging ok session=${session.id} type=${session.type} name=${session.name}`);

    // 4. 目标 configurationDone 后自行恢复运行 → 命中行 9
    const stopped = await stopP as { reason: string; threadId: number };
    ev(`BREAKPOINT-HIT: reason=${stopped.reason} threadId=${stopped.threadId}`);
    assert.strictEqual(stopped.reason, 'breakpoint', 'stopped reason is breakpoint');

    // 5. stackTrace 顶帧(行号从帧取,DAP stopped 事件不带 line)
    const st = await session.customRequest('stackTrace', {
      threadId: stopped.threadId, startFrame: 0, levels: 1
    }) as { stackFrames: Array<{ name: string; line: number; id: number }> };
    const top = st.stackFrames[0];
    ev(`STACK: top=${top.name} line=${top.line} frameId=${top.id}`);
    assert.ok(top.name.includes('onEnterWorld'), 'top frame is onEnterWorld');
    assert.strictEqual(top.line, 9, 'top frame at line 9');

    // 6. variables: scopes + evaluate a / b(行 9 b 未定义)
    const scopes = await session.customRequest('scopes', { frameId: top.id }) as {
      scopes: Array<{ name: string; variablesReference: number }>
    };
    ev(`SCOPES: ${scopes.scopes.map(s => s.name).join(',')}`);
    const aEval = await session.customRequest('evaluate', {
      expression: 'a', frameId: top.id, context: 'watch'
    }) as { result: string };
    ev(`EVAL-a: ${aEval.result}`);
    assert.strictEqual(aEval.result, '21', 'a == 21 at line 9');
    try {
      const bPre = await session.customRequest('evaluate', {
        expression: 'b', frameId: top.id, context: 'watch'
      }) as { result: string };
      ev(`EVAL-b-before-step: ${bPre.result}`);
    } catch (error) {
      ev(`EVAL-b-before-step: <error ${(error as Error).message}> (b undefined at line 9 is correct)`);
    }
    const localScope = scopes.scopes.find(s => /local/i.test(s.name)) || scopes.scopes[0];
    const vars = await session.customRequest('variables', {
      variablesReference: localScope.variablesReference
    }) as { variables: Array<{ name: string; value: string }> };
    ev(`VARIABLES[${localScope.name}]: ${vars.variables.map(v => `${v.name}=${v.value}`).join(', ')}`);

    // 7. 单步(next,threadId 必须给)→ 行 10
    const stepP = waiter.wait();
    await session.customRequest('next', { threadId: stopped.threadId });
    ev('STEP: next issued');
    const stopped2 = await stepP as { reason: string; line: number; threadId: number };
    ev(`STEP-STOP: reason=${stopped2.reason} line=${stopped2.line}`);
    const st2 = await session.customRequest('stackTrace', {
      threadId: stopped2.threadId, startFrame: 0, levels: 1
    }) as { stackFrames: Array<{ name: string; line: number; id: number }> };
    const top2 = st2.stackFrames[0];
    const bEval = await session.customRequest('evaluate', {
      expression: 'b', frameId: top2.id, context: 'watch'
    }) as { result: string };
    ev(`EVAL-b-after-step: ${bEval.result} (line ${top2.line})`);
    // tick(1) → delta=1 → b=delta*2=2(行 10 return a,b 前 b 已赋值)
    assert.strictEqual(bEval.result, '2', 'b == 2 after step (delta=1, b=delta*2)');
    assert.strictEqual(top2.line, 10, 'stopped at line 10 after step');

    // 8. disconnect
    await session.customRequest('disconnect', { restart: false });
    ev('DISCONNECT: issued');
    await sleep(1200);
    ev('CHAIN-DONE: breakpoint/connect/stop/step/variables/disconnect all asserted');
  });
});
