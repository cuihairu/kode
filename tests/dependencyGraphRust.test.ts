import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDependencyGraphInRust } from '../src/dependencyGraphRust';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-RUST-007 依赖图 Rust 核心接线:buildDependencyGraphInRust 主路径经
// 命令级 RPC($/kode/dependency/graph)调 Rust 核心;Rust 不可用(无 gate/
// 调用失败/形状不合规)返回 null,调用方回落 TS EntityDependencyAnalyzer。
// 测试用真实 tmp workspace(entities.xml/types.xml/def 文件)+ 假 gate,契约
// 参数形状(defs/paths/categories/pythonFiles/typeImpls)与回退是断言重点。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const originalFindFiles = stubWorkspace.findFiles;

let depRoot = '';

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-deprust-'));
  depRoot = root;

  const put = (relative: string, content: string) => {
    const abs = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };

  put('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasCell="true"/>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Parent><Monster/></Parent>',
    '  <Interfaces><interface>IMove</interface></Interfaces>',
    '  <Properties>',
    '    <pos><Type>Vec3</Type><Flags>BASE_AND_CLIENT</Flags></pos>',
    '  </Properties>',
    '  <Components><weapon><Type>CWeapon</Type></weapon></Components>',
    '  <BaseMethods><reqQuest><Exposed/></reqQuest></BaseMethods>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp></Properties>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/interfaces/IMove.def', [
    '<root>',
    '  <BaseMethods><onMove><Exposed/></onMove></BaseMethods>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/components/CWeapon.def', [
    '<root>',
    '  <Properties><ammo><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></ammo></Properties>',
    '</root>'
  ].join('\n'));

  put('scripts/entity_defs/types.xml', [
    '<root>',
    '  <Vec3>',
    '    <FIXED_DICT>',
    '      <implementedBy>game.Position</implementedBy>',
    '      <Properties><x><Type>FLOAT</Type></x></Properties>',
    '    </FIXED_DICT>',
    '  </Vec3>',
    '</root>'
  ].join('\n'));

  // Hero 实体脚本(候选 scripts/base/Hero.py,existsSync 命中)
  put('scripts/base/Hero.py', '');

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };
});

afterAll(() => {
  setKodeCoreShadowGate(null);
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  if (depRoot) {
    fs.rmSync(depRoot, { recursive: true, force: true });
  }
});

const cannedGraph = () => ({
  nodes: [
    { id: 'entity:Hero', kind: 'entity', name: 'Hero', filePath: '/scripts/entities.xml', types: ['Base', 'Cell', 'Client'] },
    { id: 'def:Hero', kind: 'def', name: 'Hero', filePath: '/scripts/entity_defs/Hero.def' },
    { id: 'type:Vec3', kind: 'type', name: 'Vec3', filePath: '/scripts/entity_defs/types.xml' }
  ],
  edges: [
    { from: 'entity:Hero', to: 'def:Hero', kind: 'registration' },
    { from: 'def:Hero', to: 'type:Vec3', kind: 'property-type', label: 'pos' }
  ],
  reverseEdges: {
    'def:Hero': [{ from: 'entity:Hero', kind: 'registration' }]
  },
  paths: { entitiesXml: '/scripts/entities.xml', defsRoot: '/scripts/entity_defs', typesXml: '/scripts/entity_defs/types.xml' },
  stats: { nodeCount: 3, edgeCount: 2, entityCount: 1, defCount: 1, interfaceCount: 0, componentCount: 0, typeCount: 1, pythonCount: 0 }
});

describe('buildDependencyGraphInRust(依赖图 Rust 主路径)', () => {
  it('Rust 核心在场:契约参数含 defs/paths/categories/pythonFiles/typeImpls,返回 Rust 结果', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: cannedGraph() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const graph = await buildDependencyGraphInRust(depRoot);
      expect(graph).not.toBeNull();
      expect(graph?.nodes).toHaveLength(3);

      expect(calledMethod).toBe('$/kode/dependency/graph');
      const params = calledParams as {
        entitiesXml: string;
        typesXml: string;
        defsRoot: string;
        defs: Record<string, string>;
        paths: Record<string, string>;
        categories: Record<string, string>;
        pythonFiles: Record<string, string[]>;
        typeImpls: Record<string, string>;
      };
      expect(params.entitiesXml).toContain('<Hero');
      expect(params.typesXml).toContain('Vec3');
      expect(params.defsRoot).toContain('entity_defs');
      // 全部 def 收集(实体/接口/组件)
      expect(params.defs.Hero).toContain('<Components>');
      expect(params.defs.Monster).toContain('<Properties>');
      expect(params.defs.IMove).toContain('onMove');
      expect(params.defs.CWeapon).toContain('ammo');
      expect(params.paths.Hero).toContain('Hero.def');
      expect(params.paths.IMove).toContain('interfaces');
      expect(params.paths.CWeapon).toContain('components');
      // 分类:目录前缀 → kind
      expect(params.categories.Hero).toBe('entity');
      expect(params.categories.Monster).toBe('entity');
      expect(params.categories.IMove).toBe('interface');
      expect(params.categories.CWeapon).toBe('component');
      // python 候选:scripts/base/Hero.py 命中
      expect(params.pythonFiles.Hero).toEqual(
        expect.arrayContaining([expect.stringContaining('base')])
      );
      expect(typeof params.typeImpls).toBe('object');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const graph = await buildDependencyGraphInRust(depRoot);
    expect(graph).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const graph = await buildDependencyGraphInRust(depRoot);
      expect(graph).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果形状不合规返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: { nodes: 'nope' } })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const graph = await buildDependencyGraphInRust(depRoot);
      expect(graph).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});
