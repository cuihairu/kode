import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager, type EntityMapping, type DefinitionSymbolIdentity } from '../src/entityMapping';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 同名双域属性(引擎桶形态,2026-11-10 用户实测 BASE+Persistent 与
// ALL_CLIENTS 同文件共存):effective 合并后索引同 path 双条,解析与
// legacy mapping 面按域选条——cell 目录选 cell 域条(引擎 findCellProperty-
// Description 按桶查找同构),映射/桩面首选 client 域条。
// 分析:docs/review/2026-11-10-def-duplicate-property-and-owner-only-flags.md

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

interface PropertyDefinitionEntry {
  defFile: string;
  line: number;
  identity: DefinitionSymbolIdentity;
  domains: string[];
  persistent?: boolean;
}

interface ManagerInternals {
  findIndexedPropertyIn(
    index: unknown,
    fullPath: string,
    rootSymbol?: string,
    pythonFile?: string
  ): PropertyDefinitionEntry | null;
  toLegacyMapping(index: unknown): EntityMapping;
}

const internals = (manager: EntityMappingManager): ManagerInternals =>
  manager as unknown as ManagerInternals;

const identity = (): DefinitionSymbolIdentity => ({
  ownerKind: 'entity',
  ownerName: 'VehicleMgr',
  sourceKind: 'local',
  sourceChain: [],
  symbolName: 'inUseVehicleId',
  propertyPath: 'inUseVehicleId'
});

// BASE 条第 3 行、ALL_CLIENTS 条第 8 行,与下方夹具 def 行号一一对应
const dualIndex = (defFile: string) => ({
  rootName: 'VehicleMgr',
  rootCategory: 'entity' as const,
  rootDefFile: defFile,
  semantics: {},
  propertyDefinitions: [
    { defFile, line: 3, identity: identity(), domains: ['base'], persistent: true },
    { defFile, line: 8, identity: identity(), domains: ['cell', 'client'] }
  ] as PropertyDefinitionEntry[],
  methodDefinitions: [],
  pythonOwnerFiles: [],
  pythonMethods: []
});

const originalFindFiles = stubWorkspace.findFiles;
let root = '';
let manager: EntityMappingManager | undefined;
let defFile = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-dup-'));
  defFile = p(root, 'scripts', 'entity_defs', 'VehicleMgr.def');
  fs.mkdirSync(path.dirname(defFile), { recursive: true });
  fs.writeFileSync(defFile, [
    '<root>',                              // 1
    '  <Properties>',                      // 2
    '    <inUseVehicleId>',                // 3  BASE+Persistent 条
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </inUseVehicleId>',               // 7
    '    <inUseVehicleId>',                // 8  ALL_CLIENTS 条
    '      <Type>UINT32</Type>',
    '      <Flags>ALL_CLIENTS</Flags>',
    '    </inUseVehicleId>',               // 11
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  stubWorkspace.findFiles = async () => [];
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  manager = new EntityMappingManager({ subscriptions: [] } as never);
});

afterAll(() => {
  manager?.dispose();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('同名双域属性解析面', () => {
  it('cell 目录解析到 cell 域条,base 目录解析到 base 域条,判不出域取首条', () => {
    const target = internals(manager!);
    const index = dualIndex(defFile);

    const cellHit = target.findIndexedPropertyIn(
      index, 'inUseVehicleId', undefined, p(root, 'scripts', 'cell', 'VehicleMgr.py')
    );
    expect(cellHit!.line).toBe(8);

    const baseHit = target.findIndexedPropertyIn(
      index, 'inUseVehicleId', undefined, p(root, 'scripts', 'base', 'VehicleMgr.py')
    );
    expect(baseHit!.line).toBe(3);

    const plainHit = target.findIndexedPropertyIn(index, 'inUseVehicleId');
    expect(plainHit!.line).toBe(3);
  });

  it('rootSymbol 回退路径同样按域选条', () => {
    const target = internals(manager!);
    const hit = target.findIndexedPropertyIn(
      dualIndex(defFile), 'no.such.path', 'inUseVehicleId', p(root, 'scripts', 'cell', 'VehicleMgr.py')
    );
    expect(hit!.line).toBe(8);
  });

  it('legacy mapping 同 path 双条首选 client 域条目', () => {
    const target = internals(manager!);
    const mapping = target.toLegacyMapping(dualIndex(defFile));
    expect(mapping.properties['inUseVehicleId'].line).toBe(8);
    expect(mapping.properties['inUseVehicleId'].defFile).toBe(defFile);
  });
});
