// 批 A 契约(2026-11-18 巡检单 kode-ruff-format-statusbar.md):ruff format 一键
// 格式化 + Provider 自动注册(不抢默认) + 生成器直通多行化。
// 六钉子:
// ①命令对当前 .py 生效(active 文件内容→formatted 全文替换)
// ②stdin 管道契约:桥载荷 {content,fileName,ruffPath} 直传 $/kode/ruff/format,
//   available 时 formatted 必在并透传(内容无损 roundtrip 在 Rust 面钉)
// ③未装 ruff:available:false → 同意式安装询问;拒绝 → 亮手动命令,不 crash
// ④Provider 探测注册/不探测不注册(零打扰)
// ⑤defaultFormatter 已设时不弹「设为默认」提示(不抢默认)
// ⑥生成器直通:format 面可用 → 生成内容经 format 再落盘;不可用 → 原样输出(单行兼容)
import { describe, expect, it, vi } from 'vitest';
import {
  runRuffFormat,
  runRuffFormatCommand,
  ensureRuffFormatterRegistered,
  formatGeneratedPython
} from '../src/backend/ruffFormat';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

/** 最小 gate 桩:记录 method/params,按 scripted 回包。 */
const makeGate = (scripted: Record<string, unknown>): { gate: KodeCoreGate; calls: Array<{ method: string; params: unknown }> } => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const gate = {
    serveFromRust: () => true,
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const result = scripted[method];
      if (result === undefined) { return { ok: false as const, reason: 'unscripted' }; }
      return { ok: true as const, result };
    }
  } as unknown as KodeCoreGate;
  return { gate, calls };
};

describe('ruffFormat 桥契约(②载荷与回包)', () => {
  it('runRuffFormat 直传 $/kode/ruff/format,available 时 formatted 透传', async () => {
    const { gate, calls } = makeGate({
      '$/kode/ruff/format': { available: true, version: 'ruff 0.6.9', formatted: 'x = 1\n' }
    });
    setKodeCoreShadowGate(gate);
    const result = await runRuffFormat('x=1', '/w/a.py', '/venv/bin/ruff');
    expect(result).toEqual({ status: 'ok', result: { available: true, version: 'ruff 0.6.9', formatted: 'x = 1\n' } });
    expect(calls[0]).toEqual({ method: '$/kode/ruff/format', params: { content: 'x=1', fileName: '/w/a.py', ruffPath: '/venv/bin/ruff' } });
    setKodeCoreShadowGate(null);
  });

  it('回包形状异常(formatted 缺失)→ error 不装权威结果', async () => {
    const { gate } = makeGate({ '$/kode/ruff/format': { available: true } });
    setKodeCoreShadowGate(gate);
    const result = await runRuffFormat('x=1', '/w/a.py');
    expect(result.status).toBe('error');
    setKodeCoreShadowGate(null);
  });

  it('回包非对象(null)→ error:unexpected result shape', async () => {
    const { gate } = makeGate({ '$/kode/ruff/format': null });
    setKodeCoreShadowGate(gate);
    const result = await runRuffFormat('x=1', '/w/a.py');
    expect(result.status).toBe('error');
    expect((result as { reason?: string }).reason).toBe(
      'ruffFormat: unexpected result shape from rust backend'
    );
    setKodeCoreShadowGate(null);
  });

  it('无 gate → no-gate 状态(调用方按不可用处理)', async () => {
    setKodeCoreShadowGate(null);
    const result = await runRuffFormat('x=1', '/w/a.py');
    expect(result).toEqual({ status: 'no-gate' });
  });
});

describe('ruffFormat 命令编排(①③)', () => {
  const baseDeps = (over: Partial<Parameters<typeof runRuffFormatCommand>[0]> = {}) => ({
    getActivePythonFile: () => ({ fileName: '/w/a.py', content: 'x=1' }),
    applyFormattedText: vi.fn(),
    getInterpreterPath: () => '/venv/bin/python',
    runPipInstall: vi.fn(async () => ({ ok: true, output: 'ok' })),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
    channel: { appendLine: vi.fn(), show: vi.fn() },
    ...over
  });

  it('① 当前 .py → format 回包全文替换', async () => {
    const deps = baseDeps();
    const { gate } = makeGate({
      '$/kode/ruff/format': { available: true, version: 'ruff 0.6.9', formatted: 'x = 1\n' }
    });
    setKodeCoreShadowGate(gate);
    await runRuffFormatCommand(deps);
    expect(deps.applyFormattedText).toHaveBeenCalledWith('x = 1\n');
    setKodeCoreShadowGate(null);
  });

  it('非 .py 活动文件 → 零请求零编辑,如实提示', async () => {
    const deps = baseDeps({ getActivePythonFile: () => null });
    const { gate, calls } = makeGate({});
    setKodeCoreShadowGate(gate);
    await runRuffFormatCommand(deps);
    expect(calls).toHaveLength(0);
    expect(deps.applyFormattedText).not.toHaveBeenCalled();
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);
    setKodeCoreShadowGate(null);
  });

  it('③ 未装 ruff → 询问安装;同意并装成 → 重试 format 生效', async () => {
    let installed = false;
    const scripted = () => installed
      ? { available: true, version: 'ruff 0.6.9', formatted: 'x = 1\n' }
      : { available: false };
    const calls: Array<{ method: string; params: unknown }> = [];
    const gate = {
      serveFromRust: () => true,
      runInRust: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { ok: true as const, result: scripted() as unknown };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate);
    const deps = baseDeps({
      runPipInstall: vi.fn(async () => { installed = true; return { ok: true, output: 'ok' }; }),
      showInformationMessage: vi.fn(async (_m: string, ...items: string[]) => items[0])
    });
    await runRuffFormatCommand(deps);
    expect(deps.runPipInstall).toHaveBeenCalledWith('/venv/bin/python');
    expect(deps.applyFormattedText).toHaveBeenCalledWith('x = 1\n');
    expect(calls.filter(c => c.method === '$/kode/ruff/format')).toHaveLength(2);
    setKodeCoreShadowGate(null);
  });

  it('③ 拒绝安装 → 亮手动命令,不 crash 不编辑', async () => {
    const { gate } = makeGate({ '$/kode/ruff/format': { available: false } });
    setKodeCoreShadowGate(gate);
    const manual = vi.fn(async () => undefined);
    const deps = baseDeps({
      showInformationMessage: vi.fn(async (_m: string, ...items: string[]) => 'not-now')
    });
    await runRuffFormatCommand({ ...deps, showErrorMessage: vi.fn(), channel: { appendLine: vi.fn(), show: vi.fn() } } as never);
    // 拒绝路径:不安装、不编辑、不抛
    expect(deps.applyFormattedText).not.toHaveBeenCalled();
    expect(manual).not.toHaveBeenCalled();
    setKodeCoreShadowGate(null);
  });

  it('③ 同意安装但装失败 → 亮 pip 手动命令,channel 前置,不编辑', async () => {
    const { gate } = makeGate({ '$/kode/ruff/format': { available: false } });
    setKodeCoreShadowGate(gate);
    const deps = baseDeps({
      runPipInstall: vi.fn(async () => ({ ok: false, output: 'pip: error' })),
      showInformationMessage: vi.fn(async (_m: string, ...items: string[]) => items[0])
    });
    await runRuffFormatCommand(deps);
    expect(deps.runPipInstall).toHaveBeenCalledWith('/venv/bin/python');
    expect(deps.channel.appendLine).toHaveBeenCalledWith('pip: error');
    expect(deps.channel.show).toHaveBeenCalledWith(true);
    const msg = (deps.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain('pip install failed');
    expect(msg).toContain('/venv/bin/python -m pip install ruff');
    expect(deps.applyFormattedText).not.toHaveBeenCalled();
    setKodeCoreShadowGate(null);
  });

  it('桥回包 error(status!==ok)→ 亮「ruff format failed: 原因」,不编辑', async () => {
    // gate 无脚本 → {ok:false, reason:'unscripted'} → call.status==='error'。
    const { gate } = makeGate({});
    setKodeCoreShadowGate(gate);
    const deps = baseDeps();
    await runRuffFormatCommand(deps);
    const msg = (deps.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toBe('ruff format failed: unscripted');
    expect(deps.applyFormattedText).not.toHaveBeenCalled();
    setKodeCoreShadowGate(null);
  });

  it('无可选解释器时仍不可用 → 亮「装好再试」,不进安装询问', async () => {
    const { gate, calls } = makeGate({ '$/kode/ruff/format': { available: false } });
    setKodeCoreShadowGate(gate);
    const deps = baseDeps({ getInterpreterPath: () => null });
    await runRuffFormatCommand(deps);
    // 无解释器 → 同意式安装询问整块跳过(零询问零安装),只亮手动指引。
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
    expect(deps.runPipInstall).not.toHaveBeenCalled();
    const msg = (deps.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain('ruff is not installed');
    expect(deps.applyFormattedText).not.toHaveBeenCalled();
    expect(calls.filter(c => c.method === '$/kode/ruff/format')).toHaveLength(1);
    setKodeCoreShadowGate(null);
  });
});

describe('ruffFormat Provider 注册编排(④⑤)', () => {
  it('④ 探测到 ruff → 注册 document+range 两 provider(python selector)', async () => {
    const registered: Array<{ document: boolean; range: boolean }> = [];
    const deps = {
      probeRuffAvailable: async () => true,
      registerDocumentFormattingEditProvider: vi.fn(() => { registered.push({ document: true, range: false }); }),
      registerDocumentRangeFormattingEditProvider: vi.fn(() => { registered.push({ document: false, range: true }); }),
      getDefaultFormatter: () => undefined,
      showInformationMessage: vi.fn(async () => undefined)
    };
    await ensureRuffFormatterRegistered(deps as never);
    expect(registered).toHaveLength(2);
  });

  it('④ 未探测到 ruff → 不注册零打扰', async () => {
    const deps = {
      probeRuffAvailable: async () => false,
      registerDocumentFormattingEditProvider: vi.fn(),
      registerDocumentRangeFormattingEditProvider: vi.fn(),
      getDefaultFormatter: () => undefined,
      showInformationMessage: vi.fn()
    };
    await ensureRuffFormatterRegistered(deps as never);
    expect(deps.registerDocumentFormattingEditProvider).not.toHaveBeenCalled();
    expect(deps.registerDocumentRangeFormattingEditProvider).not.toHaveBeenCalled();
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it('⑤ defaultFormatter 已设 → 注册但不弹「设为默认」提示(不抢默认)', async () => {
    const deps = {
      probeRuffAvailable: async () => true,
      registerDocumentFormattingEditProvider: vi.fn(),
      registerDocumentRangeFormattingEditProvider: vi.fn(),
      getDefaultFormatter: () => 'ms-python.black-formatter',
      showInformationMessage: vi.fn(async () => undefined)
    };
    await ensureRuffFormatterRegistered(deps as never);
    expect(deps.registerDocumentFormattingEditProvider).toHaveBeenCalled();
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it('⑤ provider 本体:document/range 同链,available → 全文替换 edits', async () => {
    const { gate, calls } = makeGate({
      '$/kode/ruff/format': { available: true, version: 'ruff 0.6.9', formatted: 'x = 1\n' }
    });
    setKodeCoreShadowGate(gate);
    const providers: Array<{ provideDocumentFormattingEdits(d: unknown): Promise<unknown>; provideDocumentRangeFormattingEdits(d: unknown): Promise<unknown> }> = [];
    const deps = {
      probeRuffAvailable: async () => true,
      registerDocumentFormattingEditProvider: vi.fn((_s: unknown, p: unknown) => { providers.push(p as never); }),
      registerDocumentRangeFormattingEditProvider: vi.fn((_s: unknown, p: unknown) => { providers.push(p as never); }),
      getDefaultFormatter: () => 'ms-python.black-formatter',
      getRuffPath: () => '/venv/bin/ruff',
      showInformationMessage: vi.fn(async () => undefined)
    };
    await ensureRuffFormatterRegistered(deps as never);
    // 注册的是同一个 provider 本体(document/range 共用)。
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBe(providers[1]);
    const doc = { fileName: '/w/a.py', getText: () => 'x=1' };
    expect(await providers[0].provideDocumentFormattingEdits(doc)).toEqual([
      { range: undefined, newText: 'x = 1\n' }
    ]);
    expect(await providers[0].provideDocumentRangeFormattingEdits(doc)).toEqual([
      { range: undefined, newText: 'x = 1\n' }
    ]);
    // ruffPath 同源进桥载荷(探测/格式化一致,防探测命中而格式化落空)。
    expect(calls.every(c => (c.params as { ruffPath?: string }).ruffPath === '/venv/bin/ruff')).toBe(true);
    setKodeCoreShadowGate(null);
  });

  it('⑤ provider 本体:不可用/桥 error → undefined(不产假 edits)', async () => {
    const unavailable = makeGate({ '$/kode/ruff/format': { available: false } });
    setKodeCoreShadowGate(unavailable.gate);
    const providers: Array<{ provideDocumentFormattingEdits(d: unknown): Promise<unknown> }> = [];
    const deps = {
      probeRuffAvailable: async () => true,
      registerDocumentFormattingEditProvider: vi.fn((_s: unknown, p: unknown) => { providers.push(p as never); }),
      registerDocumentRangeFormattingEditProvider: vi.fn(),
      getDefaultFormatter: () => 'ms-python.black-formatter',
      showInformationMessage: vi.fn(async () => undefined)
    };
    await ensureRuffFormatterRegistered(deps as never);
    const doc = { fileName: '/w/a.py', getText: () => 'x=1' };
    expect(await providers[0].provideDocumentFormattingEdits(doc)).toBeUndefined();
    setKodeCoreShadowGate(null);
    // 桥 error(unscripted)同面:undefined。
    const broken = makeGate({});
    setKodeCoreShadowGate(broken.gate);
    expect(await providers[0].provideDocumentFormattingEdits(doc)).toBeUndefined();
    setKodeCoreShadowGate(null);
  });
});

describe('生成器直通 formatGeneratedPython(⑥)', () => {
  it('format 面可用 → 生成内容经 format 落盘(多行化)', async () => {
    const out = await formatGeneratedPython('x={"a":1,"b":2}', '/w/A.py', {
      runFormat: async () => ({ available: true, formatted: 'x = {\n    "a": 1,\n    "b": 2,\n}\n' })
    });
    expect(out).toBe('x = {\n    "a": 1,\n    "b": 2,\n}\n');
  });

  it('⑥ format 不可用/失败 → 原样返回(单行兼容,不抛)', async () => {
    expect(await formatGeneratedPython('x=1', '/w/A.py', { runFormat: async () => ({ available: false }) })).toBe('x=1');
    expect(await formatGeneratedPython('x=1', '/w/A.py', { runFormat: async () => { throw new Error('boom'); } })).toBe('x=1');
  });
});
