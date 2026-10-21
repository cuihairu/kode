import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { buildEntityTypeStubPlan, exportEntityTypeStubs } from '../src/entityTypeStubs';
import { getCustomTypeInfos } from '../src/definitionWorkspace';
import {
  buildKbeStubExportContentForWorkspace,
  exportKbeStubs
} from '../src/pythonStubExport';
import { exportPythonTypeStubs } from '../src/pythonTypeStubs';
import {
  configurationOverrides,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import { resetScanRootCache } from '../src/scanRoots';

const FANTASY_ROOT = '/home/cui/workspaces/BigWorld/programming/fantasydemo/res';
const ENGINE_ROOT = '/home/cui/workspaces/kbengine';

const realDeps = {
  exists: (candidate: string): boolean => existsSync(candidate),
  readFile: (candidate: string): string => readFileSync(candidate, 'utf8'),
  writeFile: (candidate: string, content: string): void => writeFileSync(candidate, content),
  mkdir: (candidate: string): void => mkdirSync(candidate, { recursive: true })
};

describe('fantasydemo real export', () => {
  const root = '/tmp/kode-fantasydemo-real-export';
  const stubDir = join(root, '.kbengine/stubs');

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(stubDir, { recursive: true });
    configurationOverrides.clear();
    configurationOverrides.set('kbengine', { assetsRoot: FANTASY_ROOT });
    stubWorkspace.workspaceFolders = [{
      uri: Uri.file(root),
      name: 'fantasydemo',
      index: 0
    } as vscode.WorkspaceFolder];
    stubWorkspace.findFiles = async () => [
      'Account.def', 'Avatar.def', 'ClientOnly.def', 'Guard.def', 'Space.def'
    ].map(name => Uri.file(join(FANTASY_ROOT, 'scripts/entity_defs', name)));
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
      engineRoot: ENGINE_ROOT,
      engineRootEnv: {}
    });
    await exportPythonTypeStubs(realDeps, {
      silent: true,
      listCustomTypes: () => getCustomTypeInfos(FANTASY_ROOT)
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
    const plan = buildEntityTypeStubPlan(mappings, getCustomTypeInfos(FANTASY_ROOT));

    const avatar = plan.entries.find(entry => entry.entity === 'Avatar');
    const account = plan.entries.find(entry => entry.entity === 'Account');
    expect(avatar?.methods.map(method => method.name)).toEqual(['cellTick', 'fromCell', 'logOff']);
    expect(account?.methods.map(method => method.name)).toEqual(['chatMessage']);

    await exportEntityTypeStubs(manager, realDeps, {
      silent: true,
      listMappings: () => mappings,
      listCustomTypes: () => getCustomTypeInfos(FANTASY_ROOT)
    });
    const entities = readFileSync(join(stubDir, 'entity_types.pyi'), 'utf8');
    expect(entities).toContain('def cellTick(arg1: int) -> None: ...');
    expect(entities).toContain('def fromCell(arg1: str) -> None: ...');
    expect(entities).toContain('def logOff() -> None: ...');
    expect(entities).toContain('def chatMessage(arg1: str) -> None: ...');
  });
});
