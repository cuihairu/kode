//! PA-007 第二增量:协议 Schema 建图计划/执行/串行器/装配面。
//! CLI 输入契约(= kode-kbengine schema build 的参数面)与自动重建装配
//! (watcher × 项目根过滤 × 合并器 × 串行器)全部用假 run/假 watcher 锁定。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allFileSystemWatchers, workspace } from './fake-vscode/workspaceState';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspaceEvents } from './fake-vscode/workspaceState';
import { resetScanRootCache } from '../src/scanRoots';
import {
  BUILD_SCHEMA_COMMAND,
  SCHEMA_OUT_FILENAME,
  createSchemaBuildScheduler,
  resolveSchemaBuildPlan,
  runProtocolSchemaBuild,
  setupProtocolSchemaSync,
  wireProtocolSchemaAutoBuild,
  type SchemaBuildOutcome,
  type SchemaBuildPlan
} from '../src/protocolSchemaSync';
import { PROTOCOL_CHANNEL_NAME, type ProtocolToolingDeps, type RunBinary } from '../src/protocolTooling';

// ---------------------------------------------------------------- fixtures

const CLI = '/opt/kode/kode-kbengine';

/** 按 (file, args) 分发的假 run:未命中的调用一律 ENOENT 收敛。 */
const fakeRun =
  (table: Record<string, { code?: number; stdout?: string; stderr?: string }>): RunBinary =>
  async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const out = table[key];
    if (out === undefined) {
      return { code: -1, stdout: '', stderr: '' };
    }
    return { code: out.code ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };

const makeDeps = (
  table: Record<string, { code?: number; stdout?: string; stderr?: string }>,
  overrides: Partial<{ cliPath: string; extensionRoot: string }> = {}
): ProtocolToolingDeps => ({
  run: fakeRun(table),
  tsharkPath: 'tshark',
  wiresharkPath: 'wireshark',
  cliPath: overrides.cliPath ?? CLI,
  extensionRoot: overrides.extensionRoot ?? '/workspace/ext'
});

const versionTable = (): Record<string, { stdout: string }> => ({
  [`${CLI} --version`]: { stdout: 'kode-kbengine 0.2.0\n' }
});

const makeContext = (globalRoot: string): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  globalStorageUri: Uri.file(globalRoot)
});

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tmpRoots: string[] = [];
const makeTmpRoot = (label: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kode-pa007s2-${label}-`));
  tmpRoots.push(root);
  return root;
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  configurationOverrides.clear();
  workspaceEvents.configurationChanged.dispose();
  resetScanRootCache();
  workspace.workspaceFolders = [];
});

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- plan

describe('PA-007-2:resolveSchemaBuildPlan', () => {
  it('assembles cli/project/out on the happy path', async () => {
    const globalRoot = makeTmpRoot('gs');
    const plan = await resolveSchemaBuildPlan(
      makeDeps(versionTable()),
      globalRoot,
      () => '/proj/assets'
    );
    expect(plan).toEqual({
      kind: 'ready',
      cli: CLI,
      project: '/proj/assets',
      out: path.join(globalRoot, SCHEMA_OUT_FILENAME)
    });
  });

  it('reports honestly when the CLI is undiscovered', async () => {
    const bare = makeTmpRoot('bare-ext');
    const plan = await resolveSchemaBuildPlan(
      makeDeps({}, { cliPath: '', extensionRoot: bare }),
      '/tmp/gs'
    );
    expect(plan.kind).toBe('unavailable');
    expect(plan.kind === 'unavailable' && plan.reason).toContain('CLI 未检出');
  });

  it('reports honestly when the CLI probe fails', async () => {
    const plan = await resolveSchemaBuildPlan(makeDeps({}), '/tmp/gs'); // --version 未命中 → ENOENT
    expect(plan.kind).toBe('unavailable');
    expect(plan.kind === 'unavailable' && plan.reason).toContain('探测失败');
  });

  it('reports honestly when the assets root resolves empty', async () => {
    workspace.workspaceFolders = [{ uri: Uri.file('/w'), name: 'w', index: 0 }];
    const plan = await resolveSchemaBuildPlan(
      makeDeps(versionTable()),
      '/tmp/gs',
      () => ''
    );
    expect(plan.kind).toBe('unavailable');
    expect(plan.kind === 'unavailable' && plan.reason).toContain('资产根');
  });

  it('reports honestly with no workspace folders (default resolver)', async () => {
    // 默认 resolver(assetsRoot 配置→发现链)对空工作区返回 '';注入
    // resolver 的空语义由注入方自决(上一用例的短路已移除)。
    const plan = await resolveSchemaBuildPlan(makeDeps(versionTable()), '/tmp/gs');
    expect(plan.kind).toBe('unavailable');
    expect(plan.kind === 'unavailable' && plan.reason).toContain('资产根');
  });
});

// ----------------------------------------------------------------- build

describe('PA-007-2:runProtocolSchemaBuild', () => {
  const plan: SchemaBuildPlan = { kind: 'ready', cli: CLI, project: '/proj', out: '/gs/kbengine-schema.json' };

  it('passes the CLI contract args and reports ok', async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const outcome = await runProtocolSchemaBuild(async (file, args) => {
      seen.push({ file, args });
      return { code: 0, stdout: 'ok\n' };
    }, plan);
    expect(seen).toEqual([
      {
        file: CLI,
        args: ['schema', 'build', '--project', '/proj', '--out', '/gs/kbengine-schema.json']
      }
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe('ok');
  });

  it('attributes failures to stderr first, then stdout, then the exit code', async () => {
    const viaStderr = await runProtocolSchemaBuild(
      async () => ({ code: 1, stdout: '', stderr: 'not a KBEngine asset root\n' }),
      plan
    );
    expect(viaStderr.ok).toBe(false);
    expect(viaStderr.message).toBe('not a KBEngine asset root');

    const viaStdout = await runProtocolSchemaBuild(
      async () => ({ code: 2, stdout: 'boom line\nmore', stderr: '' }),
      plan
    );
    expect(viaStdout.message).toBe('boom line');

    const viaCode = await runProtocolSchemaBuild(async () => ({ code: 3, stdout: '', stderr: '' }), plan);
    expect(viaCode.message).toBe('exit code 3');
  });
});

// ------------------------------------------------------------- scheduler

describe('PA-007-2:createSchemaBuildScheduler', () => {
  const planA: SchemaBuildPlan = { kind: 'ready', cli: CLI, project: '/a', out: '/o/a.json' };
  const planB: SchemaBuildPlan = { kind: 'ready', cli: CLI, project: '/b', out: '/o/b.json' };

  it('coalesces in-flight requests to one trailing rebuild', async () => {
    const runs: string[] = [];
    const logs: string[] = [];
    let release!: (outcome: SchemaBuildOutcome) => void;
    const scheduler = createSchemaBuildScheduler(
      (plan) => {
        runs.push(plan.project);
        return new Promise<SchemaBuildOutcome>((resolve) => {
          release = resolve;
        });
      },
      (line) => logs.push(line)
    );

    scheduler.request(planA);
    scheduler.request(planB); // 在途 → 只记最新
    scheduler.request({ ...planB, project: '/b2' }); // 再覆盖 pending
    expect(runs).toEqual(['/a']);

    release({ ok: true, code: 0, message: '' });
    await settle(10);
    // 尾随重建拿的是最后一份计划,不排队放大
    expect(runs).toEqual(['/a', '/b2']);
    expect(logs.some((line) => line.includes('schema build ok'))).toBe(true);
  });

  it('does not schedule a trailing rebuild without pending requests', async () => {
    const runs: string[] = [];
    let release!: (outcome: SchemaBuildOutcome) => void;
    const scheduler = createSchemaBuildScheduler(
      (plan) => {
        runs.push(plan.project);
        return new Promise<SchemaBuildOutcome>((resolve) => {
          release = resolve;
        });
      },
      () => {}
    );
    scheduler.request(planA);
    release({ ok: false, code: 1, message: 'x' });
    await settle(10);
    expect(runs).toEqual(['/a']);
  });
});

// ---------------------------------------------------------------- wiring

describe('PA-007-2:自动重建装配(wireProtocolSchemaAutoBuild)', () => {
  /** 项目根解析走真实 resolveAssetsRootForWorkspace(默认注入),配置面给真实
   * tmp 资产根(目录存在即用,与生产同链路)。 */
  const setAssetsRootOverride = (root: string): void => {
    const current = (configurationOverrides.get('kbengine') as Record<string, unknown>) ?? {};
    configurationOverrides.set('kbengine', { ...current, assetsRoot: root });
  };

  it('rebuilds via the CLI contract for protocol files inside the project root', async () => {
    const root = makeTmpRoot('proj');
    const globalRoot = makeTmpRoot('gs');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'w', index: 0 }];
    setAssetsRootOverride(root);
    const seen: Array<{ file: string; args: string[] }> = [];
    const run: RunBinary = async (file, args) => {
      seen.push({ file, args });
      if (args[0] === '--version') {
        return { code: 0, stdout: 'kode-kbengine 0.2.0\n', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const disposable = wireProtocolSchemaAutoBuild(makeContext(globalRoot), {
      deps: () => ({ ...makeDeps(versionTable()), run }),
      globalStoragePath: () => globalRoot,
      mergerWindowMs: 5
    });
    try {
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireChange(Uri.file(path.join(root, 'scripts', 'entity_defs', 'Avatar.def')));
      await settle();
      const buildCalls = seen.filter((call) => call.args[0] === 'schema');
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0].args).toEqual([
        'schema',
        'build',
        '--project',
        root,
        '--out',
        path.join(globalRoot, SCHEMA_OUT_FILENAME)
      ]);
    } finally {
      disposable.dispose();
    }
  });

  it('ignores protocol files outside the project root', async () => {
    const root = makeTmpRoot('proj2');
    const globalRoot = makeTmpRoot('gs2');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'w', index: 0 }];
    setAssetsRootOverride(root);
    const seen: Array<string> = [];
    const disposable = wireProtocolSchemaAutoBuild(makeContext(globalRoot), {
      deps: () => ({
        ...makeDeps(versionTable()),
        run: async (file) => {
          seen.push(file);
          return { code: 0, stdout: 'ok' };
        }
      }),
      globalStoragePath: () => globalRoot,
      mergerWindowMs: 5
    });
    try {
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireChange(Uri.file('/elsewhere/fixtures/Other.def'));
      await settle();
      expect(seen).toEqual([]);
    } finally {
      disposable.dispose();
    }
  });

  it('watches only protocol definition globs (python changes never trigger)', () => {
    const globalRoot = makeTmpRoot('gs3');
    const disposable = wireProtocolSchemaAutoBuild(makeContext(globalRoot), {
      deps: () => makeDeps(versionTable()),
      globalStoragePath: () => globalRoot
    });
    try {
      const patterns = allFileSystemWatchers.map((watcher) => watcher.pattern as string);
      for (const glob of ['**/*.def', '**/types.xml', '**/entities.xml', '**/alias.xml']) {
        expect(patterns).toContain(glob);
      }
      expect(patterns).not.toContain('**/*.py');
    } finally {
      disposable.dispose();
    }
  });
});

describe('PA-007-2:setupProtocolSchemaSync 装配', () => {
  const setConfig = (values: Record<string, unknown>): void => {
    const current =
      (configurationOverrides.get('kbengine') as Record<string, unknown>) ?? {};
    configurationOverrides.set('kbengine', { ...current, ...values });
  };

  it('registers the command; manual build surfaces success via notification and channel', async () => {
    const root = makeTmpRoot('proj3');
    const globalRoot = makeTmpRoot('gs4');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'w', index: 0 }];
    setConfig({ assetsRoot: root, 'protocol.cliPath': '/bin/echo' });
    const context = makeContext(globalRoot);
    setupProtocolSchemaSync(context);
    try {
      expect(commandRegistry.registeredCommandIds()).toContain(BUILD_SCHEMA_COMMAND);
      await commands.executeCommand(BUILD_SCHEMA_COMMAND);
      expect(messages.info.some((text) => text.includes('已生成'))).toBe(true);
      const channel = windowState.channels.find((item) => item.name === PROTOCOL_CHANNEL_NAME);
      expect(channel?.lines.join('\n')).toContain('manual build ok');
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
    }
  });

  it('unavailable plan surfaces a warning with the honest reason', async () => {
    const bare = makeTmpRoot('bare2');
    const globalRoot = makeTmpRoot('gs5');
    workspace.workspaceFolders = [{ uri: Uri.file(bare), name: 'w', index: 0 }];
    setConfig({ 'protocol.cliPath': '' });
    const context = makeContext(globalRoot);
    setupProtocolSchemaSync(context);
    try {
      await commands.executeCommand(BUILD_SCHEMA_COMMAND);
      expect(messages.warning.some((text) => text.includes('CLI 未检出'))).toBe(true);
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
    }
  });

  it('respects schemaAutoBuild=false (no watchers) and rewires on config change', () => {
    const root = makeTmpRoot('proj4');
    const globalRoot = makeTmpRoot('gs6');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'w', index: 0 }];
    setConfig({ assetsRoot: root, 'protocol.schemaAutoBuild': false });
    const watchersBefore = allFileSystemWatchers.length;
    const context = makeContext(globalRoot);
    setupProtocolSchemaSync(context);
    expect(allFileSystemWatchers.length).toBe(watchersBefore);

    setConfig({ 'protocol.schemaAutoBuild': true });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string): boolean =>
        section === 'kbengine.protocol.schemaAutoBuild'
    });
    const added = allFileSystemWatchers.slice(watchersBefore);
    expect(added).toHaveLength(4);
    const patterns = added.map((watcher) => watcher.pattern as string);
    for (const glob of ['**/*.def', '**/types.xml', '**/entities.xml', '**/alias.xml']) {
      expect(patterns).toContain(glob);
    }

    // 关回:watcher 拆干净
    setConfig({ 'protocol.schemaAutoBuild': false });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string): boolean =>
        section === 'kbengine.protocol.schemaAutoBuild'
    });
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });
});
