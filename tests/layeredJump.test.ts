import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { PythonDefinitionProvider, TracedDefinitionResult } from '../src/languageProviders';

// 放弃范围逐层收窄(用户 2026-10-16):
// 层1 entity-def(.def 派生索引,对象级类粒度 → 文件级 owner 归属)
// 层2 python-mro(PythonClassIndex 跨文件 MRO + 组合根)
// 层3 file-scope(当前文件类作用域 / 本文件 MRO)
// 任何一层命中即返回;全部落空才 null,且 layers 说明查过哪些层。

const FIXTURE = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');

const lineOf = (content: string, needle: string): number => {
  const index = content.split('\n').findIndex(line => line.includes(needle));
  expect(index, `夹具缺少样本行: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

const normalize = (p: string): string => p.replace(/\\/g, '/');

describe('分层跳转(对象级放弃收窄)', () => {
  const ORIGINAL = stubWorkspace.findFiles;

  const realFindFiles = async (pattern?: string): Promise<Uri[]> => {
    const matches = pattern && pattern.includes('entities.xml')
      ? (name: string): boolean => name === 'entities.xml'
      : pattern && pattern.includes('*.def')
        ? (name: string): boolean => name.endsWith('.def')
        : pattern && pattern.includes('types.xml')
          ? (name: string): boolean => name === 'types.xml'
          : (name: string): boolean => name.endsWith('.py');
    const out: Uri[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (matches(entry.name)) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(FIXTURE);
    return out;
  };

  const readFixture = (rel: string): string =>
    fs.readFileSync(path.join(FIXTURE, ...rel.split('/')), 'utf8');

  interface LayerCase {
    label: string;
    entity: string;
    callFile: string;
    callNeedle: string;
    method: string;
    /** 期望首个命中层 */
    hitLayer: 'entity-def' | 'python-mro';
    /** 层1 详情应包含的对象级子探(对象级判定在类粒度的证据) */
    objectProbe: string;
    finalFile: string;
    finalNeedle: string;
    /** 组合根候选(上一单验收:调用 → 定义 → 命中组合根) */
    root: string;
    rootDefFile: string;
    rootDefNeedle: string;
  }

  const CASES: LayerCase[] = [
    {
      label: 'G1 Monster(<Parent> Avatar 链)',
      entity: 'Monster',
      callFile: 'scripts/cell/Monster.py',
      callNeedle: 'self.respawn()',
      method: 'respawn',
      hitLayer: 'entity-def',
      objectProbe: 'object=Monster',
      finalFile: 'scripts/entity_defs/Avatar.def',
      finalNeedle: '<respawn>',
      root: 'Monster',
      rootDefFile: 'scripts/cell/Avatar.py',
      rootDefNeedle: 'def respawn'
    },
    {
      label: 'G2 Monster(接口 ROLE → 实体实现;文件级 owner 不含目标 → python 层接住)',
      entity: 'Monster',
      callFile: 'scripts/interfaces/ROLE.py',
      callNeedle: 'self.onAggro(entityId)',
      method: 'onAggro',
      hitLayer: 'python-mro',
      objectProbe: 'object=ROLE',
      finalFile: 'scripts/cell/Monster.py',
      finalNeedle: 'def onAggro',
      root: 'Monster',
      rootDefFile: 'scripts/cell/Monster.py',
      rootDefNeedle: 'def onAggro'
    },
    {
      label: 'G3 Avatar(实体 → 接口 ROLE 声明;.def 层对象级命中)',
      entity: 'Avatar',
      callFile: 'scripts/cell/Avatar.py',
      callNeedle: 'self.onMove(None)',
      method: 'onMove',
      hitLayer: 'entity-def',
      objectProbe: 'object=Avatar',
      finalFile: 'scripts/entity_defs/interfaces/ROLE.def',
      finalNeedle: '<onMove>',
      root: 'Avatar',
      rootDefFile: 'scripts/interfaces/ROLE.py',
      rootDefNeedle: 'def onMove'
    },
    {
      label: 'G4 Avatar 字段对象(serializer_base → weapon_skill_slot_list;文件非 owner → python 层接住)',
      entity: 'Avatar',
      callFile: 'scripts/user_type/SKILL_SLOT_DATA.py',
      callNeedle: 'self.reindex()',
      method: 'reindex',
      hitLayer: 'python-mro',
      objectProbe: 'object=serializer_base',
      finalFile: 'scripts/user_type/SKILL_SLOT_DATA.py',
      finalNeedle: 'def reindex',
      root: 'weapon_skill_slot_list',
      rootDefFile: 'scripts/user_type/SKILL_SLOT_DATA.py',
      rootDefNeedle: 'def reindex'
    }
  ];

  it('4 组逐层追踪:每层命中/落空可解释,任一层命中即返回(≥2 实体)', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];
    try {
      const index = new PythonClassIndex();
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, index);
      const report: Array<Record<string, unknown>> = [];

      for (const c of CASES) {
        const callAbs = path.join(FIXTURE, ...c.callFile.split('/'));
        const callText = readFixture(c.callFile);
        const finalText = readFixture(c.finalFile);
        const callLine = lineOf(callText, c.callNeedle);
        const finalLine = lineOf(finalText, c.finalNeedle);
        const char = callText.split('\n')[callLine].indexOf(`self.${c.method}`) + 7;
        const document = makeTextDocument(callText, { fileName: callAbs, languageId: 'python' });

        const traced: TracedDefinitionResult = await provider.provideDefinitionTraced(
          document,
          new Position(callLine, char)
        );
        const first = traced.layers[0];
        expect(first, `${c.label} 首层应为 entity-def`).toMatchObject({ layer: 'entity-def' });
        // 对象级子探证据:层1 详情带 object=<类名>(类粒度判定,不看文件 owner 匹配)
        expect(first.detail ?? '', `${c.label} 层1 应做对象级子探`).toContain(c.objectProbe);

        if (c.hitLayer === 'entity-def') {
          // 该类有 .def → 第一层命中即返回,后面层不再执行
          expect(traced.layers.length, `${c.label} 命中即止`).toBe(1);
          expect(first.status).toBe('hit');
        } else {
          // 该类/文件无可用 .def → 层1 落空记录原因,层2 接住
          expect(traced.layers.length, `${c.label} 查了 2 层`).toBe(2);
          expect(first.status).toBe('miss');
          expect(traced.layers[1]).toMatchObject({ layer: 'python-mro', status: 'hit' });
        }

        expect(traced.location, `${c.label} 应有落点`).not.toBeNull();
        const loc = traced.location as { uri: { fsPath: string }; range: { start: { line: number } } };
        expect(normalize(loc.uri.fsPath), `${c.label} 落点文件`).toContain(c.finalFile);
        expect(loc.range.start.line, `${c.label} 落点行`).toBe(finalLine);

        // 组合根候选(上一单验收):调用 → 定义 → 命中的组合根
        const candidates = await index.resolveSelfMethodCandidates(callAbs, callLine, c.method);
        const viaRoot = candidates.filter(candidate => candidate.compositionRoot === c.root);
        expect(viaRoot.length, `${c.label} 应命中组合根 ${c.root}`).toBeGreaterThan(0);
        expect(normalize(viaRoot[0].filePath)).toContain(c.rootDefFile);
        expect(viaRoot[0].line).toBe(lineOf(readFixture(c.rootDefFile), c.rootDefNeedle));

        report.push({
          group: c.label,
          entity: c.entity,
          call: `${c.callFile}:${callLine + 1}`,
          layers: traced.layers.map(l => ({ layer: l.layer, query: l.query, status: l.status, detail: l.detail })),
          final: `${c.finalFile}:${finalLine + 1}`,
          compositionRoot: c.root
        });
      }

      // ≥2 个不同实体
      expect(new Set(CASES.map(c => c.entity)).size).toBeGreaterThanOrEqual(2);

      fs.writeFileSync(
        path.join(os.tmpdir(), 'kode_layered_jump_report.json'),
        JSON.stringify(report, null, 2),
        'utf8'
      );
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 120_000);

  it('对象级判定在类粒度:类名直取 .def,文件级对非 owner 文件落空', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      // 对象级:类名 Monster → Monster.def 声明(与调用文件无关)
      const objectHit = await manager.resolveMethodDefinitionForClass('Monster', 'onAggro');
      expect(objectHit, '对象级应命中').not.toBeNull();
      expect(normalize(objectHit!.defFile)).toContain('entity_defs/Monster.def');
      expect(objectHit!.line).toBe(15);
      // 对象级属性:Avatar 的 skillSlots <Properties>
      const propertyHit = await manager.resolvePropertyDefinitionForClass('Avatar', 'skillSlots', 'skillSlots');
      expect(propertyHit, '对象级属性应命中').not.toBeNull();
      expect(normalize(propertyHit!.defFile)).toContain('entity_defs/Avatar.def');
      // 文件级:非 owner 文件同一目标落空 —— 证明两维度判定不同,不再因文件
      // 没匹配上 owner 就整批放弃
      const fileMiss = await manager.resolveMethodDefinition(
        path.join(FIXTURE, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py'),
        'onAggro'
      );
      expect(fileMiss, '文件级对非 owner 文件落空(对象级仍可命中)').toBeNull();
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 60_000);

  it('反例收窄:明确不在任何 .def 的 mixin 基类 serializer_base,其方法仍跳到定义', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];
    try {
      const index = new PythonClassIndex();
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, index);

      // ① 类不在任何 .def:全夹具 .def grep 无 serializer_base / bootstrap
      const defUris = await realFindFiles('**/*.def');
      expect(defUris.length, '夹具应有 .def 文件').toBeGreaterThan(0);
      for (const uri of defUris) {
        const content = fs.readFileSync(uri.fsPath, 'utf8');
        expect(content.includes('serializer_base'), `不应在 .def 命中 serializer_base: ${uri.fsPath}`).toBe(false);
        expect(content.includes('bootstrap'), `不应在 .def 命中 bootstrap: ${uri.fsPath}`).toBe(false);
      }

      // ② 类定义与 mixin 证据(回报 file:line,1-based)
      const text = readFixture('scripts/user_type/SKILL_SLOT_DATA.py');
      const classLine = lineOf(text, 'class serializer_base');
      const mixinLine = lineOf(text, 'class weapon_skill_slot_list(serializer_base)');
      expect(classLine).toBe(7);
      expect(mixinLine).toBe(14);
      const defLine = lineOf(text, 'def bootstrap');
      const callLine = lineOf(text, 'self.bootstrap()');

      // ③ 跳转:字段对象根的类调 mixin 基类方法 → 层1 落空,层2 MRO 接住
      const callAbs = path.join(FIXTURE, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py');
      const document = makeTextDocument(text, { fileName: callAbs, languageId: 'python' });
      const traced = await provider.provideDefinitionTraced(
        document,
        new Position(callLine, text.split('\n')[callLine].indexOf('self.bootstrap()') + 8)
      );
      expect(traced.layers.map(l => `${l.layer}:${l.status}`)).toEqual([
        'entity-def:miss',
        'python-mro:hit'
      ]);
      expect(traced.layers[0].detail ?? '').toContain('object=weapon_skill_slot_list');
      const loc = traced.location as { uri: { fsPath: string }; range: { start: { line: number } } };
      expect(normalize(loc.uri.fsPath)).toContain('scripts/user_type/SKILL_SLOT_DATA.py');
      expect(loc.range.start.line).toBe(defLine);

      fs.writeFileSync(
        path.join(os.tmpdir(), 'kode_counterexample_report.json'),
        JSON.stringify({
          classNotInAnyDef: {
            className: 'serializer_base',
            classDefinition: `scripts/user_type/SKILL_SLOT_DATA.py:${classLine + 1}`,
            mixedInto: `scripts/user_type/SKILL_SLOT_DATA.py:${mixinLine + 1}`,
            grepEvidence: `${defUris.length} 个 .def 文件中 'serializer_base' 与 'bootstrap' 命中 0`
          },
          jump: {
            call: `scripts/user_type/SKILL_SLOT_DATA.py:${callLine + 1}`,
            definition: `scripts/user_type/SKILL_SLOT_DATA.py:${defLine + 1}`,
            layers: traced.layers.map(l => `${l.layer}=${l.status}`)
          }
        }, null, 2),
        'utf8'
      );
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 60_000);

  it('python 索引不可用:层3 file-scope 兜底命中;全落空才 null 并列明查过的层', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const noIndexProvider = new PythonDefinitionProvider(manager);

      // (a) G4 形态:层1 落空、层2 不可用 → 层3 本文件类作用域接住
      const g4File = 'scripts/user_type/SKILL_SLOT_DATA.py';
      const g4Text = readFixture(g4File);
      const g4Abs = path.join(FIXTURE, ...g4File.split('/'));
      const g4Line = lineOf(g4Text, 'self.reindex()');
      const tracedG4 = await noIndexProvider.provideDefinitionTraced(
        makeTextDocument(g4Text, { fileName: g4Abs, languageId: 'python' }),
        new Position(g4Line, g4Text.split('\n')[g4Line].indexOf('self.reindex()') + 7)
      );
      expect(tracedG4.layers.map(l => `${l.layer}:${l.status}`)).toEqual([
        'entity-def:miss',
        'python-mro:skip',
        'file-scope:hit'
      ]);
      const locG4 = tracedG4.location as { uri: { fsPath: string }; range: { start: { line: number } } };
      expect(normalize(locG4.uri.fsPath)).toContain(g4File);
      expect(locG4.range.start.line).toBe(lineOf(g4Text, 'def reindex'));

      // (b) G2 形态:三层全部落空 → null,且 layers 完整列明查过的层
      const g2File = 'scripts/interfaces/ROLE.py';
      const g2Text = readFixture(g2File);
      const g2Abs = path.join(FIXTURE, ...g2File.split('/'));
      const g2Line = lineOf(g2Text, 'self.onAggro(entityId)');
      const tracedG2 = await noIndexProvider.provideDefinitionTraced(
        makeTextDocument(g2Text, { fileName: g2Abs, languageId: 'python' }),
        new Position(g2Line, g2Text.split('\n')[g2Line].indexOf('self.onAggro') + 7)
      );
      expect(tracedG2.location, '全落空才 null').toBeNull();
      expect(tracedG2.layers.map(l => `${l.layer}:${l.status}`)).toEqual([
        'entity-def:miss',
        'python-mro:skip',
        'file-scope:miss'
      ]);
      expect(tracedG2.layers[2].detail ?? '').toContain('onAggro');
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 60_000);

  it('对象不在 .def 不断链:方法层查询光标段(非根符号),层3 接住同文件定义', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo-assets', index: 0 }];
    try {
      const index = new PythonClassIndex();
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, index);

      // self.helper.proc():根对象 helper 不在任何 .def。修复前方法层查询根
      // 符号 helper → 三层全空 → null(关联查找路径一起断掉);修复后查询
      // 光标段 proc,层3 同文件 Helper.proc 兜底命中。
      const text = [
        'class Helper(object):',
        '\tdef proc(self):',
        '\t\treturn 1',
        '',
        '',
        'class User(object):',
        '\tdef run(self):',
        '\t\tself.helper.proc()',
        ''
      ].join('\n');
      const virtualFile = path.join(FIXTURE, 'scripts', 'common', 'nested_probe.py');
      const callLine = 7;
      const char = text.split('\n')[callLine].indexOf('proc') + 2;
      const traced = await provider.provideDefinitionTraced(
        makeTextDocument(text, { fileName: virtualFile, languageId: 'python' }),
        new Position(callLine, char)
      );
      expect(traced.layers[0].layer).toBe('entity-def');
      expect(traced.layers[0].query, '方法层查询光标段而非根符号').toBe('proc');
      expect(traced.layers[0].status).toBe('miss');
      expect(traced.layers[1].layer).toBe('python-mro');
      expect(traced.layers[1].status).toBe('miss');
      expect(traced.layers[2]).toMatchObject({ layer: 'file-scope', status: 'hit' });
      const loc = traced.location as { uri: { fsPath: string }; range: { start: { line: number } } };
      expect(normalize(loc.uri.fsPath)).toContain('nested_probe.py');
      expect(loc.range.start.line, 'Helper.proc 定义行').toBe(1);
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  }, 60_000);
});
