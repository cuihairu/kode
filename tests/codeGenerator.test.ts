import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type {
  EntityDefinition,
  MethodDefinition,
  PropertyDefinition
} from '../src/codeGenerator';

// KBEngineCodeGenerator 的纯生成器:private 方法经实例直调(真实行为,
// 非 mock)。命令编排层(showWizard/QuickPick/写文件)由 mocha 层覆盖。

const makeGenerator = () =>
  new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);

const generator = makeGenerator();
const internals = generator as unknown as {
  generateEntityRegistration: (config: { name: string; hasCell: boolean; hasBase: boolean; hasClient: boolean }) => string;
  generatePropertyCode: (prop: PropertyDefinition, indent: string) => string;
  generateMethodCode: (method: MethodDefinition, indent: string, supportsExposed: boolean) => string;
  generatePythonMethodCode: (method: MethodDefinition) => string;
  generateDefContent: (entity: EntityDefinition) => string;
  generatePythonContent: (entity: EntityDefinition) => string;
  resolveDefOutputPath: (configuredPath: string, workspaceRoot: string) => string;
  getTemplateEntity: (templateType: string) => EntityDefinition;
};

describe('generateEntityRegistration', () => {
  it('renders the entities.xml entry with the three domain flags', () => {
    expect(internals.generateEntityRegistration({
      name: 'Monster', hasCell: true, hasBase: true, hasClient: false
    })).toBe('  <Monster hasCell="true" hasBase="true" hasClient="false" />');
  });
});

describe('generatePropertyCode', () => {
  it('renders the type and flags and every provided optional', () => {
    const xml = internals.generatePropertyCode({
      name: 'hp', type: 'UINT32', flags: 'BASE', default: '100',
      dbLength: 32, detailLevel: 'ALL_CLIENTS', persistent: true, identifier: true
    }, '    ');

    expect(xml).toBe([
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Default>100</Default>',
      '      <Persistent>true</Persistent>',
      '      <DatabaseLength>32</DatabaseLength>',
      '      <DetailLevel>ALL_CLIENTS</DetailLevel>',
      '      <Identifier>true</Identifier>',
      '    </hp>'
    ].join('\n'));
  });

  it('omits optionals that are not set', () => {
    const xml = internals.generatePropertyCode({ name: 'speed', type: 'UINT8', flags: 'CELL_PUBLIC' }, '  ');

    expect(xml).toBe([
      '  <speed>',
      '    <Type>UINT8</Type>',
      '    <Flags>CELL_PUBLIC</Flags>',
      '  </speed>'
    ].join('\n'));
  });
});

describe('generateMethodCode', () => {
  it('renders exposed marker and one Arg per parameter', () => {
    const xml = internals.generateMethodCode({
      name: 'attack', exposed: true,
      args: [{ name: 'targetId', type: 'UINT32' }, { name: 'skillId', type: 'UINT16' }]
    }, '  ', true);

    expect(xml).toBe([
      '  <attack>',
      '    <Exposed/>',
      '    <Arg>UINT32</Arg>',
      '    <Arg>UINT16</Arg>',
      '  </attack>'
    ].join('\n'));
  });

  it('honors supportsExposed=false and renders bare methods', () => {
    const xml = internals.generateMethodCode({ name: 'onDie', exposed: true }, '  ', false);

    expect(xml).toBe(['  <onDie>', '  </onDie>'].join('\n'));
  });
});

describe('generatePythonMethodCode', () => {
  it('renders self, positional args and the docstring', () => {
    const py = internals.generatePythonMethodCode({
      name: 'attack', args: [{ name: 'targetId', type: 'UINT32' }], returnType: 'UINT8'
    });

    expect(py).toBe([
      '    def attack(self, targetId):',
      '        """',
      '        attack 方法',
      '        返回: UINT8',
      '        """',
      '        pass',
      ''
    ].join('\n'));
  });
});

describe('generateDefContent', () => {
  it('embeds the entity name and method blocks in a def document', () => {
    const def = internals.generateDefContent({
      config: { name: 'Hero', hasCell: true, hasBase: true, hasClient: true, description: '主角' },
      baseMethods: [{ name: 'attack', exposed: true, args: [{ name: 'id', type: 'UINT32' }] }]
    });

    expect(def).toContain('<!DOCTYPE entity>');
    expect(def).toContain('实体: Hero');
    expect(def).toContain('描述: 主角');
    expect(def).toContain('生成时间:');
    expect(def).toContain('<root>');
    expect(def).toContain('<attack>');
    expect(def).toContain('<Exposed/>');
    expect(def).toContain('<Arg>UINT32</Arg>');
    expect(def.trimEnd().endsWith('</root>')).toBe(true);
  });
});

describe('generatePythonContent', () => {
  it('suffixes the class name by domain and orders hook/method sections', () => {
    const py = internals.generatePythonContent({
      config: { name: 'Hero', hasCell: true, hasBase: true, hasClient: true },
      baseMethods: [{ name: 'saveData' }],
      cellMethods: [{ name: 'dash', exposed: true }]
    });

    expect(py.startsWith('# -*- coding: utf-8 -*-')).toBe(true);
    expect(py).toContain('import KBEngine');
    // hasCell 优先于 hasBase
    expect(py).toContain('class HeroCell():');
    expect(py).toContain('def __init__(self):');
    expect(py).toContain('def onCreate(self):');
    expect(py).toContain('def onEnterWorld(self):');
    expect(py).toContain('Base 方法');
    expect(py).toContain('def saveData(self):');
    expect(py).toContain('Cell 方法');
    expect(py).toContain('def dash(self):');
  });

  it('falls back to the Base suffix and skips the cell hook without a cell', () => {
    const py = internals.generatePythonContent({
      config: { name: 'Account', hasCell: false, hasBase: true, hasClient: true }
    });

    expect(py).toContain('class AccountBase():');
    expect(py).not.toContain('def onEnterWorld(self):');
  });

  it('keeps the plain class name for pure-client entities', () => {
    const py = internals.generatePythonContent({
      config: { name: 'Ghost', hasCell: false, hasBase: false, hasClient: true }
    });

    expect(py).toContain('class Ghost():');
  });
});

describe('resolveDefOutputPath', () => {
  let workspaceRoot = '';

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-'));
    fs.mkdirSync(path.join(workspaceRoot, 'scripts', 'entity_defs'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('keeps absolute paths untouched', () => {
    expect(internals.resolveDefOutputPath('/tmp/defs', workspaceRoot)).toBe('/tmp/defs');
  });

  it('keeps unrecognized relative paths untouched', () => {
    expect(internals.resolveDefOutputPath('my/defs', workspaceRoot)).toBe('my/defs');
  });

  it('resolves scripts/entity_defs to the discovered definitions root', () => {
    expect(internals.resolveDefOutputPath('scripts\\entity_defs', workspaceRoot))
      .toBe(path.join(workspaceRoot, 'scripts', 'entity_defs'));
  });

  it('falls back to the conventional absolute path when no definitions root exists', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-bare-'));
    try {
      // findEntityDefinitionsRoot 对不存在的目录仍返回约定的绝对路径
      expect(internals.resolveDefOutputPath('scripts/entity_defs', bareRoot))
        .toBe(path.join(bareRoot, 'scripts', 'entity_defs'));
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

describe('built-in templates', () => {
  it('exposes account/avatar/npc/item/empty templates with names and domains', () => {
    for (const templateType of ['account', 'avatar', 'npc', 'item', 'empty'] as const) {
      const entity = internals.getTemplateEntity(templateType);

      expect(entity.config.name.length, templateType).toBeGreaterThan(0);
      expect(typeof entity.config.hasCell, templateType).toBe('boolean');
      expect(typeof entity.config.hasBase, templateType).toBe('boolean');
      expect(typeof entity.config.hasClient, templateType).toBe('boolean');
    }
  });

  it('maps unknown template types to the empty template', () => {
    expect(internals.getTemplateEntity('unknown').config.name)
      .toBe(internals.getTemplateEntity('empty').config.name);
  });
});
