import * as crypto from 'crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  computeDefFingerprintSnapshot,
  defaultDefFingerprintDeps,
  DEF_FINGERPRINT_INSPECTOR_COMMAND,
  renderFingerprintChangeLine,
  renderInspectorHtml,
  renderFingerprintReport,
  setupDefFingerprintInspector,
  type DefFingerprintDeps
} from '../src/defFingerprintInspector';
import { hashDefContent } from '../src/backend/hotReloadDefHash';
import { semanticFingerprintReport } from '../src/backend/hotReloadDefStructure';
import { resolveFingerprintProfile } from '../src/backend/hotReloadFingerprintCompare';
import { messages, panelRegistry, windowState } from './helpers/vscodeStub';
import { workspaceEvents } from './fake-vscode/workspaceState';

// HR-HASH-007/008 接线装配钉:Inspector 命令(活动编辑器须 .def;快照三值+
// 算法档案如实 not available+读面来源+复制按钮)+ 保存触发三路判定(首见只
// 存底;字节变语义不变如实分路;非 .def 保存过滤;不可读不崩)。命令与保存
// 共用同一台账(命令首存后保存即出判定行)。闭包 MD5 面为另账转显。

const DEF_A = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINT32 </Type>',
  '      <Flags> CELL_PUBLIC </Flags>',
  '      <Default> 100 </Default>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 同结构、字节不同(行内多一空格):file 有变化 / semantic 无变化
const DEF_A_WHITESPACE = DEF_A.replace('<Type> UINT32 </Type>', '<Type>  UINT32  </Type>');

// 结构变(加属性):两路皆有变化
const DEF_A_STRUCTURAL = DEF_A.replace('</Properties>', '    <level>\n      <Type> UINT16 </Type>\n    </level>\n  </Properties>');

const DEF_PATH = '/ws/entities/avatar.def';
const PY_PATH = '/ws/scripts/avatar.py';
const FIXED_NOW = 1700000000000;

const makeDeps = (contents: Record<string, string>, opts: { md5Check?: null } = {}): DefFingerprintDeps => ({
  readSnapshot: fsPath =>
    fsPath in contents
      ? { content: contents[fsPath], source: fsPath === PY_PATH ? 'disk' : 'document' }
      : null,
  now: () => FIXED_NOW,
  lastMd5Check: () => opts.md5Check === undefined
    ? { workspaceMd5: 'a'.repeat(32), handshake: { algorithm: 'md5', negotiated: true, digest: 'a'.repeat(32), reason: '测试' }, notes: [], stamps: [] }
    : null
});

const channelLines = (): string[] => windowState.channels[windowState.channels.length - 1]?.lines ?? [];

describe('defFingerprintInspector 装配(HR-HASH-007/008 接线批)', () => {
  const savedWindow = vscode.window as unknown as Record<string, unknown>;
  const savedEnv = vscode.env as unknown as Record<string, unknown>;
  let clipboardCalls: string[] = [];

  beforeEach(() => {
    windowState.reset();
    panelRegistry.reset();
    delete savedWindow.activeTextEditor;
    delete savedEnv.clipboard;
    clipboardCalls = [];
  });

  afterEach(() => {
    delete savedWindow.activeTextEditor;
    delete savedEnv.clipboard;
  });

  const setup = (deps: DefFingerprintDeps): { conclusions: string[] } => {
    const conclusions: string[] = [];
    setupDefFingerprintInspector({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      deps,
      onConclusion: line => conclusions.push(line)
    });
    return { conclusions };
  };

  it('computeDefFingerprintSnapshot:三值+来源+计时;sha256 与 node crypto 对拍;读不到=null', () => {
    const deps = makeDeps({ [DEF_PATH]: DEF_A, [PY_PATH]: 'x = 1' });
    const snapshot = computeDefFingerprintSnapshot(deps, DEF_PATH);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.fileHash).toBe(hashDefContent(DEF_A).digest);
    expect(snapshot!.fileHash).toBe(crypto.createHash('sha256').update(DEF_A, 'utf8').digest('hex'));
    expect(snapshot!.byteLength).toBe(Buffer.byteLength(DEF_A, 'utf8'));
    expect(snapshot!.semanticHash).toBe(semanticFingerprintReport(DEF_A).hash);
    expect(snapshot!.semanticHash).not.toBeNull();
    expect(snapshot!.source).toBe('document');
    expect(snapshot!.at).toBe(FIXED_NOW);
    expect(snapshot!.durationMs).toBe(0);

    // 磁盘补载来源如实透传
    expect(computeDefFingerprintSnapshot(deps, PY_PATH)!.source).toBe('disk');
    // 双面皆无=null(不编快照)
    expect(computeDefFingerprintSnapshot(deps, '/ws/missing.def')).toBeNull();
  });

  it('保存触发·首见:只存底出「首见」行,不伪造变更结论;台账有底', () => {
    const { conclusions } = setup(makeDeps({ [DEF_PATH]: DEF_A }));
    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    expect(conclusions).toEqual([`def 指纹首见(只存底): avatar.def`]);
    expect(channelLines()[0]).toContain('def 指纹首见(只存底): avatar.def');

    // 有底后第二次保存出判定行
    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    expect(conclusions[1]).toContain('file=无变化');
    expect(conclusions[1]).toContain('semantic=无变化');
    expect(conclusions[1]).toContain('applied=unknown');
    expect(conclusions[1]).not.toContain('首见');
  });

  it('保存触发·分路如实:空格改动 file=有变化/semantic=无变化;结构变两路有变化', () => {
    const contents: Record<string, string> = { [DEF_PATH]: DEF_A };
    const { conclusions } = setup(makeDeps(contents));

    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    contents[DEF_PATH] = DEF_A_WHITESPACE;
    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    expect(conclusions[1]).toContain('file=有变化');
    expect(conclusions[1]).toContain('semantic=无变化');

    contents[DEF_PATH] = DEF_A_STRUCTURAL;
    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    expect(conclusions[2]).toContain('file=有变化');
    expect(conclusions[2]).toContain('semantic=有变化');
  });

  it('非 .def 保存过滤;不可读保存静默不崩;非 .def 命令面给引导信息', () => {
    const { conclusions } = setup(makeDeps({ [DEF_PATH]: DEF_A, [PY_PATH]: 'x = 1' }));

    workspaceEvents.documentSaved.fire({ uri: { fsPath: PY_PATH } });
    expect(conclusions).toEqual([]);
    expect(channelLines()).toEqual([]);

    workspaceEvents.documentSaved.fire({ uri: { fsPath: '/ws/gone.def' } });
    expect(conclusions).toEqual([]);
  });

  it('命令·无活动编辑器:引导信息,不建面板不落通道', async () => {
    setup(makeDeps({ [DEF_PATH]: DEF_A }));
    await vscode.commands.executeCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND);
    expect(messages.info.some(text => text.includes('打开一个 .def 文件'))).toBe(true);
    expect(panelRegistry.panels).toHaveLength(0);
    expect(channelLines()).toEqual([]);
  });

  it('命令·.def 活动编辑器:面板+通道报告齐;html 载三值/规格/档案如实/来源;命令首存后保存即判定行', async () => {
    const deps = makeDeps({ [DEF_PATH]: DEF_A });
    const { conclusions } = setup(deps);
    savedWindow.activeTextEditor = { document: { uri: { fsPath: DEF_PATH } } };

    await vscode.commands.executeCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND);

    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(panel.title).toBe('def 指纹: avatar.def');
    expect(panel.webview.html).toContain('def 指纹详情');
    expect(panel.webview.html).toContain(hashDefContent(DEF_A).digest);
    expect(panel.webview.html).toContain('def-structural-fp/1');
    expect(panel.webview.html).toContain('not available');
    expect(panel.webview.html).toContain('打开缓冲区(VFS 已有字节复用)');
    // 闭包面另账转显(注入的最近核查结果)
    expect(panel.webview.html).toContain('a'.repeat(32));
    expect(panel.webview.html).toContain('另账');

    const lines = channelLines().join('\n');
    expect(lines).toContain(`def 指纹详情: ${DEF_PATH}`);
    expect(lines).toContain('fileHash (sha256)');
    expect(lines).toContain('算法档案(HR-HASH-006): not available');

    // 命令已存底 → 保存直接出判定行(不再首见)
    workspaceEvents.documentSaved.fire({ uri: { fsPath: DEF_PATH } });
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0]).toContain('def 指纹变更判定: avatar.def');
    expect(conclusions[0]).toContain('file=无变化');
  });

  it('命令·闭包面未核查:html 如实显「未运行引擎盖章核查」,不补算不冒充', async () => {
    setup(makeDeps({ [DEF_PATH]: DEF_A }, { md5Check: null }));
    savedWindow.activeTextEditor = { document: { uri: { fsPath: DEF_PATH } } };
    await vscode.commands.executeCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(panel.webview.html).toContain('未运行引擎盖章核查');
    expect(panel.webview.html).toContain('不随面板补算');
  });

  it('命令·文件不可读:如实说明,不建面板', async () => {
    setup(makeDeps({}));
    savedWindow.activeTextEditor = { document: { uri: { fsPath: '/ws/gone.def' } } };
    await vscode.commands.executeCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND);
    expect(messages.info.some(text => text.includes('文件不可读'))).toBe(true);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('面板复制按钮:postMessage 回装配落剪贴板', async () => {
    const written: string[] = [];
    savedEnv.clipboard = { writeText: async (value: string) => { written.push(value); } };
    setup(makeDeps({ [DEF_PATH]: DEF_A }));
    savedWindow.activeTextEditor = { document: { uri: { fsPath: DEF_PATH } } };
    await vscode.commands.executeCommand(DEF_FINGERPRINT_INSPECTOR_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    for (const listener of panel.messageListeners) {
      listener({ type: 'copy', value: 'copy-me' });
    }
    expect(written).toEqual(['copy-me']);
  });

  it('纯呈现面:判定行与报告/html 的如实措辞(unknown 带原因,不并路)', () => {
    const snapshot = {
      fileHash: 'aa',
      byteLength: 3,
      semanticHash: null,
      source: 'disk' as const,
      at: FIXED_NOW,
      durationMs: 2
    };
    const verdict = {
      fileChanged: 'unchanged' as const,
      semanticChanged: 'unknown' as const,
      appliedConsistency: 'unknown' as const,
      reasons: ['一侧 def 解析失败无语义指纹,结构是否变化未知']
    };
    const line = renderFingerprintChangeLine(DEF_PATH, verdict, false);
    expect(line).toContain('file=无变化');
    expect(line).toContain('semantic=未知(一侧 def 解析失败无语义指纹,结构是否变化未知)');
    expect(line).toContain('applied=unknown');

    const profile = resolveFingerprintProfile();
    const report = renderFingerprintReport({ fsPath: DEF_PATH, snapshot, verdict, profile, md5Check: null });
    expect(report).toContain('语义指纹: 解析失败(null;不猜不补)');
    expect(report).toContain('磁盘补载');
    expect(report).toContain('未协商');
    expect(report).toContain('未运行引擎盖章核查');

    const html = renderInspectorHtml({ fsPath: DEF_PATH, snapshot, verdict, profile, md5Check: null });
    expect(html).toContain('(解析失败,如实 null)');
    expect(html).toContain('未知(一侧 def 解析失败无语义指纹,结构是否变化未知)');
    expect(html).toContain('data-copy="aa"');
  });

  it('defaultDefFingerprintDeps:source 标签与 null 透传(适配不造来源)', () => {
    const deps = defaultDefFingerprintDeps(() => null);
    expect(deps.lastMd5Check()).toBeNull();
    // 读面走 readSharedFileSnapshot:/ws 不存在 → null(不造内容)
    expect(deps.readSnapshot(DEF_PATH)).toBeNull();
  });
});
