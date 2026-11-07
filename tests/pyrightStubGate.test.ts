// IDE-STUB-002(用户令批次):generated 档接 pyright——生成 stub 后调用 pyright
// (CLI 优先 `pyright`,回退 `npx --no-install pyright`;探测不可用则降级纯生成
// 并在输出面板提示),用 pyright 诊断校验生成 stub 的类型面。
// 验收:pyright 在 PATH 时 stub 经其校验(mock 注入);不可用时降级不报错。
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { exportEntityTypeStubs } from '../src/entityTypeStubs';
import {
  argUnsafeForCmdShell,
  detectPyrightCommand,
  runPyrightDiagnostics,
  PYRIGHT_CLI_CANDIDATES,
  type PyrightCommandRunner,
  type PyrightRunResult
} from '../src/pyrightStubGate';
import {
  channels,
  configurationOverrides,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

const ok = (stdout = ''): PyrightRunResult => ({ file: 'mock', args: [], exitCode: 0, stdout, stderr: '' });

/** 依赖注入的 mock runner:记录调用,按脚本应答 */
interface ScriptedRunner extends PyrightCommandRunner {
  calls: Array<{ file: string; args: string[] }>;
}
const scriptedRunner = (
  script: (file: string, args: string[]) => PyrightRunResult
): ScriptedRunner => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner = ((file: string, args: string[]) => {
    calls.push({ file, args });
    return Promise.resolve(script(file, args));
  }) as ScriptedRunner;
  runner.calls = calls;
  return runner;
};

describe('detectPyrightCommand(CLI 探测)', () => {
  const pyrightCmd = PYRIGHT_CLI_CANDIDATES[0]![0];
  const npxCandidate = PYRIGHT_CLI_CANDIDATES[1]!;
  const npxCmd = npxCandidate[0];

  it('候选顺序:pyright 优先,npx --no-install pyright 回退(平台 shim 名无关)', () => {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    expect(PYRIGHT_CLI_CANDIDATES.map(entry => entry.join(' '))).toEqual([
      `pyright${suffix}`,
      `npx${suffix} --no-install pyright`
    ]);
  });

  it('第一个 --version 成功的候选即中选', async () => {
    const runner = scriptedRunner((file, args) =>
      file === pyrightCmd && args.join(' ') === '--version' ? ok('1.1.500') : { file, args, exitCode: 1, stdout: '', stderr: 'boom' }
    );
    const detected = await detectPyrightCommand(runner);
    expect(detected).toEqual({ file: pyrightCmd, args: [] });
    expect(runner.calls.length).toBe(1);
  });

  it('pyright 不在 PATH 时回退 npx 形态', async () => {
    const runner = scriptedRunner((file, args) =>
      file === pyrightCmd ? { file, args, exitCode: 1, stdout: '', stderr: 'not found' } : ok('1.1.500')
    );
    const detected = await detectPyrightCommand(runner);
    expect(detected).toEqual({ file: npxCmd, args: npxCandidate.slice(1) });
  });

  it('全部候选失败 → null(降级纯生成)', async () => {
    const runner = scriptedRunner(() => ({ file: 'x', args: [], exitCode: 1, stdout: '', stderr: 'nope' }));
    expect(await detectPyrightCommand(runner)).toBeNull();
  });
});

describe('runPyrightDiagnostics(--outputjson 解析)', () => {
  it('解析 summary 计数与逐条诊断', async () => {
    const report = {
      summary: { errorCount: 2, warningCount: 1, informationCount: 0 },
      generalDiagnostics: [
        { file: '/ws/a.pyi', severity: 'error', message: 'bad', range: { start: { line: 3, character: 0 } } },
        { file: '/ws/a.pyi', severity: 'warning', message: 'meh', range: { start: { line: 7, character: 0 } } }
      ]
    };
    const runner = scriptedRunner(() => ok(JSON.stringify(report)));
    const result = await runPyrightDiagnostics(runner, { file: 'pyright', args: [] }, ['/ws/a.pyi']);
    expect(result.ran).toBe(true);
    expect(result.errorCount).toBe(2);
    expect(result.warningCount).toBe(1);
    expect(result.ran && result.diagnostics.map(entry => entry.message).join('\n')).toContain('bad');
    // 调用形态:--outputjson 前置,文件随后
    expect(runner.calls[0]?.args).toEqual(['--outputjson', '/ws/a.pyi']);
  });

  it('pyright 进程失败且无 JSON → ran=false + reason(不抛)', async () => {
    const runner = scriptedRunner(() => ({ file: 'x', args: [], exitCode: 2, stdout: '', stderr: 'crash' }));
    const result = await runPyrightDiagnostics(runner, { file: 'pyright', args: [] }, ['/ws/a.pyi']);
    expect(result.ran).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('exportEntityTypeStubs × pyright 接线(generated 档)', () => {
  const realDeps = {
    exists: (candidate: string): boolean => existsSync(candidate),
    readFile: (candidate: string): string => readFileSync(candidate, 'utf8'),
    writeFile: (candidate: string, content: string): void => writeFileSync(candidate, content),
    mkdir: (candidate: string): void => mkdirSync(candidate, { recursive: true })
  };
  let root = '';
  let stubDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), 'kode-pyright-gate-'));
    stubDir = join(root, '.kbengine/stubs');
    mkdirSync(stubDir, { recursive: true });
    configurationOverrides.clear();
    stubWorkspace.workspaceFolders = [{
      uri: Uri.file(root),
      name: 'ws',
      index: 0
    } as vscode.WorkspaceFolder];
  });

  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
    configurationOverrides.delete('kbengine');
    rmSync(root, { recursive: true, force: true });
  });

  const baseMapping = {
    name: 'Avatar',
    properties: { hp: { defFile: '/p/Avatar.def', line: 3 } },
    methods: {}
  } as never;

  const pyrightOption = (runner: PyrightCommandRunner) => ({
    pyright: { runner }
  });

  it('generated 档:写入后以 --outputjson 校验落盘 stub,诊断入输出通道', async () => {
    const runner = scriptedRunner((file, args) =>
      args[0] === '--version'
        ? ok('1.1.500')
        : ok(JSON.stringify({
            summary: { errorCount: 0, warningCount: 1, informationCount: 0 },
            generalDiagnostics: [
              { file: join(stubDir, 'entity_types.pyi'), severity: 'warning', message: 'stub check', range: { start: { line: 5, character: 0 } } }
            ]
          }))
    );
    const notes: string[] = [];
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => [],
      pyright: { runner, note: line => notes.push(line) }
    });
    expect(written).toEqual(['ws']);
    // 探测 + 诊断各一次
    expect(runner.calls.some(call => call.args.includes('--version'))).toBe(true);
    const diagCall = runner.calls.find(call => call.args.includes('--outputjson'));
    expect(diagCall?.args).toContain(join(stubDir, 'entity_types.pyi'));
    const lines = notes.join('\n');
    expect(lines).toContain('pyright');
    expect(lines).toContain('warning');
  });

  it('探测不可用:降级纯生成,输出通道有降级提示,导出结果不受影响', async () => {
    const runner = scriptedRunner(() => ({ file: 'x', args: [], exitCode: 1, stdout: '', stderr: 'not found' }));
    const notes: string[] = [];
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => [],
      pyright: { runner, note: line => notes.push(line) }
    });
    expect(written).toEqual(['ws']);
    expect(existsSync(join(stubDir, 'entity_types.pyi'))).toBe(true);
    const lines = notes.join('\n');
    expect(lines).toContain('pyright');
    // 降级提示,而非诊断汇总
    expect(lines).toMatch(/降级|不可用/);
  });

  it('real-source 档:不接 pyright(档位闸只认 generated)', async () => {
    configurationOverrides.set('kbengine', { 'python.stubSourceMode': 'real-source' });
    const runner = scriptedRunner(() => ok('1.1.500'));
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => [],
      ...pyrightOption(runner)
    });
    expect(written).toEqual(['ws']);
    expect(runner.calls.length).toBe(0);
  });

  it('空工作区(无任何落盘 stub)不触发 pyright', async () => {
    const runner = scriptedRunner(() => ok('1.1.500'));
    // 空 mapping + 存根目录为空 → 无可校验目标 → 不探测
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [],
      listCustomTypes: () => [],
      ...pyrightOption(runner)
    });
    expect(written).toEqual([]);
    expect(runner.calls.length).toBe(0);
  });

  it('零写(内容一致/无映射)但落盘 stub 在盘:仍触发校验', async () => {
    // IDE-STUB-002 语义:校验跟「落盘 stub 存在」走,不跟本次是否发生写入走——
    // 实体桩内容一致零写、或只有 KBEngine.pyi/kbe_types 在盘时同样校验
    writeFileSync(join(stubDir, 'entity_types.pyi'), 'class Avatar(Entity):\n    hp: int\n', 'utf8');
    const runner = scriptedRunner((file, args) =>
      args[0] === '--version'
        ? ok('1.1.500')
        : ok(JSON.stringify({ summary: { errorCount: 0, warningCount: 0, informationCount: 0 }, generalDiagnostics: [] }))
    );
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [],
      listCustomTypes: () => [],
      ...pyrightOption(runner)
    });
    expect(written).toEqual([]);
    const diagCall = runner.calls.find(call => call.args.includes('--outputjson'));
    expect(diagCall?.args).toContain(join(stubDir, 'entity_types.pyi'));
  });

  it('分件镜像全量收集:cellapp 等非 entity_defs 镜像同样进校验目标', async () => {
    // 镜像目录键按 groupCustomTypesByModule 同源枚举(源 types.xml 相对工作区
    // 的目录原样镜像),不漏 scripts/cellapp/entity_defs 这类分件落点
    const mirror = join(stubDir, 'scripts', 'cellapp', 'entity_defs', 'kbe_types.pyi');
    mkdirSync(join(mirror, '..'), { recursive: true });
    writeFileSync(mirror, 'ALIAS_A = int\n', 'utf8');
    const customType = {
      name: 'ALIAS_A',
      filePath: join(root, 'scripts', 'cellapp', 'entity_defs', 'types.xml'),
      line: 1,
      implementedByLine: 1,
      startOffset: 0,
      endOffset: 1,
      aliasType: 'UINT8',
      rawValue: 'UINT8',
      structure: { name: 'UINT8', rawValue: 'UINT8', children: [] },
      properties: []
    } as never;
    const runner = scriptedRunner((file, args) =>
      args[0] === '--version'
        ? ok('1.1.500')
        : ok(JSON.stringify({ summary: { errorCount: 0, warningCount: 0, informationCount: 0 }, generalDiagnostics: [] }))
    );
    await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => [customType],
      ...pyrightOption(runner)
    });
    const diagCall = runner.calls.find(call => call.args.includes('--outputjson'));
    expect(diagCall?.args).toContain(join(stubDir, 'entity_types.pyi'));
    expect(diagCall?.args).toContain(mirror);
  });

  it('根级 kbe_types.pyi 无条件进候选:类型清单变动后仍被校验', async () => {
    // 根级分件在盘但当前清单只有 cellapp 镜像类型('' 空键不在)→ 根级仍进
    const rootLevel = join(stubDir, 'kbe_types.pyi');
    const mirror = join(stubDir, 'scripts', 'cellapp', 'entity_defs', 'kbe_types.pyi');
    mkdirSync(join(mirror, '..'), { recursive: true });
    writeFileSync(rootLevel, 'LEGACY = int\n', 'utf8');
    writeFileSync(mirror, 'ALIAS_A = int\n', 'utf8');
    const customType = {
      name: 'ALIAS_A',
      filePath: join(root, 'scripts', 'cellapp', 'entity_defs', 'types.xml'),
      line: 1,
      implementedByLine: 1,
      startOffset: 0,
      endOffset: 1,
      aliasType: 'UINT8',
      rawValue: 'UINT8',
      structure: { name: 'UINT8', rawValue: 'UINT8', children: [] },
      properties: []
    } as never;
    const runner = scriptedRunner((file, args) =>
      args[0] === '--version'
        ? ok('1.1.500')
        : ok(JSON.stringify({ summary: { errorCount: 0, warningCount: 0, informationCount: 0 }, generalDiagnostics: [] }))
    );
    await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => [customType],
      ...pyrightOption(runner)
    });
    const diagCall = runner.calls.find(call => call.args.includes('--outputjson'));
    expect(diagCall?.args).toContain(rootLevel);
    expect(diagCall?.args).toContain(mirror);
  });

  it('argUnsafeForCmdShell:win32 shell 形态下含 % 的实参判不安全', async () => {
    // cmd.exe 对 %VAR% 做环境变量展开,双引号拦不住 → 此类路径如实降级不喂
    expect(argUnsafeForCmdShell('/ws/a.pyi')).toBe(false);
    expect(argUnsafeForCmdShell('C:\\Users\\u%TEMP%\\ws\\.kbengine\\stubs\\a.pyi')).toBe(true);
    expect(argUnsafeForCmdShell('%TEMP%')).toBe(true);
  });

  it('默认装配(未注入 pyright 面):写入后同样触发校验,行落专用输出通道', async () => {
    // 生产路径不传 options.pyright 也必须触发(装配层缺省 runner = 真 CLI,
    // 探测结果随环境:可用→诊断汇总,不可用→降级提示,两者都以 [pyright] 起头)
    // 30s 上限:缺省装配真跑 pyright/npx CLI 探测+诊断,满载下冷启动慢,
    // 5s 缺省超时是 CI flake 源(断言不变,只放宽时长)。
    const written = await exportEntityTypeStubs(new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext), realDeps, {
      silent: true,
      listMappings: () => [baseMapping],
      listCustomTypes: () => []
    });
    expect(written).toEqual(['ws']);
    const lines = channels
      .filter(channel => channel.name === 'KBEngine Stub Pyright')
      .flatMap(channel => channel.lines)
      .join('');
    expect(lines).toContain('[pyright]');
  }, 30_000);
});
