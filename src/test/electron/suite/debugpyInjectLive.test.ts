/**
 * KODE-DBG-001 方案②真机验收(--dbglive):对一台真实运行的 KBEngine
 * 引擎组件执行 debugpyInject 命令的生产路径,取证「命令真机附加成功 +
 * 断点真实命中」:
 * ① 命令面:dev host 里 kbengine.debug.debugpyInject 已注册(package.json
 *   contributes + extension.ts registerDebugpyInjectCommand 装配);
 * ② 起监听 = 生产 injectDebugpyListen(telnet :python 层发
 *   debugpy.listen,即 extension.ts startDebugpyListenerNow 的末段本体,
 *   也是命令 ensureListener 闭包同一条注入通路);
 * ③ 附加 = 生产 DebugConfigManager.attachViaDebugpyPort(探端口 →
 *   launch.json 幂等条目 → startDebugging connect,与命令
 *   attachViaDebugpyPort 闭包同一类同一法);
 * ④ 断点 = 附加后的真实 debug 会话 customRequest('setBreakpoints') 下在
 *   引擎脚本 scripts/cell/Avatar.py 的 onTimer 心跳上,由 bots 驱动的
 *   Avatar 实体 1.5s 定时器触发,DAP 'stopped'(reason=breakpoint)事件
 *   + stackTrace 顶帧 Avatar.onTimer 即命中证据。
 * 唯一脚本化的面:组件选择(QuickPick 无自动化入口,取 cellapp)与
 * 消息汇聚(逐行落 KODE_DBG_OUT 证据)。引擎不可达/监听未起/断点未命中
 * 时如实红,不冒充通过。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import * as assert from 'assert';
import { discoverLocalComponents, type KBEngineComponentInfo } from '../../../backend/kbengineProtocol';
import {
  buildDebugpyListenCommand,
  debugpyPortFor,
  injectDebugpyListen
} from '../../../autoDebugpy';
import { makeProbeOne } from '../../../telnetService';
import { defaultTcpConnect } from '../../../backend/debugpyPortProbe';
import { DebugConfigManager, SOURCE_DEFAULT_COMPONENTS } from '../../../debugConfig';
import { DEBUGPY_INJECT_COMMAND } from '../../../debugpyInjectCommand';

const evidenceOut = process.env.KODE_DBG_OUT
  ?? path.resolve(__dirname, '../../../..', 'docs/acceptance-evidence/evidence/KODE-DBG-001-real-run.log');

const BREAKPOINT_METHOD = 'onTimer';
const BREAKPOINT_ANCHOR = 'if userArg != self.TIMER_AUTOATTACK:';
const BREAKPOINT_WAIT_MS = 240000;

function ev(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
    fs.appendFileSync(evidenceOut, `${stamped}\n`);
  } catch (error) {
    console.error('证据落盘失败:', error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 端口桥拓扑首轮连接可能被 iphlpsvc 懒建抖掉,带重试(逐轮如实记录) */
async function probeStable(host: string, port: number, attempts = 3): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    const open = await makeProbeOne(3000)(host, port);
    ev(`[DBG-001] 探测 ${host}:${port} 第${i}轮 → ${open}`);
    if (open) {
      return true;
    }
    await sleep(400);
  }
  return false;
}

interface DapMessage {
  seq?: number;
  type?: string;
  event?: string;
  command?: string;
  success?: boolean;
  arguments?: unknown;
  body?: Record<string, unknown>;
}

describe('KODE-DBG-001 debugpyInject 真机验收(注入→监听→附加→断点命中)', function () {
  this.timeout(600000);

  let cellapps: KBEngineComponentInfo[] = [];
  let workspaceFs = '';
  let remoteRoot = '';
  let telnetHost = '';
  let telnetPort = 0;
  let telnetPassword = '';
  let debugpyHost = '';
  let debugpyPort = 0;
  let avatarLocalPath = '';
  let breakLine = 0;
  let session: vscode.DebugSession | undefined;
  let manager: DebugConfigManager | undefined;
  const dapSeen: DapMessage[] = [];

  const waitForStoppedBreakpoint = (): Promise<{ body: Record<string, unknown>; frames: Array<Record<string, unknown>> }> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + BREAKPOINT_WAIT_MS;
      const poll = async (): Promise<void> => {
        while (Date.now() < deadline) {
          const stopped = dapSeen.find(
            msg => msg.type === 'event' && msg.event === 'stopped'
              && (msg.body as { reason?: string } | undefined)?.reason === 'breakpoint'
          ) as { body: Record<string, unknown> } | undefined;
          if (stopped && session) {
            try {
              const threadId = (stopped.body as { threadId?: number }).threadId ?? 1;
              const stack = await session.customRequest('stackTrace', { threadId, levels: 1 });
              resolve({ body: stopped.body, frames: stack.stackFrames ?? [] });
            } catch (error) {
              reject(error);
            }
            return;
          }
          await sleep(300);
        }
        reject(new Error(`${BREAKPOINT_WAIT_MS}ms 内未收到 reason=breakpoint 的 stopped 事件(bots 未触发 Avatar.onTimer?)`));
      };
      void poll();
    });

  before(async function () {
    ev('[DBG-001] 真机验收开始');
    ev(`[DBG-001] 证据出=${evidenceOut}`);
    workspaceFs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(workspaceFs, 'dbglive 需要 KODE_DBG_WORKSPACE(引擎资产根工作区)');
    ev(`[DBG-001] 工作区=${workspaceFs}`);
    remoteRoot = process.env.KODE_DBG_REMOTE_ROOT ?? '/mnt/c/work/liv-run';
    // 本机(Windows 宿主)到 WSL 引擎的裸 loopback 转发在此机上是坏的
    // (127.0.0.1/宿主 IP 全部超时,详见 docs/acceptance-evidence),唯一
    // 稳定通路是镜像进 WSL 的 overlay 地址(wg-meshlet/ZeroTier);debugpy
    // adapter 只绑 127.0.0.1,由 WSL 侧 0.0.0.0:5679→127.0.0.1:5679 中继
    // (C:\work\liv\dbg5679-relay.py)补上这段。telnet/debugpy 主机经
    // 生产 debug.json 的 telnetHost/debugpyHost 字段声明。
    telnetHost = process.env.KODE_DBG_TELNET_HOST ?? '10.147.19.226';
    telnetPort = Number(process.env.KODE_DBG_TELNET_PORT
      ?? SOURCE_DEFAULT_COMPONENTS.find(item => item.name === 'cellapp')?.telnetPort ?? 50000);
    telnetPassword = process.env.KODE_DBG_TELNET_PASSWORD ?? '';
    debugpyHost = process.env.KODE_DBG_DEBUGPY_HOST ?? '10.147.19.226';
    debugpyPort = debugpyPortFor('cellapp') ?? 5678;
    ev(`[DBG-001] 端口表:cellapp telnet=${telnetHost}:${telnetPort} debugpy=${debugpyHost}:${debugpyPort}(autoDebugpy DEBUGPY_PORT_TABLE)`);

    // ① 真机组件发现(machine 广播,与 IDE-LIV 同一生产协议实现)
    cellapps = (await discoverLocalComponents({ host: '127.0.0.1', timeoutMs: 2000 }))
      .filter(component => component.componentType === 5);
    ev(`[DBG-001] 发现 cellapp 实例(${cellapps.length}):${cellapps
      .map(c => `${c.componentName}(id=${c.componentID},pid=${c.pid},${c.intaddr}:${c.intport})`).join('; ')}`);
    // 与 IDE-LIV 同口径:真机套件在无引擎时【跳过】而非红(默认 suite 也收
    // 这份文件,CI 无引擎时不得炸;--dbglive 下引擎须已在本机运行,缺则
    // 这里跳过,由验收流程保证引擎先起)。
    if (cellapps.length === 0) {
      ev('[DBG-001] 未发现运行中的 cellapp——引擎未在本机运行,真机套件跳过(与 IDE-LIV 同口径)');
      this.skip();
      return;
    }

    // 命令面:dev host 里命令已注册(FEAT/DBG 9620ae71 装配)
    const commands = await vscode.commands.getCommands(true);
    const registered = commands.includes(DEBUGPY_INJECT_COMMAND);
    ev(`[DBG-001] 命令注册:${DEBUGPY_INJECT_COMMAND} → ${registered}`);
    assert.ok(registered, 'kbengine.debug.debugpyInject 未在 dev host 注册');

    // 注入前置:cellapp telnet 控制台可达(引擎 :python 层入口)
    const telnetOpen = await probeStable(telnetHost, telnetPort);
    ev(`[DBG-001] cellapp telnet ${telnetHost}:${telnetPort} 可达=${telnetOpen}`);
    assert.ok(telnetOpen, `cellapp telnet 控制台 ${telnetHost}:${telnetPort} 不可达`);

    // 断点落点:引擎脚本 onTimer 心跳(由 bots 驱动的 Avatar 1.5s 定时器)
    avatarLocalPath = path.join(workspaceFs, 'scripts', 'cell', 'Avatar.py');
    assert.ok(fs.existsSync(avatarLocalPath), `引擎脚本缺 Avatar.py:${avatarLocalPath}`);
    const avatarLines = fs.readFileSync(avatarLocalPath, 'utf8').split(/\r?\n/);
    const anchorIndex = avatarLines.findIndex(line => line.includes(BREAKPOINT_ANCHOR));
    assert.ok(anchorIndex >= 0, `Avatar.py 未找到 onTimer 锚点行:${BREAKPOINT_ANCHOR}`);
    breakLine = anchorIndex + 1;
    ev(`[DBG-001] 断点落点:${avatarLocalPath}:${breakLine}(${BREAKPOINT_METHOD} 心跳判断行)`);

    // debug.json:cellapp 走端口模式 + 工作区↔WSL 路径映射(IDE-PDBG-001 配置面)
    const debugJsonPath = path.join(workspaceFs, '.kbengine', 'debug.json');
    const debugJson = {
      version: '1.0',
      debug: {
        defaultTelnetHost: '127.0.0.1',
        components: {
          cellapp: {
            telnetHost,
            telnetPort,
            ...(telnetPassword ? { telnetPassword } : {}),
            debugpyHost,
            debugpyPort,
            pathMappings: [{ localRoot: workspaceFs, remoteRoot }]
          }
        }
      }
    };
    fs.mkdirSync(path.dirname(debugJsonPath), { recursive: true });
    fs.writeFileSync(debugJsonPath, JSON.stringify(debugJson, null, 2));
    ev(`[DBG-001] debug.json 写入=${debugJsonPath} pathMappings ${workspaceFs} ↔ ${remoteRoot}`);

    // 生产 DebugConfigManager:与 extension.ts 装配同类同参,配置源同
    // (工作区 .kbengine/debug.json),供注入目标与端口模式附加共用。
    // 关键:注入 probeTcpPort 桩——attachViaDebugpyPort 内部会先对
    // debugpy 端口做 TCP 可达探测(debugConfig.ts attachViaDebugpyPort 的
    // probeTcpPort),该探测同样占用 debugpy adapter 唯一 DAP 客户端槽,
    // 必须绕开:对 debugpy host:port 直接回 {open:true} 不真连(端口真实性
    // 由 startDebugging 成功连接证明;若真没监听,startDebugging 仍如实
    // 失败,绝不假成功),其余端口(如 telnet)照常走真实探测。
    manager = new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      probeTcpPort: async (host: string, port: number, timeoutMs: number) => {
        if (host === debugpyHost && port === debugpyPort) {
          ev(`[DBG-001] 附加内部端口探测已绕开(debugpy 单客户端槽):${host}:${port} → {open:true}(不真连)`);
          return { open: true };
        }
        return defaultTcpConnect(host, port, timeoutMs);
      }
    });
    const configReadyDeadline2 = Date.now() + 8000;
    let configReady = false;
    while (Date.now() < configReadyDeadline2) {
      const config = manager.getComponentConfig('cellapp');
      if (config.debugpyPort === debugpyPort && config.pathMappings?.[0]?.remoteRoot === remoteRoot) {
        configReady = true;
        break;
      }
      await sleep(200);
    }
    ev(`[DBG-001] DebugConfigManager 配置装载(debugpyPort=${debugpyPort} pathMappings)=${configReady}`);
    assert.ok(configReady, 'DebugConfigManager 未装载 debug.json 的 cellapp 配置');

    // DAP 通道记录(DebugAdapterTracker,附加后的真实协议面)
    vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
      createDebugAdapterTracker(_session: vscode.DebugSession) {
        return {
          onDidSendMessage(message: DapMessage) {
            dapSeen.push(message);
            if (message.type === 'event' && message.event === 'stopped') {
              ev(`[DBG-001] DAP stopped 事件:${JSON.stringify(message.body)}`);
            }
            if (message.type === 'response' && message.command === 'setBreakpoints') {
              ev(`[DBG-001] DAP setBreakpoints 回包:${JSON.stringify(message.body)}`);
            }
          },
          onWillReceiveMessage(message: DapMessage) {
            if (message.command === 'setBreakpoints') {
              ev(`[DBG-001] DAP setBreakpoints 请求:${JSON.stringify(message.arguments)}`);
            }
          }
        };
      }
    });
    vscode.debug.onDidStartDebugSession(started => {
      ev(`[DBG-001] 调试会话启动:type=${started.type} name=${started.name}`);
      session = started;
    });
    vscode.debug.onDidTerminateDebugSession(terminated => {
      if (terminated === session) {
        ev('[DBG-001] 调试会话已终止');
        session = undefined;
      }
    });
  });

  it('注入 debugpy.listen → 端口真实监听 → connect 附加 → 断点命中 Avatar.onTimer', async function () {
    // ② 起监听:telnet :python 层注入(命令 ensureListener 闭包的本体通路)
    const cellappConfig = manager!.getComponentConfig('cellapp');
    const injectCommand = buildDebugpyListenCommand(debugpyPort);
    ev(`[DBG-001] 注入命令:telnet ${cellappConfig.telnetHost}:${cellappConfig.telnetPort} → ${injectCommand}`);
    const injected = await injectDebugpyListen(
      {
        host: cellappConfig.telnetHost ?? telnetHost,
        port: cellappConfig.telnetPort ?? telnetPort,
        password: cellappConfig.telnetPassword ?? ''
      },
      debugpyPort,
      // /mnt/c 9p 冷缓存下 debugpy adapter 首启回连可拖到 14s+,生产默认 8s
      // 单步超时会把「已注入成功」误判为无回执;真机套件放宽到 30s。
      { stepTimeoutMs: Number(process.env.KODE_DBG_INJECT_TIMEOUT_MS ?? 30000) }
    );
    ev(`[DBG-001] injectDebugpyListen 结果:${injected.status} detail=${injected.detail}`);
    assert.strictEqual(injected.status, 'injected', `debugpy.listen 注入失败:${injected.detail}`);

    // 监听证据:注入回执(injectDebugpyListen 已等到 listen 命令的 :python
    // 回执提示符)即 debugpy server 已监听。此处【绝不】对 debugpy 端口做
    // TCP 可达探测——debugpy 的 listen() server adapter 只接受【唯一】DAP
    // 客户端:任何裸 TCP 连接(探测即 connect+close)都会被当作 DAP 客户端
    // 占用唯一槽,断开后 adapter 不再 accept,后续 startDebugging 连的是
    // 死端口而返回 false(2026-11-07 现场证据:probe :5679→true 后
    // attachViaDebugpyPort→false ~2.5s)。所以端口真实性由「注入回执 +
    // startDebugging 成功连接」双重证明,不做独立探测。telnet 端口(50000)
    // 是独立控制台,可照常探测,无此约束。
    ev(`[DBG-001] debugpy 端口 ${debugpyHost}:${debugpyPort} 不做 TCP 探测(单客户端槽,探测会占用唯一 DAP 客户端)——以注入回执 + 附加连接为准`);

    // ③ 附加:生产 DebugConfigManager.attachViaDebugpyPort(探端口→connect)
    // debugpy 调试器扩展诊断('debugpy' 调试类型贡献方,附加失败的常见根因)
    const dbgExt = vscode.extensions.getExtension('ms-python.debugpy');
    ev(`[DBG-001] debugpy 调试器扩展:present=${!!dbgExt} isActive=${dbgExt?.isActive ?? '-'}`);
    if (dbgExt && !dbgExt.isActive) {
      try {
        await dbgExt.activate();
        ev('[DBG-001] debugpy 调试器扩展已显式激活');
      } catch (error) {
        ev(`[DBG-001] debugpy 调试器扩展激活失败:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const attached = await manager!.attachViaDebugpyPort('cellapp');
    ev(`[DBG-001] attachViaDebugpyPort('cellapp') → ${attached}`);
    assert.ok(attached, '端口模式附加未完成(attachViaDebugpyPort=false)');
    assert.ok(session, '附加完成但未捕获调试会话');
    assert.strictEqual(session!.type, 'debugpy');
    ev(`[DBG-001] 真实附加成功:session=${session!.name} type=${session!.type}`);

    // ④ 断点:等 adapter 就绪 → setBreakpoints(onTimer 心跳行)
    const deadline = Date.now() + 20000;
    let adapterReady = false;
    while (Date.now() < deadline) {
      try {
        const threads = await session!.customRequest('threads');
        if (Array.isArray(threads?.threads) && threads.threads.length > 0) {
          adapterReady = true;
          break;
        }
      } catch {
        // adapter 尚在 initialize/configuration 阶段,继续等
      }
      await sleep(500);
    }
    ev(`[DBG-001] debug adapter 就绪(threads 可查询)=${adapterReady}`);
    assert.ok(adapterReady, 'debug adapter 20s 未就绪');

    const bpResponse = await session!.customRequest('setBreakpoints', {
      source: { path: avatarLocalPath, name: 'Avatar.py' },
      breakpoints: [{ line: breakLine }]
    });
    const bpVerified = Array.isArray(bpResponse?.breakpoints)
      && bpResponse.breakpoints.some((bp: { verified?: boolean }) => bp.verified);
    ev(`[DBG-001] setBreakpoints Avatar.py:${breakLine} verified=${bpVerified}`);
    assert.ok(bpVerified, `断点未被引擎侧验证接受:${JSON.stringify(bpResponse)}`);

    // 触发:bots 驱动的 Avatar 每 1.5s 跑一次 onTimer → 断点真实命中
    const hit = await waitForStoppedBreakpoint();
    const frames = hit.frames;
    ev(`[DBG-001] 断点命中:stopped body=${JSON.stringify(hit.body)}`);
    for (const frame of frames.slice(0, 3)) {
      const source = (frame.source as { path?: string } | undefined)?.path ?? '?';
      ev(`[DBG-001] 栈帧:${frame.name} @ ${source}:${frame.line}`);
    }
    const top = frames[0];
    assert.ok(top, 'stackTrace 未返回栈帧');
    const topSource = (top.source as { path?: string } | undefined)?.path ?? '';
    assert.ok(
      top.name === BREAKPOINT_METHOD && /Avatar\.py$/.test(topSource),
      `栈顶不是 ${BREAKPOINT_METHOD}:${top.name} @ ${topSource}:${top.line}`
    );
    ev(`[DBG-001] 断点真实命中确认:${BREAKPOINT_METHOD} @ ${topSource}:${top.line}(bots 触发)`);

    // 立即放行,避免引擎长时间暂停
    const stoppedThreadId = (hit.body as { threadId?: number }).threadId ?? 1;
    await session!.customRequest('continue', { threadId: stoppedThreadId });
    ev('[DBG-001] continue 已发,引擎恢复');

    await vscode.debug.stopDebugging(session);
    ev('[DBG-001] 附加会话断开(disconnect,引擎内 debugpy 监听保留)');
  });

  after(async function () {
    // 引擎仍在:telnet 控制台与组件广播应继续可达
    const telnetStillOpen = await probeStable(telnetHost, telnetPort);
    ev(`[DBG-001] 验收后引擎存活(cellapp telnet ${telnetHost}:${telnetPort} 可达)=${telnetStillOpen}`);
    let cellappStill = false;
    try {
      cellappStill = (await discoverLocalComponents({ host: '127.0.0.1', timeoutMs: 2000 }))
        .some(component => component.componentType === 5);
    } catch {
      cellappStill = false;
    }
    ev(`[DBG-001] 验收后 cellapp 广播仍在=${cellappStill}`);
    ev('[DBG-001] 真机验收结束');
  });
});
