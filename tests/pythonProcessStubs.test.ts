import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { parse } from 'jsonc-parser';
import { buildProcessEnvironments, syncProcessPythonConfiguration } from '../src/pythonProcessConfig';
import { pythonProcessFromPath, processApiSymbols } from '../src/backend/pythonProcess';
import { filterKbeSymbols } from '../src/kbeModuleIndex';
import { buildEntityTypeStubPlan } from '../src/entityTypeStubs';
import type { EntityMapping } from '../src/entityMapping';

const template = path.resolve(__dirname, '../typings');
const makeContext = (): vscode.ExtensionContext => {
  const memory = new Map<string, unknown>();
  return { workspaceState: { get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => { memory.set(key, value); } } } as unknown as vscode.ExtensionContext;
};

describe('process API selection', () => {
  it('maps script directory names, without matching unrelated ancestors', () => {
    expect(pythonProcessFromPath('/repo/scripts/base/Avatar.py')).toBe('base');
    expect(pythonProcessFromPath('C:\\repo\\scripts\\cell\\components\\Movement.py')).toBe('cell');
    expect(pythonProcessFromPath('/repo/scripts/bots/Avatar.py')).toBe('bots');
    expect(pythonProcessFromPath('/base/repo/scripts/common/shared.py')).toBeNull();
    expect(pythonProcessFromPath('/repo/scripts/baseapp/kbemain.py')).toBe('base');
  });

  it('uses the process catalog for TS completions and distinct createEntity signatures', () => {
    expect(filterKbeSymbols('createEntity', 'base').find(s => s.name === 'createEntity')?.signature).not.toContain('spaceID');
    expect(filterKbeSymbols('createEntity', 'cell').find(s => s.name === 'createEntity')?.signature).toContain('spaceID');
    expect(filterKbeSymbols('createEntity', 'bots')).toEqual([]);
    expect(filterKbeSymbols('addSpaceGeometryMapping', 'base')).toEqual([]);
    expect(filterKbeSymbols('Proxy', 'cell')).toEqual([]);
    expect(processApiSymbols('logger').some(s => s.name === 'executeRawDatabaseCommand')).toBe(false);
  });

  it('filters generated entity attributes and local methods by process', () => {
    const mapping = {
      name: 'Avatar', properties: { baseOnly: { line: 1 }, hp: { line: 2 } },
      propertyDefinitions: [
        { identity: { symbolName: 'baseOnly' }, typeName: 'INT32', domains: ['base'] },
        { identity: { symbolName: 'hp' }, typeName: 'INT32', domains: ['cell', 'client'] }
      ],
      methods: {
        save: [{ section: 'BaseMethods', line: 3, declaredArgs: [] }],
        move: [{ section: 'CellMethods', line: 4, declaredArgs: [], exposed: true }],
        sync: [{ section: 'ClientMethods', line: 5, declaredArgs: [] }]
      }
    } as unknown as EntityMapping;
    const base = buildEntityTypeStubPlan([mapping], [], { role: 'base' });
    const cell = buildEntityTypeStubPlan([mapping], [], { role: 'cell' });
    expect(base.entries[0].properties.map(p => p.name)).toEqual(['baseOnly']);
    expect(base.entries[0].methods.map(m => m.name)).toEqual(['save']);
    expect(cell.entries[0].properties.map(p => p.name)).toEqual(['hp']);
    expect(cell.entries[0].methods.map(m => m.name)).toEqual(['move']);
    expect(base.content).toContain('class AvatarCellMB(EntityCall):');
    expect(base.content).not.toContain('class AvatarMB(');
  });
});

describe('process Python configuration', () => {
  it('keeps sibling script and stub roots out of each role environment', () => {
    const envs = buildProcessEnvironments('/p', ['/p/scripts'], '/p/.kbengine/stubs', file =>
      ['/p/scripts/base', '/p/scripts/cell', '/p/scripts/bots'].includes(file));
    const base = envs.find(e => e.root === 'scripts/base')!;
    expect(base.extraPaths[0]).toBe('.kbengine/stubs/base');
    expect(base.extraPaths).not.toContain('scripts/cell');
    expect(base.extraPaths).not.toContain('.kbengine/stubs/cell');
  });

  it('preserves JSONC and user settings, is idempotent, and retains edited environments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-process-config-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts/base'), { recursive: true });
      const config = path.join(root, 'pyrightconfig.json');
      fs.writeFileSync(config, '{\n// keep this comment\n"pythonVersion": "3.11",\n"executionEnvironments": [{"root":"."}],\n}\n');
      const context = makeContext();
      const sync = () => syncProcessPythonConfiguration(context, root, [path.join(root, 'scripts')], path.join(root, 'custom-stubs'), ['/external/lib']);
      await sync();
      const first = fs.readFileSync(config, 'utf8');
      expect(first).toContain('// keep this comment');
      expect(parse(first).pythonVersion).toBe('3.11');
      expect(parse(first).stubPath).toBe('custom-stubs/_shared');
      expect(parse(first).executionEnvironments[0].root).toBe('scripts/base');
      expect(parse(first).executionEnvironments.at(-1).root).toBe('.');
      await sync();
      expect(fs.readFileSync(config, 'utf8')).toBe(first);
      const edited = parse(first);
      edited.executionEnvironments[0].extraPaths = ['my/custom/lib'];
      fs.writeFileSync(config, JSON.stringify(edited));
      await sync();
      expect(parse(fs.readFileSync(config, 'utf8')).executionEnvironments[0].extraPaths).toEqual(['my/custom/lib']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves user stub paths and refuses a global KBEngine package that would mask every role', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-process-custom-path-'));
    try {
      const config = path.join(root, 'pyrightconfig.json');
      const original = '{"stubPath":"my-types", "typeCheckingMode":"strict"}\n';
      fs.writeFileSync(config, original);
      await syncProcessPythonConfiguration(makeContext(), root, [], path.join(root, 'stubs'), []);
      expect(parse(fs.readFileSync(config, 'utf8')).stubPath).toBe('my-types');
      fs.mkdirSync(path.join(root, 'my-types/KBEngine'), { recursive: true });
      fs.writeFileSync(path.join(root, 'my-types/KBEngine/__init__.pyi'), '# user package');
      fs.writeFileSync(config, original);
      await syncProcessPythonConfiguration(makeContext(), root, [], path.join(root, 'stubs'), []);
      expect(fs.readFileSync(config, 'utf8')).toBe(original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

const hasPyright = spawnSync('pyright', ['--version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!hasPyright)('real Pyright process isolation', () => {
  it('accepts legal calls and diagnoses cross-process APIs in the same project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-process-pyright-'));
    try {
      const stubs = path.join(root, '.kbengine/stubs');
      fs.cpSync(template, stubs, { recursive: true });
      // Simulate an edited legacy root package: copy-if-absent preserves it,
      // but neither process nor common scripts may use this permissive face.
      fs.mkdirSync(path.join(stubs, 'KBEngine'), { recursive: true });
      fs.writeFileSync(path.join(stubs, 'KBEngine/__init__.pyi'), 'from typing import Any\ndef __getattr__(name: str) -> Any: ...\n');
      const samples: Record<string, string> = {
        base: `import KBEngine\nfrom typing import assert_type\ne = KBEngine.Entity()\nassert_type(e.id, int)\nassert_type(e.cellData, dict[str, object])  # replaced below\nKBEngine.createEntity("Avatar", {})\nKBEngine.listPathRes("scripts", ["py", "xml"])\nKBEngine.EntityComponent().owner.id\nKBEngine.addSpaceGeometryMapping(1, None, "world")  # EXPECT_ERROR\n`,
        cell: `import KBEngine\nfrom typing import assert_type\ne = KBEngine.Entity()\nassert_type(e.position, KBEngine.Vector3)\nassert_type(e.position.x, float)\nassert_type(KBEngine.raycast(1, (0, 0, 0), (1, 0, 1)), tuple[tuple[float, float, float], ...] | None)\ne.position = KBEngine.Vector3()\ne.direction = KBEngine.Vector3((0, 0, 0))\nKBEngine.createEntity("Avatar", 1, (0, 0, 0), (0, 0, 0))\nKBEngine.EntityComponent().owner.id\nKBEngine.charge("order", 1, b"", print)  # EXPECT_ERROR\n`,
        bots: `import KBEngine\nfrom typing import assert_type\nKBEngine.addBots(1)\ne = KBEngine.Entity()\nassert_type(e.id, int)\nKBEngine.player()\nKBEngine.createEntity("Avatar")  # EXPECT_ERROR\n`,
        logger: `import KBEngine\nKBEngine.addTimer(1.0, 0.0, print)\nKBEngine.executeRawDatabaseCommand("SELECT 1")  # EXPECT_ERROR\n`,
        common: `import KBEngine\nKBEngine.Vector3()\nKBEngine.createEntity("Avatar")  # EXPECT_ERROR\n`
      };
      const mapping = {
        name: 'Avatar', properties: { baseOnly: { line: 1 }, hp: { line: 2 } },
        propertyDefinitions: [
          { identity: { symbolName: 'baseOnly' }, typeName: 'INT32', domains: ['base'] },
          { identity: { symbolName: 'hp' }, typeName: 'INT32', domains: ['cell', 'client'] }
        ],
        methods: {
          save: [{ section: 'BaseMethods', line: 3, declaredArgs: [] }],
          move: [{ section: 'CellMethods', line: 4, declaredArgs: [], exposed: true }]
        }
      } as unknown as EntityMapping;
      for (const role of ['base', 'cell', 'bots', 'client'] as const) {
        const plan = buildEntityTypeStubPlan([mapping], [], { role: role === 'bots' ? 'client' : role });
        fs.writeFileSync(path.join(stubs, role, 'entity_types.pyi'), plan.content!);
        if (role in samples) {
          samples[role] += `from entity_types import Avatar\nassert_type(Avatar().${role === 'base' ? 'baseOnly' : 'hp'}, int)\n`;
        }
      }
      samples.base = samples.base.replace('assert_type(e.cellData, dict[str, object])  # replaced below', 'assert_type(e.cellData, dict[str, Any])').replace('from typing import assert_type', 'from typing import assert_type, Any');
      const expected = new Set<string>();
      for (const [role, source] of Object.entries(samples)) {
        const dir = path.join(root, 'scripts', role);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'probe.py'), source);
        source.split('\n').forEach((line, index) => {
          if (line.includes('EXPECT_ERROR')) { expected.add(`${role}:${index}`); }
        });
      }
      fs.writeFileSync(path.join(root, 'pyrightconfig.json'), JSON.stringify({
        include: ['scripts', ...['base', 'cell', 'bots', 'client'].map(role => `.kbengine/stubs/${role}/entity_types.pyi`)],
        pythonVersion: '3.11', typeCheckingMode: 'strict'
      }));
      await syncProcessPythonConfiguration(makeContext(), root, [path.join(root, 'scripts')], stubs, []);
      const result = spawnSync('pyright', ['--outputjson', '-p', root], { encoding: 'utf8', timeout: 20000 });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout);
      const errors = report.generalDiagnostics.filter((d: { severity: string }) => d.severity === 'error');
      const actual = new Set(errors.map((d: { file: string; range: { start: { line: number } } }) => `${path.basename(path.dirname(d.file))}:${d.range.start.line}`));
      expect(actual, JSON.stringify(errors, null, 2)).toEqual(expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('checks every shipped .pyi for unresolved annotations and invalid overrides', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-shipped-typings-'));
    try {
      fs.writeFileSync(path.join(root, 'pyrightconfig.json'), JSON.stringify({
        include: [template], extraPaths: [path.join(template, 'shared')], reportMissingModuleSource: false
      }));
      const result = spawnSync('pyright', ['--pythonversion', '3.11', '--outputjson', '-p', root], { encoding: 'utf8', timeout: 20000 });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout);
      expect(report.summary.errorCount, JSON.stringify(report.generalDiagnostics, null, 2)).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
