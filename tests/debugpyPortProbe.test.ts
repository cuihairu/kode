import * as net from 'net';
import { describe, expect, it } from 'vitest';
import {
  DEBUGPY_PORT_PROBE_TIMEOUT_MS,
  buildAfterInstallStillClosedMessage,
  buildManualInstallGuide,
  buildPortClosedGuidance,
  defaultDebugpyInstallRunner,
  defaultTcpConnect,
  portClosedReasonText,
  type TcpProbeResult
} from '../src/debugpyPortProbe';
import type { DebugpyPreflightStatus } from '../src/debugpyPreflight';

// IDE-PDBG-002 端口前置探测的纯函数面:未开原因归类、主因判定(端口未开 /
// 未装 debugpy 分开说)、装完仍未开与手装指引的口径、真实 TCP 探测与真实
// pip 安装的诚实失败通道(注入面在 debugConfigAttach.test.ts 对账)。

const preflight = (
  kind: DebugpyPreflightStatus['kind'],
  interpreterPath: string | null = '/usr/bin/python3',
  version: string | null = '1.8.0'
): DebugpyPreflightStatus => ({
  kind,
  interpreterPath,
  version,
  message: `debugpy 预检:${kind}`
});

const refusedProbe = (): TcpProbeResult => ({ open: false, reason: 'refused', detail: 'ECONNREFUSED' });

describe('portClosedReasonText', () => {
  it('四类未开原因各有可定位口径', () => {
    expect(portClosedReasonText({ open: false, reason: 'refused', detail: 'ECONNREFUSED' }))
      .toContain('没有进程在监听');
    expect(portClosedReasonText({ open: false, reason: 'timeout' })).toContain('超时');
    expect(portClosedReasonText({ open: false, reason: 'unresolved-host', detail: 'ENOTFOUND' }))
      .toContain('解析不了');
    expect(portClosedReasonText({ open: false, reason: 'unknown', detail: 'EPERM' }))
      .toContain('EPERM');
  });
});

describe('buildPortClosedGuidance', () => {
  it('预检就绪:归因端口未开,给起监听指引,无安装动作', () => {
    const guidance = buildPortClosedGuidance(refusedProbe(), preflight('ok'));
    expect(guidance.cause).toBe('port-not-listening');
    expect(guidance.message).toContain('debugpy 端口未开');
    expect(guidance.message).toContain('没有进程在监听');
    expect(guidance.message).toContain('debugpy.listen');
    expect(guidance.installAction).toBeUndefined();
  });

  it('未装 debugpy:两个事实分开说,给一键安装动作', () => {
    const guidance = buildPortClosedGuidance(refusedProbe(), preflight('debugpy-missing'));
    expect(guidance.cause).toBe('debugpy-missing');
    expect(guidance.message).toContain('debugpy 端口未开');
    expect(guidance.message).toContain('/usr/bin/python3');
    expect(guidance.message).toContain('没有 debugpy');
    expect(guidance.installAction).toBe('一键安装 debugpy');
  });

  it('debugpy 过老:同样归因缺包(升级面)', () => {
    const guidance = buildPortClosedGuidance(refusedProbe(), preflight('debugpy-outdated', '/usr/bin/python3', '1.6.0'));
    expect(guidance.cause).toBe('debugpy-outdated');
    expect(guidance.message).toContain('1.6.0');
    expect(guidance.message).toContain('过老');
    expect(guidance.installAction).toBe('一键安装 debugpy');
  });

  it('未找到解释器:归因解释器给设置键,无安装动作', () => {
    const guidance = buildPortClosedGuidance(refusedProbe(), preflight('interpreter-missing', null, null));
    expect(guidance.cause).toBe('interpreter-missing');
    expect(guidance.message).toContain('kbengine.python.interpreterPath');
    expect(guidance.installAction).toBeUndefined();
  });

  it('预检面不可用(null):按端口未开说,不猜', () => {
    const guidance = buildPortClosedGuidance(refusedProbe(), null);
    expect(guidance.cause).toBe('port-not-listening');
    expect(guidance.installAction).toBeUndefined();
  });
});

describe('装完仍未开与手装指引起口径', () => {
  it('装完仍未开:明说装包≠起监听,不附加', () => {
    const message = buildAfterInstallStillClosedMessage('127.0.0.1', 5678);
    expect(message).toContain('127.0.0.1:5678');
    expect(message).toContain('仍未开');
    expect(message).toContain('debugpy.listen');
  });

  it('手装指引:可复制命令 + 同步资产树 + 引擎侧起监听两步', () => {
    const guide = buildManualInstallGuide('/usr/bin/python3', 5678);
    expect(guide).toContain('/usr/bin/python3 -m pip install -U debugpy');
    expect(guide).toContain('kbengine.python.debugpySync');
    expect(guide).toContain('5678');
  });

  it('探测超时常量与 telnet 探测同口径(1.5s)', () => {
    expect(DEBUGPY_PORT_PROBE_TIMEOUT_MS).toBe(1500);
  });
});

describe('defaultTcpConnect(真实套接字)', () => {
  const withListener = async (fn: (port: number) => Promise<void>): Promise<void> => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await fn(port);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };

  it('听着的端口 open;刚关掉的端口不开', async () => {
    await withListener(async port => {
      const open = await defaultTcpConnect('127.0.0.1', port, 2000);
      expect(open.open).toBe(true);
    });

    let closedPort = 0;
    await withListener(async port => {
      closedPort = port;
    });
    const closed = await defaultTcpConnect('127.0.0.1', closedPort, 2000);
    expect(closed.open).toBe(false);
    // 内核回 RST → refused;极小概率被复用/被防火墙拦 → timeout/unknown,
    // 唯一不变式是「不开」
    expect(['refused', 'timeout', 'unknown']).toContain(closed.reason);
    // 注:unresolved-host 只经口径函数锁定(portClosedReasonText 段)——
    // 本机 DNS 可能带通配解析(.invalid 也被劫持到 sinkhole),真实解析
    // 失败不假设可复现,不测网
  }, 8000);
});

describe('defaultDebugpyInstallRunner(真实 spawn 的诚实通道)', () => {
  it('解释器起不来:如实失败(含原因),不假成功', async () => {
    const result = await defaultDebugpyInstallRunner('/nonexistent/python-bin');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('无法启动');
  }, 8000);

  it('pip 途径不可用(node 当解释器):非零退出如实报退出码与输出尾', async () => {
    // node 自身作解释器:`node -m pip ...` 必然非零退出(无 pip 模块)——
    // 正好验证失败通道把退出码与输出尾部带出来
    const result = await defaultDebugpyInstallRunner(process.execPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/pip 退出码 \d+/);
  }, 30_000);
});
