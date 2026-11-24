/**
 * kode-mcp 活性探针单测(2026-11-24 MCP 活性灯批):假进程脚本化驱动四臂
 * ——握手成功(initialize→initialized→tools/list 时序)/进程提前退出/
 * spawn 失败/预算未决(疑似挂死)。真二进制握手合同由 crates/kode-mcp/
 * tests/probe_mode.rs 钉(mock-vs-wire 两腿分工:Rust 管协议真形,TS 管
 * 驱动时序与预算臂)。
 */
import { describe, expect, it } from 'vitest';
import {
  probeKodeMcpHealth,
  type KodeMcpProbeDeps,
  type KodeMcpProbeProcess
} from '../src/kodeMcpHealthProbe';

interface FakeProcess extends KodeMcpProbeProcess {
  emitLine(line: string): void;
  emitError(error: Error): void;
  emitExit(code: number | null): void;
  writes: string[];
  killCalls: () => number;
}

const makeFake = (): FakeProcess => {
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  const writes: string[] = [];
  let kills = 0;
  return {
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk);
      },
      end: () => undefined
    },
    stdout: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          stdoutListeners.push(listener as (chunk: Buffer) => void);
        }
      }
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        errorListeners.push(listener as (error: Error) => void);
      }
      if (event === 'exit') {
        exitListeners.push(listener as (code: number | null) => void);
      }
    },
    kill: () => {
      kills += 1;
      return true;
    },
    emitLine: (line: string) => {
      for (const listener of [...stdoutListeners]) {
        listener(Buffer.from(`${line}\n`, 'utf8'));
      }
    },
    emitError: (error: Error) => {
      for (const listener of [...errorListeners]) {
        listener(error);
      }
    },
    emitExit: (code: number | null) => {
      for (const listener of [...exitListeners]) {
        listener(code);
      }
    },
    writes,
    killCalls: () => kills
  };
};

const makeDeps = (
  fake: FakeProcess
): KodeMcpProbeDeps & { spawnCalls: Array<[string, string[]]> } => {
  const spawnCalls: Array<[string, string[]]> = [];
  return {
    spawn: (command, args) => {
      spawnCalls.push([command, [...args]]);
      return fake;
    },
    budgetMs: 1000,
    spawnCalls
  };
};

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const initializeReply = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: { serverInfo: { name: 'kode-mcp', version: '0.2.0' } }
});
const toolsListReply = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: { tools: [{ name: 'search_entities' }] }
});

describe('probeKodeMcpHealth 假进程四臂', () => {
  it('成功臂:initialize 先发;id=1 应答后才发 initialized+tools/list;id=2 应答判活并 kill', async () => {
    const fake = makeFake();
    const deps = makeDeps(fake);
    const pending = probeKodeMcpHealth(deps, '/bin/kode-mcp', '/assets');
    expect(fake.writes, '应答未到前只发 initialize').toHaveLength(1);
    const init = JSON.parse(fake.writes[0]) as { id: number; method: string };
    expect(init.id).toBe(1);
    expect(init.method).toBe('initialize');
    fake.emitLine(initializeReply);
    await tick();
    expect(deps.spawnCalls[0]).toEqual(['/bin/kode-mcp', ['--probe', '/assets']]);
    expect(fake.writes, 'initialize 应答后才发后续两条').toHaveLength(3);
    expect(JSON.parse(fake.writes[1]).method).toBe('notifications/initialized');
    expect(JSON.parse(fake.writes[2]).id).toBe(2);
    fake.emitLine(toolsListReply);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(fake.killCalls(), '判活通过即收子进程').toBeGreaterThan(0);
  });

  it('提前退出臂:exit 先于应答 → 失败带原错误词', async () => {
    const fake = makeFake();
    const pending = probeKodeMcpHealth(makeDeps(fake), '/bin/kode-mcp', '/assets');
    fake.emitExit(1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exited before answering (code 1)');
    expect(fake.killCalls()).toBeGreaterThan(0);
  });

  it('spawn 失败臂:error 事件原文进 reason', async () => {
    const fake = makeFake();
    const pending = probeKodeMcpHealth(makeDeps(fake), '/missing/kode-mcp', '/assets');
    fake.emitError(new Error('spawn /missing/kode-mcp ENOENT'));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('spawn failed');
    expect(result.reason).toContain('ENOENT');
  });

  it('预算臂:进程全哑 → 预算先到,reason 缺省(疑似挂死),仍 kill', async () => {
    const fake = makeFake();
    const deps = makeDeps(fake);
    deps.budgetMs = 30;
    const pending = probeKodeMcpHealth(deps, '/bin/kode-mcp', '/assets');
    // 只回 initialize 不回 tools/list:tools/list 悬在服务面(哑的形状)
    fake.emitLine(initializeReply);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason, '预算臂=未决,不带编造原因').toBeUndefined();
    // 下沿留 timer 舍入余量(setTimeout 30ms 触发时 Date.now 差可读 29)
    expect(result.latencyMs).toBeGreaterThanOrEqual(25);
    expect(fake.killCalls(), '预算臂收尾仍不留进程').toBeGreaterThan(0);
  });

  it('非 JSON 行(服务端日志混流)被跳过不炸解析', async () => {
    const fake = makeFake();
    const pending = probeKodeMcpHealth(makeDeps(fake), '/bin/kode-mcp', '/assets');
    fake.emitLine('this is not json');
    fake.emitLine(initializeReply);
    await tick();
    expect(fake.writes.length).toBe(3);
    fake.emitLine(toolsListReply);
    const result = await pending;
    expect(result.ok).toBe(true);
  });
});
