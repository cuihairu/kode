import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installCommandText,
  ruffExePathForInterpreter,
  runRuffLint,
  runRuffLintCommand,
  RUFF_MAX_FILES,
  type RuffDiag,
  type RuffLintCommandDeps
} from '../src/ruffLint';
import { setKodeCoreShadowGate, type KodeCoreGate } from '../src/kodeCoreShadowFaces';

// IDE-RUST-005 A 案:.py lint via ruff shell-out。本文件锁:
// - 桥载荷契约(files/ruffPath 直传;坏形状如实 error);
// - ruffExePathForInterpreter/installCommandText 纯逻辑;
// - 命令编排:缺 ruff→同意式安装,失败亮手动命令(用户令 2026-11-06),
//   成功复检带解释器 bin 定位的 ruffPath;诊断按文件分组(干净文件清空)。
// 加密/探测定/旗标在 Rust 侧 ruff_lint_dispatch.rs 已锁,此处不重复。

function makeDeps(overrides?: Partial<RuffLintCommandDeps>): {
  deps: RuffLintCommandDeps;
  prompts: string[];
  errors: string[];
  pipCalls: string[];
  diagnosticBatches: Array<Array<{ file: string; diags: RuffDiag[] }>>;
  channelLines: string[];
} {
  const prompts: string[] = [];
  const errors: string[] = [];
  const pipCalls: string[] = [];
  const diagnosticBatches: Array<Array<{ file: string; diags: RuffDiag[] }>> = [];
  const channelLines: string[] = [];
  const deps: RuffLintCommandDeps = {
    getWorkspacePythonFiles: async () => ['/w/a.py', '/w/b.py'],
    getInterpreterPath: () => '/venv/bin/python3',
    runPipInstall: async interpreterPath => {
      pipCalls.push(interpreterPath);
      return { ok: true, output: 'Successfully installed ruff' };
    },
    showInformationMessage: async (message, ...items) => {
      prompts.push(`${message}|${items.join(',')}`);
      return 'noop';
    },
    showErrorMessage: async message => {
      errors.push(message);
      return undefined;
    },
    setDiagnostics: entries => diagnosticBatches.push(entries),
    channel: {
      appendLine: line => channelLines.push(line),
      show: () => undefined
    },
    ...overrides
  };
  return { deps, prompts, errors, pipCalls, diagnosticBatches, channelLines };
}

function fakeGate(
  responses: Array<{ available: boolean; version?: string; diags: RuffDiag[] }>,
  calls: Array<{ method: string; params: Record<string, unknown> }>
): KodeCoreGate {
  return {
    runInRust: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      const next = responses.shift() ?? { available: true, diags: [] };
      return { ok: true, result: next };
    }
  } as unknown as KodeCoreGate;
}

afterEach(() => {
  setKodeCoreShadowGate(null);
});

describe('ruffLint(桥与纯逻辑)', () => {
  it('runRuffLint 载荷契约:files/ruffPath 直传,结果形状校验', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(fakeGate([{ available: true, version: 'ruff 0.1', diags: [] }], calls));
    const call = await runRuffLint(['/w/a.py'], '/venv/bin/ruff');
    expect(call.status).toBe('ok');
    expect(calls[0].method).toBe('$/kode/ruff/lint');
    expect(calls[0].params).toEqual({ files: ['/w/a.py'], ruffPath: '/venv/bin/ruff' });
  });

  it('runRuffLint 坏形状如实 error', async () => {
    setKodeCoreShadowGate({
      runInRust: async () => ({ ok: true, result: { nope: 1 } })
    } as unknown as KodeCoreGate);
    const call = await runRuffLint(['/w/a.py']);
    expect(call.status).toBe('error');
  });

  it('ruffExePathForInterpreter:unix/win 定位与无目录回落', () => {
    expect(ruffExePathForInterpreter('/venv/bin/python3')).toBe('/venv/bin/ruff');
    expect(ruffExePathForInterpreter('C:\\venv\\Scripts\\python.exe', '\\')).toBe(
      'C:\\venv\\Scripts\\ruff.exe'
    );
    expect(ruffExePathForInterpreter('python3')).toBe('./ruff');
  });

  it('installCommandText:带空格加引号', () => {
    expect(installCommandText('/usr/bin/python3')).toBe('/usr/bin/python3 -m pip install ruff');
    expect(installCommandText('/opt/my python/python3')).toBe(
      '"/opt/my python/python3" -m pip install ruff'
    );
  });
});

describe('runRuffLintCommand(命令编排)', () => {
  it('可用:诊断按文件分组(干净文件清空)+摘要计数', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(
      fakeGate(
        [
          {
            available: true,
            version: 'ruff 0.99',
            diags: [
              {
                file: '/w/a.py', line: 2, col: 5, endLine: 2, endCol: 6,
                code: 'F841', message: 'unused x', severity: 'warning', fixable: false
              }
            ]
          }
        ],
        calls
      )
    );
    const h = makeDeps();
    const summary = await runRuffLintCommand(h.deps);
    expect(summary).toContain('ruff 0.99');
    expect(summary).toContain('1 条');
    // 首调即带解释器 bin 定位的 ruffPath。
    expect(calls[0].params.ruffPath).toBe('/venv/bin/ruff');
    expect(h.diagnosticBatches).toHaveLength(1);
    const batch = h.diagnosticBatches[0];
    expect(batch.find(e => e.file === '/w/a.py')?.diags).toHaveLength(1);
    expect(batch.find(e => e.file === '/w/b.py')?.diags).toHaveLength(0);
  });

  it('缺 ruff→同意安装→pip 失败:错误亮手动命令,通道留 pip 日志', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(fakeGate([{ available: false, diags: [] }], calls));
    const h = makeDeps();
    h.deps.showInformationMessage = async (_m, ...items) =>
      items.includes('安装(Install via pip)') ? '安装(Install via pip)' : undefined;
    const fail = { ok: false, output: 'ERROR: no network' };
    h.deps.runPipInstall = async interpreterPath => {
      h.pipCalls.push(interpreterPath);
      return fail;
    };
    const summary = await runRuffLintCommand(h.deps);
    expect(h.pipCalls).toEqual(['/venv/bin/python3']);
    expect(h.errors.join('\n')).toContain('/venv/bin/python3 -m pip install ruff');
    expect(h.channelLines.join('\n')).toContain('ERROR: no network');
    expect(summary).toContain('安装失败');
    expect(summary).toContain('/venv/bin/python3 -m pip install ruff');
  });

  it('缺 ruff→同意安装→pip 成功:复检带 ruff exe 路径并发布诊断', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(
      fakeGate(
        [
          { available: false, diags: [] },
          { available: true, version: 'ruff 0.99', diags: [] }
        ],
        calls
      )
    );
    const h = makeDeps();
    h.deps.showInformationMessage = async (_m, ...items) =>
      items.includes('安装(Install via pip)') ? '安装(Install via pip)' : undefined;
    const summary = await runRuffLintCommand(h.deps);
    expect(summary).toContain('ruff 0.99');
    expect(calls).toHaveLength(2);
    expect(calls[1].params.ruffPath).toBe('/venv/bin/ruff');
    expect(calls[1].params.files).toEqual(['/w/a.py', '/w/b.py']);
    expect(h.diagnosticBatches).toHaveLength(1);
  });

  it('缺 ruff→选手动命令:通道亮命令,不 pip 不报错', async () => {
    setKodeCoreShadowGate(fakeGate([{ available: false, diags: [] }], []));
    const h = makeDeps();
    h.deps.showInformationMessage = async (_m, ...items) =>
      items.includes('手动安装命令(Show command)') ? '手动安装命令(Show command)' : undefined;
    const summary = await runRuffLintCommand(h.deps);
    expect(h.pipCalls).toHaveLength(0);
    expect(h.channelLines.join('\n')).toContain('/venv/bin/python3 -m pip install ruff');
    expect(summary).toContain('手动安装命令已显示');
    expect(h.errors).toHaveLength(0);
  });

  it('无 .py 文件:如实摘要,不调 Rust', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(fakeGate([], calls));
    const h = makeDeps({ getWorkspacePythonFiles: async () => [] });
    const summary = await runRuffLintCommand(h.deps);
    expect(summary).toContain('没有 .py 文件');
    expect(calls).toHaveLength(0);
  });

  it(`超 ${RUFF_MAX_FILES} 文件:如实分批提示,不调 Rust`, async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setKodeCoreShadowGate(fakeGate([], calls));
    const h = makeDeps({
      getWorkspacePythonFiles: async () =>
        Array.from({ length: RUFF_MAX_FILES + 1 }, (_, i) => `/w/f${i}.py`)
    });
    const summary = await runRuffLintCommand(h.deps);
    expect(summary).toContain('超单次上限');
    expect(calls).toHaveLength(0);
  });

  it('no-gate:如实要 Rust 后端', async () => {
    const h = makeDeps();
    const summary = await runRuffLintCommand(h.deps);
    expect(summary).toContain('Rust 后端');
  });
});
