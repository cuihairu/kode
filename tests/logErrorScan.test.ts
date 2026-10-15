import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_SCAN_MAX_FILE_BYTES,
  ERROR_SCAN_MAX_SIGNATURE_LENGTH,
  LOG_ERROR_SCAN_PANEL_TITLE,
  LOG_ERROR_SCAN_VIEW_TYPE,
  LogErrorScanView,
  RAW_LOG_ENTRY_KIND_DIRECTORY,
  RAW_LOG_ENTRY_KIND_FILE,
  collectScanTargets,
  isScannableLogFileName,
  normalizeErrorSignature,
  realLogErrorScanDeps,
  runLogErrorScanCommand,
  scanRawLogFileContent,
  scanRawLogErrors
} from '../src/logErrorScan';
import type { LogErrorScanDeps, RawErrorHit, RawLogScanReport } from '../src/logErrorScan';
import { LogLevel } from '../src/logParser';
import {
  memoryFileSystem,
  messages,
  panelRegistry,
  Uri,
  ViewColumn,
  windowState
} from './helpers/vscodeStub';

// G6 原始日志 ERROR 扫描:纯层(签名归一/单文件聚合/目标收集/整批扫描)
// 用注入 deps 驱动;视图层经 panelRegistry 假面板驱动消息两通道;命令层
// 用脚本化 pickFiles 走取消/空选/成功三臂;real deps 对着 memoryFileSystem
// 走真实现(fake fs 的 stat/readFile/readDirectory)。

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const FILE_A = Uri.file('/mem/logs/server.log');

// logger 线格式(ERROR/S_ERR 各一,INFO/WARNING 不进聚合);三列数字与
// logParser 的线格式正则对齐(参考 tests/logParser.test.ts 的同源样例)
const WIRE_ERROR =
  '   ERROR dbmgr01 1000 2000 30000 [2026-03-26 18:21:11 001] - saveAvatar(1001) failed: not found';
const WIRE_ERROR_2 =
  '   ERROR dbmgr01 1000 2000 30001 [2026-03-26 18:22:15 002] - saveAvatar(2002) failed: not found';
const WIRE_S_ERR =
  "   S_ERR cellapp01 1000 2000 30002 [2026-03-26 18:22:16 003] - Avatar::onTimer KeyError 'hp'";
const WIRE_INFO =
  '   INFO dbmgr01 1000 2000 30003 [2026-03-26 18:23:01 004] - normal line';
const WIRE_WARN =
  '   WARN baseapp01 1000 2000 30004 [2026-03-26 18:25:30 005] - slow query 1234ms';
// 标准格式(同签名 ERROR→CRITICAL 合并;时间取解析值)
const STD_ERROR = '[2026-03-26 18:23:00][ERROR][cellapp] loadBalance failed';
const STD_CRITICAL = '[2026-03-26 18:24:00][CRITICAL][cellapp] loadBalance failed';
// 非标准启发式(含 failed → ERROR;无时间戳,时间记 null)
const NONSTD = 'cellapp: loadBalance failed';

const FILE_A_CONTENT = [
  STD_ERROR,
  STD_CRITICAL,
  WIRE_ERROR,
  WIRE_ERROR_2,
  WIRE_S_ERR,
  WIRE_INFO,
  WIRE_WARN,
  '',
  '   ',
  NONSTD,
  NONSTD
].join('\n');

interface ScriptedDepsOptions {
  stats?: Map<string, { size: number; type: number }>;
  directories?: Map<string, Array<[string, number]>>;
  files?: Map<string, Uint8Array>;
  /** 指定路径的 readFile 按给定值抛出(含非 Error,覆盖 String 落报错分支) */
  readErrors?: Map<string, unknown>;
}

const depsOf = (options: ScriptedDepsOptions = {}): LogErrorScanDeps => ({
  stat: async (uri: vscode.Uri) => {
    const stat = options.stats?.get(uri.fsPath);
    if (stat === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`);
    }
    return stat;
  },
  readDirectory: async (uri: vscode.Uri) => {
    const entries = options.directories?.get(uri.fsPath);
    if (entries === undefined) {
      throw new Error(`ENOENT dir: ${uri.fsPath}`);
    }
    return entries;
  },
  readFile: async (uri: vscode.Uri) => {
    const thrown = options.readErrors?.get(uri.fsPath);
    if (thrown !== undefined) {
      throw thrown;
    }
    const data = options.files?.get(uri.fsPath);
    if (data === undefined) {
      throw new Error(`ENOENT file: ${uri.fsPath}`);
    }
    return data;
  }
});

const makeContext = (): vscode.ExtensionContext =>
  ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

const internals = (view: LogErrorScanView) =>
  view as unknown as {
    report: RawLogScanReport | null;
    handleMessage(message: unknown): Promise<void>;
  };

const emptyReport = (): RawLogScanReport => ({ files: [], hits: [], totalLines: 0, totalErrors: 0 });

beforeEach(() => {
  windowState.reset();
  memoryFileSystem.reset();
  panelRegistry.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeErrorSignature', () => {
  it('折叠数字串、压缩空白并去首尾', () => {
    expect(normalizeErrorSignature('  saveAvatar(1001) failed:   not\tfound  ')).toBe(
      'saveAvatar(N) failed: not found'
    );
  });

  it(`超长签名截到 ${ERROR_SCAN_MAX_SIGNATURE_LENGTH} 字符`, () => {
    const signature = normalizeErrorSignature('x'.repeat(ERROR_SCAN_MAX_SIGNATURE_LENGTH + 40));
    expect(signature.length).toBe(ERROR_SCAN_MAX_SIGNATURE_LENGTH);
  });
});

describe('isScannableLogFileName', () => {
  it('收 .log/.txt/.out(大小写不敏感),其余不收', () => {
    expect(isScannableLogFileName('server.log')).toBe(true);
    expect(isScannableLogFileName('SERVER.LOG')).toBe(true);
    expect(isScannableLogFileName('notes.txt')).toBe(true);
    expect(isScannableLogFileName('run.out')).toBe(true);
    expect(isScannableLogFileName('notes.md')).toBe(false);
    expect(isScannableLogFileName('serverlog')).toBe(false);
  });
});

describe('scanRawLogFileContent', () => {
  it('按签名聚合 ERROR/CRITICAL,时间戳按行内有无分别记录', () => {
    const hits = new Map();
    const { lineCount, errorCount } = scanRawLogFileContent(FILE_A_CONTENT, FILE_A, hits);

    expect(lineCount).toBe(9);
    expect(errorCount).toBe(7);

    const loadBalance = hits.get(`cellapp\nloadBalance failed`)!;
    expect(loadBalance.count).toBe(2);
    expect(loadBalance.level).toBe(LogLevel.CRITICAL);
    expect(loadBalance.firstTime).toBe(new Date(2026, 2, 26, 18, 23, 0, 0).getTime());
    expect(loadBalance.lastTime).toBe(new Date(2026, 2, 26, 18, 24, 0, 0).getTime());
    expect(loadBalance.firstLine).toBe(1);
    expect(loadBalance.firstFile).toBe(FILE_A.fsPath);
    expect(loadBalance.lastRaw).toBe(STD_CRITICAL);

    const saveAvatar = hits.get(`dbmgr\nsaveAvatar(N) failed: not found`)!;
    expect(saveAvatar.count).toBe(2);
    expect(saveAvatar.level).toBe(LogLevel.ERROR);
    expect(saveAvatar.firstTime).toBe(new Date(2026, 2, 26, 18, 21, 11, 1).getTime());
    expect(saveAvatar.lastTime).toBe(new Date(2026, 2, 26, 18, 22, 15, 2).getTime());

    const scriptError = hits.get(`cellapp\nAvatar::onTimer KeyError 'hp'`)!;
    expect(scriptError.count).toBe(1);
    expect(scriptError.level).toBe(LogLevel.ERROR);

    const nonStandard = hits.get(`cellapp\ncellapp: loadBalance failed`)!;
    expect(nonStandard.count).toBe(2);
    expect(nonStandard.firstTime).toBeNull();
    expect(nonStandard.lastTime).toBeNull();
    expect(nonStandard.firstLine).toBe(10);

    expect(hits.size).toBe(4);
  });

  it('CRITICAL 在前 ERROR 在后不降级已合并级别', () => {
    const hits = new Map();
    scanRawLogFileContent(
      '[2026-03-26 18:30:00][CRITICAL][baseapp] out of memory\n' +
        '[2026-03-26 18:31:00][ERROR][baseapp] out of memory',
      FILE_A,
      hits
    );
    const hit = hits.get('baseapp\nout of memory')!;
    expect(hit.count).toBe(2);
    expect(hit.level).toBe(LogLevel.CRITICAL);
    expect(hit.lastTime).toBe(new Date(2026, 2, 26, 18, 31, 0, 0).getTime());
  });
});

describe('collectScanTargets', () => {
  it('文件直通且按路径去重;显式选中的文件不查扩展名', async () => {
    const deps = depsOf({
      stats: new Map([
        ['/mem/run.md', { size: 10, type: RAW_LOG_ENTRY_KIND_FILE }],
        [FILE_A.fsPath, { size: 10, type: RAW_LOG_ENTRY_KIND_FILE }]
      ])
    });

    const targets = await collectScanTargets([Uri.file('/mem/run.md'), FILE_A, FILE_A], deps);
    expect(targets.map(uri => uri.fsPath)).toEqual(['/mem/run.md', FILE_A.fsPath]);
  });

  it('文件夹只收一层可扫文件并按名排序;目录项与不可扫项跳过', async () => {
    const deps = depsOf({
      stats: new Map([['/mem/logs', { size: 0, type: RAW_LOG_ENTRY_KIND_DIRECTORY }]]),
      directories: new Map([
        [
          '/mem/logs',
          [
            ['b.log', RAW_LOG_ENTRY_KIND_FILE],
            ['a.LOG', RAW_LOG_ENTRY_KIND_FILE],
            ['notes.md', RAW_LOG_ENTRY_KIND_FILE],
            ['sub', RAW_LOG_ENTRY_KIND_DIRECTORY]
          ] as Array<[string, number]>
        ]
      ])
    });

    const targets = await collectScanTargets([Uri.file('/mem/logs')], deps);
    expect(targets.map(uri => uri.fsPath)).toEqual(['/mem/logs/a.LOG', '/mem/logs/b.log']);
  });

  it('stat 失败与 readDirectory 失败的项静默跳过', async () => {
    const deps = depsOf({
      stats: new Map([
        ['/mem/logs', { size: 0, type: RAW_LOG_ENTRY_KIND_DIRECTORY }],
        [FILE_A.fsPath, { size: 10, type: RAW_LOG_ENTRY_KIND_FILE }]
      ])
      // '/mem/logs' 未登记 directories → readDirectory 抛错
    });

    const targets = await collectScanTargets(
      [Uri.file('/mem/logs'), Uri.file('/mem/vanished.log'), FILE_A],
      deps
    );
    expect(targets.map(uri => uri.fsPath)).toEqual([FILE_A.fsPath]);
  });
});

describe('scanRawLogErrors', () => {
  it('整批扫描出文件报告与按计数降序的命中表', async () => {
    const fileB = Uri.file('/mem/logs/baseapp.log');
    const deps = depsOf({
      stats: new Map([
        [FILE_A.fsPath, { size: 0, type: RAW_LOG_ENTRY_KIND_FILE }],
        [fileB.fsPath, { size: 0, type: RAW_LOG_ENTRY_KIND_FILE }]
      ]),
      files: new Map([
        [FILE_A.fsPath, Buffer.from(FILE_A_CONTENT, 'utf8')],
        [
          fileB.fsPath,
          Buffer.from(
            '[2026-03-26 18:30:00][CRITICAL][baseapp] out of memory\n' +
              '[2026-03-26 18:31:00][ERROR][baseapp] out of memory',
            'utf8'
          )
        ]
      ])
    });

    const report = await scanRawLogErrors([FILE_A, fileB], deps);

    expect(report.files.map(file => file.name)).toEqual(['server.log', 'baseapp.log']);
    expect(report.files.every(file => file.readError === null)).toBe(true);
    expect(report.files[0]).toMatchObject({ lineCount: 9, errorCount: 7 });
    expect(report.files[1]).toMatchObject({ lineCount: 2, errorCount: 2 });
    expect(report.totalLines).toBe(11);
    expect(report.totalErrors).toBe(9);
    // 计数降序,同计数按签名升序(比较器两臂都走到)
    expect(report.hits.map(hit => hit.count)).toEqual([2, 2, 2, 2, 1]);
    expect(report.hits.map(hit => hit.signature)).toEqual([
      'cellapp: loadBalance failed',
      'loadBalance failed',
      'out of memory',
      'saveAvatar(N) failed: not found',
      "Avatar::onTimer KeyError 'hp'"
    ]);
  });

  it('超上限文件与读取失败文件记入 readError,不中断其余文件', async () => {
    const bigFile = Uri.file('/mem/logs/big.log');
    const badFile = Uri.file('/mem/logs/bad.log');
    const stringBad = Uri.file('/mem/logs/stringbad.log');
    const deps = depsOf({
      stats: new Map([
        [FILE_A.fsPath, { size: 8, type: RAW_LOG_ENTRY_KIND_FILE }],
        [bigFile.fsPath, { size: ERROR_SCAN_MAX_FILE_BYTES + 1, type: RAW_LOG_ENTRY_KIND_FILE }],
        [badFile.fsPath, { size: 8, type: RAW_LOG_ENTRY_KIND_FILE }],
        [stringBad.fsPath, { size: 8, type: RAW_LOG_ENTRY_KIND_FILE }]
      ]),
      files: new Map([[FILE_A.fsPath, Buffer.from(WIRE_ERROR, 'utf8')]]),
      readErrors: new Map([[stringBad.fsPath, 'boom']])
    });

    const report = await scanRawLogErrors([FILE_A, bigFile, badFile, stringBad], deps);

    expect(report.files[0]).toMatchObject({ name: 'server.log', lineCount: 1, errorCount: 1, readError: null });
    expect(report.files[1].readError).toContain('64MB');
    expect(report.files[1].readError).toContain(String(ERROR_SCAN_MAX_FILE_BYTES + 1));
    expect(report.files[2].readError).toContain('ENOENT file');
    // readFile 抛字符串时按 String 落报错信息
    expect(report.files[3].readError).toBe('boom');
    expect(report.hits).toHaveLength(1);
    expect(report.totalErrors).toBe(1);
  });
});

describe('realLogErrorScanDeps(真实现对着 memoryFileSystem)', () => {
  it('stat/readDirectory/readFile 三面走通', async () => {
    memoryFileSystem.set(FILE_A.fsPath, WIRE_ERROR);
    memoryFileSystem.setDirectory('/mem/logs', [
      ['server.log', RAW_LOG_ENTRY_KIND_FILE],
      ['inner', RAW_LOG_ENTRY_KIND_DIRECTORY]
    ]);

    const stat = await realLogErrorScanDeps.stat(FILE_A);
    expect(stat).toEqual({ type: RAW_LOG_ENTRY_KIND_FILE, size: WIRE_ERROR.length });

    const entries = await realLogErrorScanDeps.readDirectory(Uri.file('/mem/logs'));
    expect(entries).toEqual([
      ['server.log', RAW_LOG_ENTRY_KIND_FILE],
      ['inner', RAW_LOG_ENTRY_KIND_DIRECTORY]
    ]);

    const bytes = await realLogErrorScanDeps.readFile(FILE_A);
    expect(Buffer.from(bytes).toString('utf8')).toBe(WIRE_ERROR);

    await expect(realLogErrorScanDeps.stat(Uri.file('/mem/logs/none.log'))).rejects.toThrow('ENOENT');
  });
});

describe('LogErrorScanView', () => {
  const reportOf = (): RawLogScanReport => {
    const inner = new Map<string, RawErrorHit>();
    scanRawLogFileContent(FILE_A_CONTENT, FILE_A, inner);
    scanRawLogFileContent(
      '[2026-03-26 18:30:00][CRITICAL][baseapp] out of memory',
      Uri.file('/mem/logs/baseapp.log'),
      inner
    );
    return {
      files: [
        { uri: FILE_A, name: 'server.log', lineCount: 9, errorCount: 7, readError: null },
        {
          uri: Uri.file('/mem/logs/bad.log'),
          name: 'bad.log',
          lineCount: 0,
          errorCount: 0,
          readError: 'boom & <gone>'
        }
      ],
      hits: [...inner.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)),
      totalLines: 9,
      totalErrors: 7
    };
  };

  it('show 建面板渲染汇总/文件/命中表,二次 show 复用并 reveal', () => {
    const view = new LogErrorScanView(makeContext(), async previous => previous);
    view.show(reportOf());

    expect(panelRegistry.panels).toHaveLength(1);
    const panel = panelRegistry.panels[0];
    expect(panel.viewType).toBe(LOG_ERROR_SCAN_VIEW_TYPE);
    expect(panel.title).toBe(LOG_ERROR_SCAN_PANEL_TITLE);
    expect(panel.showOptions).toBe(ViewColumn.Two);
    expect((panel.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(panel.webview.html).toContain('server.log');
    expect(panel.webview.html).toContain('saveAvatar(N) failed: not found');
    expect(panel.webview.html).toContain('level-critical');
    expect(panel.webview.html).toContain('level-error');
    expect(panel.webview.html).toContain('读取失败: boom &amp; &lt;gone&gt;');
    expect(panel.webview.html).toContain('—');

    view.show(emptyReport());
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.revealed).toBe(true);
    expect(panel.webview.html).toContain('未发现');
  });

  it('空命中渲染空态说明', () => {
    const view = new LogErrorScanView(makeContext(), async previous => previous);
    view.show({ files: [{ uri: FILE_A, name: 'server.log', lineCount: 3, errorCount: 0, readError: null }], hits: [], totalLines: 3, totalErrors: 0 });
    expect(panelRegistry.panels[0].webview.html).toContain('未发现 ERROR/CRITICAL 行');
  });

  it('rescan 消息回调上一份报告并重渲染', async () => {
    const seen: RawLogScanReport[] = [];
    const view = new LogErrorScanView(makeContext(), async previous => {
      seen.push(previous);
      return { files: [], hits: [], totalLines: 0, totalErrors: 0 };
    });
    const report = reportOf();
    view.show(report);
    panelRegistry.fireMessage(panelRegistry.panels[0], { command: 'rescan' });

    await until(() => seen.length === 1);
    expect(seen[0]).toBe(report);
    await until(() => panelRegistry.panels[0].webview.html.includes('未发现 ERROR/CRITICAL 行'));
  });

  it('未 show 过报告时 rescan 消息早退;残缺 open 消息无动作', async () => {
    const view = new LogErrorScanView(makeContext(), async previous => previous);
    const impl = internals(view);
    await impl.handleMessage({ command: 'rescan' });
    expect(impl.report).toBeNull();
    expect(panelRegistry.panels).toHaveLength(0);

    view.show(reportOf());
    await impl.handleMessage({ command: 'open' });
    await impl.handleMessage({ command: 'open', file: FILE_A.fsPath });
    await impl.handleMessage({ command: 'nonsense' });
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
  });

  it('open 消息走默认打开链(选区落在命中行)', async () => {
    const view = new LogErrorScanView(makeContext(), async previous => previous);
    view.show(reportOf());

    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'open',
      file: FILE_A.fsPath,
      line: 3
    });
    await until(() => windowState.showTextDocumentCalls.length > 0);

    const call = windowState.showTextDocumentCalls[0] as {
      options?: { selection?: { start: { line: number }; end: { line: number } } };
    };
    expect(call.options?.selection?.start.line).toBe(2);
    expect(call.options?.selection?.end.line).toBe(3);
  });

  it('openTarget 抛错时一次性弹错误窗', async () => {
    const view = new LogErrorScanView(
      makeContext(),
      async previous => previous,
      async () => {
        throw new Error('gone');
      }
    );
    view.show(reportOf());

    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'open',
      file: FILE_A.fsPath,
      line: 1
    });
    await until(() => messages.error.length > 0);
    expect(messages.error[0]).toContain('打开日志文件失败');
    expect(messages.error[0]).toContain('gone');
  });

  it('面板关闭后再 show 建新面板;dispose 拆面板', () => {
    const view = new LogErrorScanView(makeContext(), async previous => previous);
    view.show(reportOf());
    const first = panelRegistry.panels[0];
    panelRegistry.fireDispose(first);

    view.show(reportOf());
    expect(panelRegistry.panels).toHaveLength(2);

    view.dispose();
    expect(panelRegistry.panels[1].disposed).toBe(true);
  });
});

describe('runLogErrorScanCommand', () => {
  const makeView = (): LogErrorScanView => new LogErrorScanView(makeContext(), async previous => previous);

  it('对话框取消或空选不建面板', async () => {
    await runLogErrorScanCommand(makeView(), realLogErrorScanDeps, () => Promise.resolve(undefined));
    await runLogErrorScanCommand(makeView(), realLogErrorScanDeps, () => Promise.resolve([]));
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('所选位置没有可扫文件时只提示', async () => {
    memoryFileSystem.setDirectory('/mem/empty', []);
    await runLogErrorScanCommand(
      makeView(),
      realLogErrorScanDeps,
      () => Promise.resolve([Uri.file('/mem/empty')])
    );
    expect(panelRegistry.panels).toHaveLength(0);
    expect(messages.info.join('')).toContain('没有可扫描的日志文件');
  });

  it('选中文件扫描成聚合面板', async () => {
    memoryFileSystem.set(FILE_A.fsPath, FILE_A_CONTENT);
    await runLogErrorScanCommand(
      makeView(),
      realLogErrorScanDeps,
      () => Promise.resolve([FILE_A])
    );

    expect(panelRegistry.panels).toHaveLength(1);
    const html = panelRegistry.panels[0].webview.html;
    expect(html).toContain('server.log');
    expect(html).toContain('saveAvatar(N) failed: not found');
    expect(html).toContain('9 行');
  });
});
