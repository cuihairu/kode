import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { buildEntityTypeStubPlan, exportEntityTypeStubs } from '../src/entityTypeStubs';
import { getCustomTypeInfos } from '../src/definitionWorkspace';
import {
  exportKbeStubs
} from '../src/pythonStubExport';
import { exportPythonTypeStubs } from '../src/pythonTypeStubs';
import {
  configurationOverrides,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import { resetScanRootCache } from '../src/scanRoots';
import { resolveEngineRoot } from './helpers/engineRoot';
import { resolveFantasyRoot } from './helpers/fantasyRoot';

// VULN-KODE-R04:夹具根不再硬编码 /home/cui/workspaces/...(本机真跑、CI 永远 skip 的
// 假绿分叉),改由 helpers 统一解析 —— env 覆盖(KBENGINE_ROOT / KODE_FANTASY_ROOT)
// + 同级检出回退(../kbengine、../BigWorld/programming/fantasydemo/res)。
const FANTASY_ROOT = resolveFantasyRoot();
const ENGINE_ROOT = resolveEngineRoot();

const realDeps = {
  exists: (candidate: string): boolean => existsSync(candidate),
  readFile: (candidate: string): string => readFileSync(candidate, 'utf8'),
  writeFile: (candidate: string, content: string): void => writeFileSync(candidate, content),
  mkdir: (candidate: string): void => mkdirSync(candidate, { recursive: true })
};

// 夹具缺席时整组跳过(CI 无检出、或 KODE_FANTASY_ROOT/KBENGINE_ROOT=off 时);
// 有树环境(env 指向或同级检出)真跑, 675e805 起「缺席不得变红」的口径不变。
describe.skipIf(!FANTASY_ROOT || !ENGINE_ROOT)('fantasydemo real export', () => {
  // skipIf 已守卫非空;与 tests/hooks.test.ts 同款窄化
  const fantasyRoot = FANTASY_ROOT!;
  const engineRoot = ENGINE_ROOT!;
  const root = '/tmp/kode-fantasydemo-real-export';
  const stubDir = join(root, '.kbengine/stubs');

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(stubDir, { recursive: true });
    configurationOverrides.clear();
    configurationOverrides.set('kbengine', { assetsRoot: fantasyRoot });
    stubWorkspace.workspaceFolders = [{
      uri: Uri.file(root),
      name: 'fantasydemo',
      index: 0
    } as vscode.WorkspaceFolder];
    stubWorkspace.findFiles = async () => [
      'Account.def', 'Avatar.def', 'ClientOnly.def', 'Guard.def', 'Space.def'
    ].map(name => Uri.file(join(fantasyRoot, 'scripts/entity_defs', name)));
    resetScanRootCache();
  });

  afterEach(() => {
    stubWorkspace.findFiles = async () => [];
    configurationOverrides.delete('kbengine');
    resetScanRootCache();
  });

  it('exports engine typings and real alias types to the injected workspace', async () => {
    await exportKbeStubs(realDeps, {
      silent: true,
      engineRoot,
      engineRootEnv: {}
    });
    await exportPythonTypeStubs(realDeps, {
      silent: true,
      listCustomTypes: () => getCustomTypeInfos(fantasyRoot)
    });

    const kbe = readFileSync(join(stubDir, 'KBEngine.pyi'), 'utf8');
    const types = readFileSync(join(stubDir, 'scripts/entity_defs/kbe_types.pyi'), 'utf8');

    expect(kbe).toContain('generated from the local KBEngine typings checkout');
    expect(kbe).toContain('class Entity:');
    expect(kbe).toContain('from KBEngine import');
    expect(types).toContain('ANGLE = float');
    expect(types).toContain('OBJECT_ID = int');
  });

  it('builds entity method declarations from the real BigWorld def files', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext);
    await new Promise(resolve => setTimeout(resolve, 100));
    const mappings = manager.getAllMappings();
    const plan = buildEntityTypeStubPlan(mappings, getCustomTypeInfos(fantasyRoot));

    const avatar = plan.entries.find(entry => entry.entity === 'Avatar');
    const account = plan.entries.find(entry => entry.entity === 'Account');
    expect(avatar?.methods.map(method => method.name)).toEqual(['cellTick', 'fromCell', 'logOff']);
    expect(account?.methods.map(method => method.name)).toEqual(['chatMessage']);

    await exportEntityTypeStubs(manager, realDeps, {
      silent: true,
      listMappings: () => mappings,
      listCustomTypes: () => getCustomTypeInfos(fantasyRoot)
    });
    const entities = readFileSync(join(stubDir, 'entity_types.pyi'), 'utf8');
    expect(entities).toContain('def cellTick(arg1: int) -> None: ...');
    expect(entities).toContain('def fromCell(arg1: str) -> None: ...');
    expect(entities).toContain('def logOff() -> None: ...');
    expect(entities).toContain('def chatMessage(arg1: str) -> None: ...');
  });
});
