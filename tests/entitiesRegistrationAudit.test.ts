import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import {
  auditEntitiesRegistration,
  collectAuditStats,
  renderEntitiesRegistrationAudit,
  type EntitiesRegistrationAuditInput
} from '../src/backend/entitiesRegistrationAudit';
import { channels, messages } from './fake-vscode/windowState';
import { workspace } from './fake-vscode/workspaceState';
import { commands } from './fake-vscode/commandRegistry';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { makeContext, resetExtensionTestState } from './extensionTestShared';

// RUST-175 entities.xml 注册完整性审计:清单↔.def 配对与 base/cell 面脚本
// 在盘。引擎真源锚(entitydef.cpp:199-210/207-210/253-265/2273-2280、
// scriptdef_module.cpp:330-510)见核心头注;重复条目(KBE-DEF-009)与方法
// 一致性(C-19)已有交付面,本套件不重复钉。

const baseInput = (overrides: Partial<EntitiesRegistrationAuditInput> = {}): EntitiesRegistrationAuditInput => ({
  entitiesXmlText: '<root>\n  <Avatar/>\n</root>',
  defNames: ['Avatar'],
  baseScriptNames: new Set(['Avatar']),
  cellScriptNames: new Set(['Avatar']),
  ...overrides
});

describe('auditEntitiesRegistration(RUST-175)', () => {
  it('全配对健康 → 零发现', () => {
    expect(auditEntitiesRegistration(baseInput())).toEqual([]);
  });

  it('entry-without-def(error):条目无 .def → 引擎启动中止面,锚条目开标签区间', () => {
    const text = '<root>\n  <Avatar/>\n</root>';
    const findings = auditEntitiesRegistration(baseInput({
      entitiesXmlText: text,
      defNames: []
    }));
    expect(findings).toHaveLength(1);
    const missingDef = findings.find(f => f.check === 'entry-without-def');
    expect(missingDef?.severity).toBe('error');
    expect(missingDef?.entity).toBe('Avatar');
    expect(missingDef?.offset).toBe(text.indexOf('<Avatar'));
    expect(missingDef?.length).toBe('<Avatar/>'.length);
  });

  it('def-without-entry(warning):.def 未入清单 → 无 utype 不可 createEntity,无 XML 锚', () => {
    const findings = auditEntitiesRegistration(baseInput({
      defNames: ['Avatar', 'Guard']
    }));
    const orphan = findings.find(f => f.check === 'def-without-entry');
    expect(orphan?.severity).toBe('warning');
    expect(orphan?.entity).toBe('Guard');
    expect(orphan?.offset).toBeNull();
    expect(orphan?.length).toBeNull();
  });

  it('face-script-missing:脚本缺失且无显式声明 → base+cell 双面警告(autoMatchCompOwn 口径:缺失≠不存在)', () => {
    const findings = auditEntitiesRegistration(baseInput({
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>()
    }));
    const faces = findings.filter(f => f.check === 'face-script-missing').map(f => f.face);
    expect(faces).toEqual(['base', 'cell']);
    for (const finding of findings.filter(f => f.check === 'face-script-missing')) {
      expect(finding.severity).toBe('warning');
      expect(finding.offset).toBe(baseInput().entitiesXmlText.indexOf('<Avatar'));
    }
  });

  it('显式 hasCell="false" → cell 面豁免(引擎干净豁出口);大小写不敏感', () => {
    const findings = auditEntitiesRegistration(baseInput({
      entitiesXmlText: '<root>\n  <Avatar hasCell="False"/>\n</root>',
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>()
    }));
    const faces = findings.filter(f => f.check === 'face-script-missing').map(f => f.face);
    expect(faces).toEqual(['base']);
  });

  it('显式双 false → 全豁免;脚本在盘一面照常', () => {
    const none = auditEntitiesRegistration(baseInput({
      entitiesXmlText: '<root>\n  <Avatar hasBase="false" hasCell="false"/>\n</root>',
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>()
    }));
    expect(none.filter(f => f.check === 'face-script-missing')).toEqual([]);
    const baseOnly = auditEntitiesRegistration(baseInput({
      entitiesXmlText: '<root>\n  <Avatar hasBase="false"/>\n</root>',
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>(['Avatar'])
    }));
    expect(baseOnly.filter(f => f.check === 'face-script-missing')).toEqual([]);
  });

  it('分节格式透明下钻(ClientServerEntities/ServerOnlyEntities);重复条目只取首条;root 伪条目跳过', () => {
    const text = '<root>\n  <root/>\n  <ClientServerEntities>\n    <Avatar/>\n  </ClientServerEntities>\n  <ServerOnlyEntities>\n    <Guard/>\n    <Guard/>\n  </ServerOnlyEntities>\n</root>';
    const findings = auditEntitiesRegistration(baseInput({
      entitiesXmlText: text,
      defNames: [],
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>()
    }));
    const names = findings.map(f => f.entity);
    expect(names.filter(n => n === 'Avatar')).toHaveLength(3);
    expect(names.filter(n => n === 'Guard')).toHaveLength(3);
    expect(names.filter(n => n === 'root')).toHaveLength(0);
  });

  it('解析失败(活编辑器中途不完整)→ 诚实空结果,不虚构发现', () => {
    const findings = auditEntitiesRegistration(baseInput({
      entitiesXmlText: '<root>\n  <Avatar'
    }));
    expect(findings).toEqual([]);
    expect(collectAuditStats(baseInput({ entitiesXmlText: '<root>\n  <Avatar' })).registered).toBe(0);
  });
});

describe('collectAuditStats + renderEntitiesRegistrationAudit(RUST-175)', () => {
  it('stats 四元组如实计数', () => {
    const input = baseInput({ defNames: ['Avatar', 'Guard'] });
    expect(collectAuditStats(input)).toEqual({
      registered: 1,
      defFiles: 2,
      baseScripts: 1,
      cellScripts: 1
    });
  });

  it('健康 → 双语零发现行;发现 → 逐条引擎锚引文 + entities.xml 偏移标注', () => {
    const input = baseInput({ defNames: [] });
    const findings = auditEntitiesRegistration(input);
    const en = renderEntitiesRegistrationAudit(findings, collectAuditStats(input));
    expect(en).toContain('entities.xml registration audit');
    expect(en).toContain('registered 1 / .def files 0');
    expect(en).toContain('[error] entity Avatar is registered in entities.xml but entity_defs/Avatar.def is missing');
    expect(en).toContain('entitydef.cpp:207-210');
    expect(en).toContain('(entities.xml offset ');
    const zh = renderEntitiesRegistrationAudit(findings, collectAuditStats(input), 'zh-CN');
    expect(zh).toContain('entities.xml 注册完整性审计');
    expect(zh).toContain('[error] 实体 Avatar 在 entities.xml 已登记');
  });

  it('face 引擎锚引文 + def-without-entry 无锚不标偏移', () => {
    const input = baseInput({
      defNames: ['Avatar', 'Guard'],
      baseScriptNames: new Set<string>(),
      cellScriptNames: new Set<string>()
    });
    const text = renderEntitiesRegistrationAudit(auditEntitiesRegistration(input), null);
    expect(text).toContain('scriptdef_module.cpp:452-460');
    expect(text).toContain('entitydef.cpp:253-265');
    const orphanLines = text.split('\n').filter(line => line.includes('Guard.def'));
    expect(orphanLines.some(line => line.includes('entities.xml offset'))).toBe(false);
  });

  it('空发现 → 双语「未发现」行(含 stats)', () => {
    const text = renderEntitiesRegistrationAudit([], collectAuditStats(baseInput()), 'zh-CN');
    expect(text).toContain('未发现注册完整性问题。');
    expect(text).toContain('清单登记 1');
  });
});

describe('kbengine.entities.checkRegistration 命令装配(RUST-175)', () => {
  beforeEach(resetExtensionTestState);

  const makeWorkspace = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-reg-audit-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      '<root>\n  <Avatar/>\n  <Guard hasCell="false"/>\n</root>\n',
      'utf8'
    );
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Guard.def'), '<root/>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'base', 'Guard.py'), 'class Guard:\n    pass\n', 'utf8');
    return root;
  };

  it('报告进输出通道:Avatar 三发现(Guard 全配对零发现),stats 四元组如实', async () => {
    const root = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context: ExtensionContext = makeContext();
    activate(context);
    try {
      await commands.executeCommand('kbengine.entities.checkRegistration');
      const channel = channels.find(candidate => candidate.name === 'Kode Entity Registration');
      expect(channel).toBeDefined();
      const text = channel?.lines.join('\n') ?? '';
      expect(text).toContain('entities.xml 注册完整性审计');
      expect(text).toContain('清单登记 2 / .def 文件 1 / base 脚本 1 / cell 脚本 0');
      expect(text).toContain('[error] 实体 Avatar');
      expect(text).toContain('[warning] 实体 Avatar 的 cell 面');
      expect(text).not.toContain('Guard 的');
      expect(text).not.toContain('实体 Guard');
    } finally {
      deactivate();
    }
  });

  it('无 entities.xml → 如实说明(纯脚本定义资产可缺省)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-reg-none-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context: ExtensionContext = makeContext();
    activate(context);
    try {
      await commands.executeCommand('kbengine.entities.checkRegistration');
      const channel = channels.find(candidate => candidate.name === 'Kode Entity Registration');
      expect(channel?.lines.join('\n')).toContain('未见 entities.xml');
    } finally {
      deactivate();
    }
  });

  it('无工作区 → 诚实警告拒绝,零通道输出', async () => {
    const context: ExtensionContext = makeContext();
    activate(context);
    const warnBaseline = messages.warning.length;
    try {
      await commands.executeCommand('kbengine.entities.checkRegistration');
      expect(messages.warning.length).toBe(warnBaseline + 1);
      expect(channels.find(candidate => candidate.name === 'Kode Entity Registration')?.lines ?? []).toEqual([]);
    } finally {
      deactivate();
    }
  });
});
