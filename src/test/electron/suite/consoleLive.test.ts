/**
 * KB-GC-001 真机联验套件(--live):guiconsole console 链期一对一台真实运行
 * 的 KBEngine 逐项取证(全部走生产实现,与 IDE-LIV-003..007 同款纪律):
 * ① machined 广播发现 → 真实组件台账(pid/cpu/mem/usedmem/state 随回包自带);
 * ② ConsoleLogTailController 对真实 logger 702 注册 → 65501 推流采集,
 *    logstream 结构化解析(级别/组件/时间戳)逐行落证据;
 * ③ ComponentStatusTreeProvider 面板行 = 台账逐组件(异常态红色标记核对);
 * ④ 真实 UI 取证hold:打开扩展自身的 tail Output 通道与 componentStatus
 *    侧栏视图,供外层截图(截图由套件外部的 X 显示捕获完成,不入断言)。
 * 引擎不可达/无日志推流时如实记「未测」,不冒充已联验。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import * as assert from 'assert';
import {
  type KBEngineComponentInfo
} from '../../../kbengineProtocol';
import { parseExceptionSourceLocation, resolveExceptionSource } from '../../../exceptionSourceLocator';
import { ConsoleHub } from '../../../kbengineConsoleHub';
import { ConsoleLogTailController } from '../../../consoleLogTail';
import { ComponentStatusTreeProvider, describeComponentRow, resolveThresholds } from '../../../componentStatusPanel';

const evidenceLines: string[] = [];
const evidenceOut = process.env.KODE_GC_EVIDENCE_OUT
  ?? path.resolve(__dirname, '../../../docs/acceptance-evidence/evidence/KB-GC-001-live-run.txt');
const discoveryHost = process.env.KODE_LIV_DISCOVERY_HOST ?? '255.255.255.255';
const collectTimeoutMs = Number(process.env.KODE_GC_COLLECT_MS ?? 25000);
const uiHoldMs = Number(process.env.KODE_GC_HOLD_MS ?? 12000);

const log = (line: string): void => {
  evidenceLines.push(line);
  console.log(line);
};

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

let hub: ConsoleHub | null = null;
let components: KBEngineComponentInfo[] = [];

before(async function (this: { timeout(ms: number): void }) {
  this.timeout(30000);
  log(`KB-GC-001 live run @ ${new Date().toISOString()} discovery=${discoveryHost}`);
  hub = new ConsoleHub({
    discovery: { host: discoveryHost, timeoutMs: 3000 },
    pollIntervalMs: 5000
  });
  await hub.pollOnce();
  components = hub.getComponents();
  log(`[GC-1] discovery -> ${components.length} components, machined=${hub.getMachinedState()}`);
  for (const component of components) {
    log(
      `[GC-1]   ${component.fullName} type=${component.componentType} id=${component.componentID} ` +
      `pid=${component.pid} ${component.intaddr}:${component.intport} cpu=${component.cpu.toFixed(2)} ` +
      `mem=${component.mem.toFixed(1)} usedmem=${component.usedmem} state=${component.state} uid=${component.uid}`
    );
  }
});

after(function () {
  fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
  fs.writeFileSync(evidenceOut, evidenceLines.join('\n') + '\n');
  log(`[evidence] written -> ${evidenceOut}`);
  hub?.dispose();
});

describe('KB-GC-001 machined discovery (real engine)', () => {
  it('discovers live components with load snapshot fields', () => {
    if (components.length === 0) {
      log('[GC-1] 未测:machined 无应答,发现面本轮未联验');
      return;
    }
    assert.ok(components.length > 0, 'machined discovery returned zero components');
    const logger = components.find(component => component.componentType === 10);
    assert.ok(logger, 'logger component missing from discovery');
    assert.ok(logger!.pid > 0 && logger!.intport > 0, 'logger identity fields missing');
    log(`[GC-1] verdict: reachable, logger=${logger!.fullName} ${logger!.intaddr}:${logger!.intport}`);
  });
});

describe('KB-GC-001 live log tail (702 → 65501 push stream)', () => {
  const output = { lines: [] as string[], shown: false };
  let controller: ConsoleLogTailController | null = null;

  before(function (this: { timeout(ms: number): void }) {
    this.timeout(20000);
    if (!hub || components.length === 0) {
      return;
    }
    controller = new ConsoleLogTailController({
      hub,
      workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      // IDE-LIV-007 同源落点解析
      resolveSource: (roots, location) => resolveExceptionSource(roots, location),
      output: {
        appendLine: line => {
          output.lines.push(line);
        },
        show: () => {
          output.shown = true;
        }
      },
      statusItem: { text: '', show: () => undefined, hide: () => undefined },
      // 配置访问器形态与生产同:每次重读,不是激活期快照
      getConfig: () => ({ enabled: true, components: [] }),
      tickIntervalMs: 10000
    });
    controller.start();
  });

  after(() => {
    controller?.dispose();
    controller = null;
  });

  it('receives real 65501 log lines and parses their structure', async function (this: { timeout(ms: number): void }) {
    this.timeout(collectTimeoutMs + 15000);
    if (!controller || components.length === 0) {
      log('[GC-2] 未测:machined 不可达,tail 面本轮未联验');
      return;
    }
    const deadline = Date.now() + collectTimeoutMs;
    while (Date.now() < deadline && output.lines.filter(line => !line.startsWith('KBEngine console log tail:')).length < 5) {
      await wait(500);
    }
    const logLines: string[] = output.lines.filter(line => !line.startsWith('KBEngine console log tail:'));
    log(`[GC-2] controller state=${controller.getState()} received=${logLines.length} lines`);
    assert.ok(controller.getState() === 'connected', `tail not connected: ${controller.getState()}`);
    assert.ok(logLines.length >= 5, `expected >=5 live log lines, got ${logLines.length}`);

    // 断言面 = formatTailLine 的生产输出契约(时间戳 [级别] 组件实例: 消息);
    // logstream 原始形态的真机取证见 scripts/kb-gc-live-probe.cjs 证据文件
    const formattedShape =
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \d{3} \[([A-Z_ ]+|UNKNOWN|PRINT|ERROR|WARNING|DEBUG|INFO|CRITICAL|S_INFO|S_ERR|S_DBG|S_WARN|S_NORM)\] [a-z]+\d{2}: /;
    let structuredCount = 0;
    for (const [index, line] of logLines.slice(0, 12).entries()) {
      const matched = formattedShape.test(line);
      if (matched) {
        structuredCount += 1;
      }
      log(`[GC-2] #${index + 1} ${matched ? 'STRUCTURED' : 'UNSTRUCTURED'} :: ${line.split('\n')[0].slice(0, 110)}`);
    }
    log(`[GC-2] structured-parse verdict: ${structuredCount}/${Math.min(logLines.length, 12)} lines carry the formatted logstream shape`);
    assert.ok(structuredCount >= 5, 'structured logstream parse failed on live lines');

    // 错误行跳转面:真实错误级行出现时核对落点解析;本轮无错误行则如实记未测
    const errorLines = logLines.filter(line => /\[(ERROR|S_ERR|CRITICAL)\]/.test(line));
    if (errorLines.length > 0) {
      const withLocation = errorLines.map(line => parseExceptionSourceLocation(line)).filter(Boolean);
      log(`[GC-2] jump-face: ${errorLines.length} error lines, ${withLocation.length} with parseable file:line`);
    } else {
      log('[GC-2] jump-face 未测:本轮推流无错误级行(解析/落点面由单测覆盖)');
    }
  });

  it('reveals the real extension tail output channel for UI capture', async function (this: { timeout(ms: number): void }) {
    this.timeout(uiHoldMs + 15000);
    if (components.length === 0) {
      return;
    }
    // 生产面证据:扩展自身装配的通道与命令(非套件私有替身)
    await vscode.commands.executeCommand('kbengine.consoleLogTail.show');
    log('[GC-4] tail output channel revealed (real extension surface); holding for screenshot capture');
    await wait(uiHoldMs);
  });
});

describe('KB-GC-001 component status panel (real component table)', () => {
  it('renders one row per live component with load fields', async function (this: { timeout(ms: number): void }) {
    this.timeout(uiHoldMs + 20000);
    if (!hub || components.length === 0) {
      log('[GC-3] 未测:machined 不可达,面板面本轮未联验');
      return;
    }
    const thresholds = resolveThresholds(() => undefined);
    const rows = components.map(component => describeComponentRow(component, thresholds));
    assert.strictEqual(rows.length, components.length);
    for (const row of rows) {
      log(`[GC-3] ${row.label} :: ${row.description} :: ${row.abnormal ? `ABNORMAL(${row.reasons.join(';')})` : 'normal'}`);
    }
    log(`[GC-3] verdict: ${rows.length} rows rendered, ${rows.filter(row => row.abnormal).length} abnormal-marked`);

    // 真实侧栏视图取证:生产 provider + 生产命令,外层截图捕获
    const provider = new ComponentStatusTreeProvider(hub, () => thresholds);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, components.length);
    await provider.refresh();
    try {
      await vscode.commands.executeCommand('kbengine.componentStatus.focus');
      log('[GC-4] componentStatus view focused (real extension surface); holding for screenshot capture');
      await wait(uiHoldMs);
    } finally {
      provider.dispose();
    }
  });
});
