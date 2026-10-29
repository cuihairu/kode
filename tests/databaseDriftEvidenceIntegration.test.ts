import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { activate } from '../src/extension';
import {
  DRIFT_EVIDENCE_STATE_KEY,
  formatDriftEvidenceSaveLine,
  formatDriftEvidenceSkipLine,
  recordDriftEvidenceFromReport,
  renderDriftEvidenceRecords,
  runShowDriftEvidenceCommand
} from '../src/databaseDriftEvidenceIntegration';
import { classifyDriftEvidence, type DriftEvidenceRecord } from '../src/databaseDriftEvidence';
import type { DriftReport } from '../src/databaseDrift';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// IDE-REV-020 漂移校验证据接线:真实执行(checked=true)才落证据——queried
// 面写实查摘要,simulated 面明示 def 推导基准不冒充实测;未校验不落;版本
// 探不到记 unknown,分类按 unknown-version 悬置不宣称兼容;重查命令按版本
// 渲染已存证据,结论一律走 classifyDriftEvidence;命令级真装配含死端口
// checkDrift 的「未校验不落证据」与 workspaceState 预置载荷的重查端到端。

const report = (overrides: Partial<DriftReport> = {}): DriftReport => ({
  entityName: 'Hero',
  databaseName: 'game_db',
  checked: true,
  findings: [],
  ...overrides
});

const FINDINGS = [
  { kind: 'missing-column' as const, tableName: 'tbl_Hero', columnName: 'sm_hp', message: '缺列 sm_hp' },
  { kind: 'type-mismatch' as const, tableName: 'tbl_Hero', columnName: 'sm_level', message: '型别不符 sm_level' },
  { kind: 'extra-column' as const, tableName: 'tbl_Hero', columnName: 'sm_old', message: '多列 sm_old' },
  { kind: 'residual-table' as const, tableName: 'tbl_Hero_gone', message: '残留表 tbl_Hero_gone' }
];

const record = (overrides: Partial<DriftEvidenceRecord> = {}): DriftEvidenceRecord => ({
  engineVersion: '2.5.10',
  queried: { summary: '真实查询 game_db:Hero,发现 0 项' },
  simulated: { summary: 'def 推导虚拟 schema Hero(对比基准面,非实测)' },
  driftSummary: '',
  recordedAt: 1700000000000,
  ...overrides
});

describe('recordDriftEvidenceFromReport(纯面)', () => {
  const deps = { resolveEngineVersion: () => '2.5.10', now: () => 1700000000000 };

  it('真实执行:queried 面写实查摘要,simulated 面明示 def 推导基准(非实测),无发现 driftSummary 为空', () => {
    const evidence = recordDriftEvidenceFromReport(report(), deps);
    expect(evidence).not.toBeNull();
    expect(evidence?.engineVersion).toBe('2.5.10');
    expect(evidence?.queried?.summary).toContain('真实查询 game_db:Hero');
    expect(evidence?.queried?.summary).toContain('发现 0 项');
    expect(evidence?.simulated.summary).toContain('def 推导虚拟 schema Hero');
    expect(evidence?.simulated.summary).toContain('非实测');
    expect(evidence?.driftSummary).toBe('');
    expect(evidence?.recordedAt).toBe(1700000000000);
  });

  it('多项发现:driftSummary 记前 3 项加省略号,不吞不虚增', () => {
    const evidence = recordDriftEvidenceFromReport(report({ findings: FINDINGS }), deps);
    expect(evidence?.driftSummary).toContain('4 项:');
    expect(evidence?.driftSummary).toContain('缺列 sm_hp');
    expect(evidence?.driftSummary).toContain('型别不符 sm_level');
    expect(evidence?.driftSummary).toContain('多列 sm_old');
    expect(evidence?.driftSummary).not.toContain('残留表');
    expect(evidence?.driftSummary?.endsWith('…')).toBe(true);
  });

  it('版本探不到记 unknown,不伪造版本号', () => {
    const evidence = recordDriftEvidenceFromReport(report(), { resolveEngineVersion: () => null, now: () => 1 });
    expect(evidence?.engineVersion).toBe('unknown');
  });

  it('未校验(连不上/读表失败)不落证据:返回 null,模拟面不冒充联调结果', () => {
    expect(recordDriftEvidenceFromReport(report({ checked: false, reason: '连不上数据库(ECONNREFUSED)' }), deps)).toBeNull();
  });
});

describe('renderDriftEvidenceRecords / 尾行文案(纯面)', () => {
  it('四态结论各按 classify 渲染:未知版本不宣称兼容,纯模拟不冒充实测', () => {
    const text = renderDriftEvidenceRecords([
      record({ engineVersion: 'unknown' }),
      record({ engineVersion: '2.5.10', queried: null }),
      record({ engineVersion: '2.5.10' }),
      record({ engineVersion: '2.6.0', driftSummary: '2 项:缺列 sm_hp;型别不符 sm_level' })
    ]);
    // 每条记录一个空行分隔块(首块是标题)
    const [unknownLine, simulatedLine, verifiedLine, driftLine] = text.split('\n\n').slice(1);
    expect(unknownLine).toContain('unknown-version');
    expect(unknownLine).not.toContain('compatible-verified');
    expect(unknownLine).toContain('不宣称兼容');
    expect(simulatedLine).toContain('unverified');
    expect(simulatedLine).toContain('不冒充实测');
    expect(simulatedLine).toContain('无(未连接——纯模拟面,未验证)');
    expect(verifiedLine).toContain('compatible-verified');
    expect(verifiedLine).toContain('实测无漂移');
    expect(driftLine).toContain('drift-found');
    expect(driftLine).toContain('缺列 sm_hp');
    expect(text).toContain('def 推导虚拟 schema Hero(对比基准面,非实测)');
  });

  it('空清单如实说无,不虚构任何版本记录', () => {
    const text = renderDriftEvidenceRecords([]);
    expect(text).toContain('尚无已保存证据');
    expect(text).toContain('未校验与纯模拟面不落');
    expect(text).not.toContain('compatible-verified');
  });

  it('落证据尾行带版本+结论+重查入口;未校验尾行带原因+不冒充说明', () => {
    const saved = record();
    const line = formatDriftEvidenceSaveLine(saved, classifyDriftEvidence(saved));
    expect(line).toContain('引擎版本 2.5.10');
    expect(line).toContain('compatible-verified');
    expect(line).toContain('kbengine.database.showDriftEvidence');
    const skip = formatDriftEvidenceSkipLine('连不上数据库(ECONNREFUSED)');
    expect(skip).toContain('本次未校验');
    expect(skip).toContain('ECONNREFUSED');
    expect(skip).toContain('不冒充联调结果');
  });
});

describe('runShowDriftEvidenceCommand(编排面)', () => {
  it('有记录:按版本渲染进通道,不弹无证据提示', () => {
    const lines: string[] = [];
    const infos: string[] = [];
    runShowDriftEvidenceCommand({
      loadRecords: () => [record({ engineVersion: 'unknown' }), record()],
      channel: { clear: () => lines.push('__clear__'), appendLine: line => lines.push(line), show: () => undefined },
      showInformationMessage: message => {
        infos.push(message);
        return undefined;
      }
    });
    expect(lines[0]).toBe('__clear__');
    const text = lines.join('\n');
    expect(text).toContain('===== KBEngine 漂移校验证据 =====');
    expect(text).toContain('unknown-version');
    expect(text).toContain('compatible-verified');
    expect(infos).toHaveLength(0);
  });

  it('无记录:通道如实说明,并提示真实执行后才有证据', () => {
    const lines: string[] = [];
    const infos: string[] = [];
    runShowDriftEvidenceCommand({
      loadRecords: () => [],
      channel: { clear: () => undefined, appendLine: line => lines.push(line), show: () => undefined },
      showInformationMessage: message => {
        infos.push(message);
        return undefined;
      }
    });
    expect(lines.join('\n')).toContain('尚无已保存证据');
    expect(infos.at(-1)).toContain('尚无已保存的漂移校验证据');
    expect(infos.at(-1)).toContain('checkDrift / checkAllDrift');
  });
});

describe('kbengine.database.showDriftEvidence 命令(activate 真装配)', () => {
  let root = '';

  const makeMemento = (): { get(key: string): unknown; update(key: string, value: unknown): Promise<void> } => {
    const store = new Map<string, unknown>();
    return {
      get: key => store.get(key),
      update: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      }
    };
  };

  const freePort = async (): Promise<number> => {
    const probe = http.createServer();
    return new Promise<number>(resolve => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => resolve(address.port));
      });
    });
  };

  const writeEngineDefaults = (port: number): void => {
    const engine = path.join(root, 'kbe', 'res', 'server');
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(
      path.join(engine, 'kbengine_defaults.xml'),
      [
        '<defaults>',
        '  <dbmgr>',
        '    <databaseInterfaces>',
        '      <default>',
        '        <host>127.0.0.1</host>',
        `        <port>${port}</port>`,
        '        <databaseName>game_db</databaseName>',
        '        <auth>',
        '          <username>game</username>',
        '          <encrypt>false</encrypt>',
        '          <password>kbe</password>',
        '        </auth>',
        '      </default>',
        '    </databaseInterfaces>',
        '  </dbmgr>',
        '</defaults>'
      ].join('\n'),
      'utf8'
    );
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });
  };

  const activateWith = (memento: { get(key: string): unknown; update(key: string, value: unknown): Promise<void> }): void => {
    activate({ subscriptions: [], extensionUri: Uri.file('/workspace/ext'), workspaceState: memento } as ExtensionContext);
  };

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-drift-evidence-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
  });

  afterEach(() => {
    configurationOverrides.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const channelText = (): string =>
    (windowState.channels.find(channel => channel.name === 'KBEngine 数据库漂移')?.lines ?? []).join('\n');

  it('命令已注册;无证据执行:如实说无,不虚构记录', async () => {
    activateWith(makeMemento());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.database.showDriftEvidence');

    await commands.executeCommand('kbengine.database.showDriftEvidence');

    expect(channelText()).toContain('尚无已保存证据');
    expect(messages.info.at(-1)).toContain('尚无已保存的漂移校验证据');
  });

  it('workspaceState 预置真实形载荷:重查端到端渲染出该版本记录与结论', async () => {
    const memento = makeMemento();
    memento.update(DRIFT_EVIDENCE_STATE_KEY, {
      byVersion: [
        record({ engineVersion: 'unknown', recordedAt: 1700000000001 }),
        record({ recordedAt: 1700000000000 })
      ]
    });
    activateWith(memento);
    await new Promise(resolve => setTimeout(resolve, 100));

    await commands.executeCommand('kbengine.database.showDriftEvidence');

    const text = channelText();
    expect(text).toContain('===== KBEngine 漂移校验证据 =====');
    // 按版本最新在前:unknown(recordedAt 较新)在前,2.5.10 在后
    expect(text.indexOf('unknown-version')).toBeLessThan(text.indexOf('compatible-verified'));
    expect(text).toContain('不宣称兼容');
    expect(text).toContain('实测无漂移');
    expect(messages.info).toEqual([]);
  });

  it('死端口 checkDrift(真装配):通道如实说明本次未校验不落证据,workspaceState 不出现证据键', async () => {
    const memento = makeMemento();
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(
      path.join(defDir, 'Hero.def'),
      ['<root>', '  <Properties>', '    <hp>', '      <Type>UINT32</Type>', '    </hp>', '  </Properties>', '</root>'].join('\n'),
      'utf8'
    );
    writeEngineDefaults(await freePort());
    activateWith(memento);
    await new Promise(resolve => setTimeout(resolve, 100));

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');

    expect(channelText()).toContain('未校验');
    expect(channelText()).toContain('本次未校验');
    expect(channelText()).toContain('不落证据');
    expect(memento.get(DRIFT_EVIDENCE_STATE_KEY)).toBeUndefined();
  });

  it('源锁:漂移两命令都接线 appendDriftEvidenceForReport,保存与重查命令在册', () => {
    const extensionSource = readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extensionSource.split('appendDriftEvidenceForReport(report);').length - 1).toBe(2);
    expect(extensionSource).toContain('driftEvidenceStore.save(evidence)');
    expect(extensionSource).toContain("'kbengine.database.showDriftEvidence'");
  });
});
