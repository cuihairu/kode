/**
 * 调试启动即 attach(用户令 2026-10-27 ③,调研已完成照做):
 * kbengine.debug.autoDebugpy(默认 false)三件套——
 * (a) kbengine.python.debugpySync 命令:核对系统 pip 的 debugpy 版本与
 *     内嵌 Python 3.12.13 兼容后,把包复制到 <assets>/scripts/common/debugpy/
 *     (python_app.cpp:167 该目录在引擎模块搜索路径第一位,site_import=0
 *     不影响 sys.path 头部插入;scripts/common 本就是引擎约定目录);
 * (b) server start 成功后逐组件连 telnet :python 层注入
 *     `import debugpy; debugpy.listen(("127.0.0.1", <port>))`;
 * (c) updateLaunchJson 生成每组件一条 debugpy attach 配置(localRoot=
 *     workspaceFolder,见 debugConfig.ts generateLaunchConfigurations)。
 *
 * 注入时机=组件 telnet 就绪即刻。局限(如实写进文档/tick):注入走 telnet
 * python 层,此时 entitydef 装载/早期 config 阶段已过——进程级第一行断点
 * 属二期(fork script.cpp 按开关早期注入,待本功能验收后另立项)。
 * 注入不占用面板的持久 telnet 会话:每次自建短命客户端,连-注-断,
 * 面板会话零感知。单组件失败只记 LogHub,不阻塞启动也不炸调用方。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KBEngineTelnetClient, type TelnetClientEvents } from './telnetClient';
import type { TelnetTarget } from './telnetService';

/** 同步开关(kbengine.debug.autoDebugpy,默认关:注入是显式 opt-in) */
export const AUTO_DEBUGPY_ENABLED_DEFAULT = false;

/**
 * debugpy 监听端口分配表(逐组件定口,避开 31000-51000 telnet 段与引擎
 * 端口;5678 是 debugpy 官方默认口,baseapp 优先占用)。
 */
export const DEBUGPY_PORT_TABLE: ReadonlyArray<{ component: string; port: number }> = [
  { component: 'baseapp', port: 5678 },
  { component: 'cellapp', port: 5679 },
  { component: 'loginapp', port: 5680 },
  { component: 'dbmgr', port: 5681 },
  { component: 'logger', port: 5682 }
];

export function debugpyPortFor(component: string): number | undefined {
  return DEBUGPY_PORT_TABLE.find(entry => entry.component === component)?.port;
}

/** 引擎内嵌 Python 版本(kbengine 编译期捆绑,调研结论 3.12.13) */
export const EMBEDDED_PYTHON_VERSION = '3.12.13';
/**
 * 支持 Python 3.12 的最低 debugpy 线(1.8.0 起官方 CI 纳入 3.12);
 * 更老版本拒绝复制,如实告警而不是复制一个起不来的包进资产树。
 */
export const MIN_DEBUGPY_VERSION = '1.8.0';

/** 语义化三段版本比较(后缀字母按 0 处理):a<b 负 / 相等 0 / a>b 正 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.split('.').slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
}

/** debugpy 注入命令(:python 层表达式,127.0.0.1 只本机可达) */
export function buildDebugpyListenCommand(port: number): string {
  return `import debugpy; debugpy.listen(("127.0.0.1", ${port}))`;
}

/** 从 debugpy/__init__.py 源文本读 __version__(目标目录在盘版本探测) */
export function readDebugpyVersionFromSource(text: string): string | null {
  const match = text.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/** workspaceState 记账键(逐目标目录拼后缀;extraPaths/jsonc 同法) */
export const DEBUGPY_SYNC_MANAGED_KEY = 'kbengine.debugpySync.managed';

/** debugpy 包应落的位置:<assets>/scripts/common/debugpy(python_app.cpp:167) */
export function debugpyPackageDir(assetsRoot: string): string {
  return path.join(assetsRoot, 'scripts', 'common', 'debugpy');
}

export interface DebugpySyncDeps {
  /** 跑一段系统 Python 代码拿 stdout(注入便于测试;默认 python3→python) */
  runPython(code: string): Promise<{ stdout: string; exitCode: number | null }>;
  exists(candidate: string): boolean;
  readFileText(candidate: string): string;
  copyTree(from: string, to: string): Promise<void>;
}

/** 探测系统 debugpy 的 python 片段:失败/未装都是非零退出+空 stdout */
const LOCATE_DEBUGPY_CODE =
  'import json,os\n' +
  'import debugpy\n' +
  'print(json.dumps({"version": debugpy.__version__, "dir": os.path.dirname(debugpy.__file__)}))\n';

const defaultRunPython = async (code: string): Promise<{ stdout: string; exitCode: number | null }> => {
  for (const command of ['python3', 'python']) {
    const result = await new Promise<{ stdout: string; exitCode: number | null } | null>(resolve => {
      try {
        const child = spawn(command, ['-c', code], { windowsHide: true });
        let stdout = '';
        child.stdout.on('data', chunk => {
          stdout += String(chunk);
        });
        child.on('error', error => {
          // 解释器不存在(ENOENT)才换下一个候选;其余按失败态返回
          resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { stdout, exitCode: 1 });
        });
        child.on('close', exitCode => resolve({ stdout, exitCode }));
      } catch {
        resolve(null);
      }
    });
    if (result !== null) {
      return result;
    }
  }
  return { stdout: '', exitCode: -1 };
};

const defaultDeps: DebugpySyncDeps = {
  runPython: defaultRunPython,
  exists: candidate => fs.existsSync(candidate),
  readFileText: candidate => fs.readFileSync(candidate, 'utf8'),
  copyTree: async (from, to) => {
    fs.cpSync(from, to, { recursive: true, force: true });
  }
};

export type DebugpySyncStatus =
  | 'synced'
  | 'skipped-same'
  | 'skipped-user'
  | 'upgraded'
  | 'error';

export interface DebugpySyncResult {
  status: DebugpySyncStatus;
  message: string;
}

/**
 * (a) 同步系统 debugpy 进资产树。只覆盖「自己写过」的目录(workspaceState
 * 记账):用户手放的目录(无记账)一律不碰;同版本跳过;自己的旧版本升级。
 * 返回如实结果,永不抛——命令层直接播报。
 */
export async function syncDebugpyPackage(
  context: Pick<vscode.ExtensionContext, 'workspaceState'>,
  assetsRoot: string,
  deps: DebugpySyncDeps = defaultDeps
): Promise<DebugpySyncResult> {
  if (!assetsRoot) {
    return { status: 'error', message: '未配置资产根(kbengine.assetsRoot),不知道该把 debugpy 复制到哪' };
  }
  const probe = await deps.runPython(LOCATE_DEBUGPY_CODE);
  if (probe.exitCode !== 0 || probe.stdout.trim().length === 0) {
    return {
      status: 'error',
      message: '系统 Python 没有可用的 debugpy 包(pip install debugpy 后重试)'
    };
  }
  let located: { version: string; dir: string };
  try {
    located = JSON.parse(probe.stdout.trim()) as { version: string; dir: string };
  } catch {
    return { status: 'error', message: `系统 Python 输出无法解析: ${probe.stdout.trim().slice(0, 120)}` };
  }
  if (compareVersions(located.version, MIN_DEBUGPY_VERSION) < 0) {
    return {
      status: 'error',
      message: `系统 debugpy ${located.version} 不支持内嵌 Python ${EMBEDDED_PYTHON_VERSION}` +
        `(需 ≥ ${MIN_DEBUGPY_VERSION};pip install -U debugpy 后重试)`
    };
  }
  if (!located.dir || !deps.exists(located.dir)) {
    return { status: 'error', message: `系统 debugpy 目录不可读: ${located.dir}` };
  }
  const targetDir = debugpyPackageDir(assetsRoot);
  const managedKey = `${DEBUGPY_SYNC_MANAGED_KEY}:${targetDir}`;
  const remembered = context.workspaceState?.get<string>(managedKey);
  if (deps.exists(targetDir)) {
    // 目录在盘:读 __init__.__version__ 判内容;读不出(非 debugpy 布局)
    // 一律视为用户手放,不动
    const initPath = path.join(targetDir, '__init__.py');
    if (!deps.exists(initPath)) {
      return { status: 'skipped-user', message: `目录已存在且不是 debugpy 包布局,视为你手放的内容,未动: ${targetDir}` };
    }
    const onDisk = readDebugpyVersionFromSource(deps.readFileText(initPath));
    if (onDisk === null) {
      return { status: 'skipped-user', message: `目录已存在但读不出 debugpy 版本,视为你手放的内容,未动: ${targetDir}` };
    }
    if (onDisk === located.version) {
      return { status: 'skipped-same', message: `debugpy ${onDisk} 已在位(${targetDir}),零写入` };
    }
    if (remembered === undefined) {
      return {
        status: 'skipped-user',
        message: `目录已有 debugpy ${onDisk}(非本扩展写入),未动;确要替换请手动删除后重跑: ${targetDir}`
      };
    }
  }
  try {
    await deps.copyTree(located.dir, targetDir);
  } catch (error) {
    return { status: 'error', message: `复制失败: ${String(error)}` };
  }
  await context.workspaceState?.update(managedKey, located.version);
  const action = remembered === undefined ? '已复制' : '已升级';
  return {
    status: remembered === undefined ? 'synced' : 'upgraded',
    message: `debugpy ${located.version} ${action}到 ${targetDir}(系统源: ${located.dir})`
  };
}

/** 注入用短命客户端面(默认 KBEngineTelnetClient;测试可换记录型) */
export interface InjectionClient {
  sendCommand(command: string): boolean;
  disconnect(): void;
}

export type InjectionClientFactory = (options: {
  host: string;
  port: number;
  password?: string;
  events: TelnetClientEvents;
}) => InjectionClient;

const defaultClientFactory: InjectionClientFactory = options =>
  new KBEngineTelnetClient(options) as unknown as InjectionClient;

export interface DebugpyInjectDeps {
  createClient?: InjectionClientFactory;
  /** 每步等待上限毫秒(默认 8000;测试可缩到毫秒级) */
  stepTimeoutMs?: number;
  /** setTimeout/clearTimeout 注入(默认真定时器) */
  schedule?: (ms: number) => Promise<void>;
}

export type DebugpyInjectStatus = 'injected' | 'failed';

export interface DebugpyInjectResult {
  status: DebugpyInjectStatus;
  detail: string;
}

/**
 * (b) 单组件注入:自建短命 telnet 客户端(不碰面板持久会话),连上等提示符
 * 就绪,`:python` 切层(engine telnet_handler.cpp :python 命令),`>>>` 就绪
 * 后发 listen 命令,静默期后断开。输出里出现 Traceback 判失败;任何一步
 * 超时/被拒都如实返回 failed,不抛。
 */
export async function injectDebugpyListen(
  target: Pick<TelnetTarget, 'host' | 'port' | 'password'>,
  port: number,
  deps: DebugpyInjectDeps = {}
): Promise<DebugpyInjectResult> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 8000;
  const schedule = deps.schedule ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const createClient = deps.createClient ?? defaultClientFactory;
  let settled = false;
  let accumulated = '';
  let sawPythonPrompt = false;
  let sawOutputAfterCommand = false;
  let failure: string | null = null;
  const client = createClient({
    host: target.host,
    port: target.port,
    password: target.password || undefined,
    events: {
      onStateChange: state => {
        if (state === 'auth-rejected') {
          failure = 'telnet 密码被拒';
        }
      },
      onData: text => {
        if (sawPythonPrompt) {
          // listen 命令之后:新提示符=执行完;Traceback=注入失败
          if (/>\s*>\s*>/.test(text)) {
            sawOutputAfterCommand = true;
          }
          if (/Traceback/.test(text)) {
            failure = `python 层报错: ${text.trim().split(/\r?\n/).slice(-3).join(' ')}`;
          }
          return;
        }
        accumulated += text;
        if (/>\s*>\s*>/.test(accumulated)) {
          sawPythonPrompt = true;
        }
      }
    }
  });
  const waitUntil = async (predicate: () => boolean, what: string): Promise<boolean> => {
    const deadline = Date.now() + stepTimeoutMs;
    while (!predicate()) {
      if (failure !== null) {
        return false;
      }
      if (Date.now() >= deadline) {
        failure = `等待${what}超时`;
        return false;
      }
      await schedule(50);
    }
    return true;
  };
  try {
    // KBEngineTelnetClient 是 connect() 之外无启动调用;工厂面保守兼容
    (client as { connect?: () => void }).connect?.();
    // 就绪判定:客户端状态由 onData 推进(prompt 检测在 telnetClient 内),
    // 这里以「任意提示符出现过」为就绪面
    if (!(await waitUntil(() => /\[[^\]]+@[^\]]+ ~\]/.test(accumulated) || sawPythonPrompt, 'telnet 提示符'))) {
      return { status: 'failed', detail: failure ?? '连接未就绪' };
    }
    // 默认层就是 python(kbengine_defaults default_layer),但 root 层也要能
    // 走::python 幂等切层,已在 python 层时引擎重设一次层状态
    if (!sawPythonPrompt) {
      client.sendCommand(':python');
      if (!(await waitUntil(() => sawPythonPrompt, ':python 层提示符'))) {
        return { status: 'failed', detail: failure ?? ':python 切层未就绪' };
      }
    }
    client.sendCommand(buildDebugpyListenCommand(port));
    if (!(await waitUntil(() => sawOutputAfterCommand, 'listen 命令回执提示符'))) {
      return {
        status: 'failed',
        detail: failure ?? `listen 命令无回执(不确认 ${port} 已监听)`
      };
    }
    if (failure !== null) {
      return { status: 'failed', detail: failure };
    }
    settled = true;
    return { status: 'injected', detail: `debugpy.listen 127.0.0.1:${port} 已执行(未验证监听)` };
  } finally {
    void settled;
    client.disconnect();
  }
}

/**
 * (b) 编排:开关闸 + 逐组件「等 telnet 就绪→注入」,多组件并行、单组件失败
 * 只记日志。永不抛(调用方是 fire-and-forget 的启动联动)。
 */
export interface DebugpyAutoInjectOptions {
  /** 逐组件日志出口(装配层传 LogHub 包装) */
  log(component: string, level: 'info' | 'warning' | 'error', text: string): void;
  /** telnet 端口连通探测(默认 makeProbeOne(1500) 同款 1.5s) */
  probe?(host: string, port: number): Promise<boolean>;
  /** 轮询间隔/就绪等待上限毫秒(默认 1000/60000) */
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  deps?: DebugpyInjectDeps;
  schedule?(ms: number): Promise<void>;
}

export function autoDebugpyEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('debug.autoDebugpy', AUTO_DEBUGPY_ENABLED_DEFAULT);
}

/**
 * 组件启动成功后的联动入口:targets 里找不到该组件(配置未开 telnet)如实
 * 记日志跳过;端口表没有该组件(machine/interfaces/bots)同样跳过。
 */
export async function injectDebugpyAfterStart(
  components: readonly string[],
  getTargets: () => readonly TelnetTarget[],
  options: DebugpyAutoInjectOptions
): Promise<void> {
  if (!autoDebugpyEnabled()) {
    return; // 默认关:零动作零日志(不惊扰没开这功能的用户)
  }
  const probe = options.probe ??
    (async (host, port) => {
      const { makeProbeOne } = await import('./telnetService');
      return makeProbeOne(1500)(host, port);
    });
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60000;
  const schedule = options.schedule ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  await Promise.all(components.map(async component => {
    const listenPort = debugpyPortFor(component);
    if (listenPort === undefined) {
      options.log(component, 'info', `autoDebugpy:组件不在端口分配表,跳过(machine/interfaces/bots 无 Python 调试面)`);
      return;
    }
    const target = getTargets().find(item => item.component === component);
    if (!target) {
      options.log(component, 'warning', 'autoDebugpy:配置未开该组件 telnet(缺 <telnet_service>),无法注入 debugpy');
      return;
    }
    // 注入时机=组件 telnet 就绪即刻:轮询端口直至就绪或超时(引擎组件
    // 起监听有先后,dbmgr/baseapp 常比 machine 晚数秒)
    const deadline = Date.now() + readyTimeoutMs;
    let open = await probe(target.host, target.port);
    while (!open && Date.now() < deadline) {
      await schedule(pollIntervalMs);
      open = await probe(target.host, target.port);
    }
    if (!open) {
      options.log(component, 'error', `autoDebugpy:telnet ${target.host}:${target.port} ${readyTimeoutMs}ms 内未就绪,放弃注入`);
      return;
    }
    const result = await injectDebugpyListen(target, listenPort, options.deps ?? {});
    if (result.status === 'injected') {
      options.log(component, 'info', `autoDebugpy:${result.detail}`);
    } else {
      options.log(component, 'error', `autoDebugpy:注入失败——${result.detail}`);
    }
  }));
}
