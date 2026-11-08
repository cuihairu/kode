// debugConfigAttach 系测试共享基建:vscodeStub window/debug 打桩 + 会话
// 队列 + makeManager 装配。测试文件互 import 会让 describe 重复注册,
// 故收拢在本非收集模块;各测试文件调 registerAttachTestHooks() 注册
// beforeAll/afterAll/beforeEach(vitest 按文件隔离模块实例,互不串扰)。

import { afterAll, beforeAll, beforeEach } from 'vitest';
import { DebugConfigManager, DEBUG_ATTACH_MODE_STATE_KEY } from '../../src/debugConfig';
import type * as vscode from 'vscode';
import {
  debug as stubDebug,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace,
  Uri
} from './vscodeStub';
export { memoryFileSystem, stubDebug, stubWorkspace };

export interface InputBoxOptions {
  prompt?: string;
  validateInput?: (value: string) => string | null;
}

export interface QuickPickLike {
  label: string;
  description?: string;
  mode?: string;
}

/** workspaceState 替身:模式选择记忆(IDE-PDBG-001)落这里读回 */
export class MemoryMemento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.map.keys()];
  }
  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

/** 已记住进程附加模式的 memento:既有进程选择器用例的前提(PDBG-001 起,未配置端口的首次会先问模式) */
export const seededMemento = (mode: string): MemoryMemento => {
  const memento = new MemoryMemento();
  memento.map.set(DEBUG_ATTACH_MODE_STATE_KEY, mode);
  return memento;
};

export const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showInformationMessage',
  'showErrorMessage',
  'showQuickPick',
  'showWarningMessage'
];

export const inputs: Array<string | undefined> = [];
export const inputOptions: InputBoxOptions[] = [];
export const infoQueue: Array<string | undefined> = [];
export const warnQueue: Array<string | undefined> = [];
export const pickQueue: Array<QuickPickLike | undefined> = [];
/** 每次选择器弹出的条目面(模式选择/进程选择都在此对账) */
export const pickOffers: QuickPickLike[][] = [];
/** 每次警告弹窗的 (文案, 动作清单) 面(IDE-PDBG-002 端口分诊在此对账) */
export const warnOffers: Array<{ message: string; actions: string[] }> = [];
export const messages = { info: [] as string[], error: [] as string[], warn: [] as string[] };

export interface DebugCall {
  folder: unknown;
  config: Record<string, unknown>;
  result: boolean;
  throws: Error | null;
}

export const debugCalls: DebugCall[] = [];
let debugResult = true;
let debugThrows: Error | null = null;

/** 测试体经 setter 改桩返回值(ES import 绑定只读,不能跨模块赋值) */
export const setDebugResult = (v: boolean): void => {
  debugResult = v;
};
export const setDebugThrows = (e: Error | null): void => {
  debugThrows = e;
};

/** IDE-PDBG-002 附加依赖注入面:探测/预检/安装都可控 */
export interface ManagerExtraDeps {
  probeTcpPort?: (
    host: string,
    port: number,
    timeoutMs: number
  ) => Promise<{ open: boolean; reason?: string; detail?: string }>;
  checkDebugpy?: () => Promise<{
    kind: string;
    interpreterPath: string | null;
    version: string | null;
    message: string;
  }>;
  installDebugpy?: (interpreterPath: string) => Promise<{ ok: boolean; detail: string }>;
  /** 端口模式下一步:一键起监听面(装完/端口不开的「起监听并附加」动作) */
  startDebugpyListener?: (
    componentName: string,
    port: number
  ) => Promise<{ ok: boolean; detail: string }>;
  /** IDE-PDBG-004:连接分派面(ssh 主机表/视图选中态/隧道进程) */
  listSshHosts?: () => Array<{ host: string; hostname?: string; user?: string; port?: number; proxyJump?: string }>;
  selectedServer?: () => string;
  spawnTunnel?: (args: string[]) => { onExit(cb: () => void): void; kill(): void };
}

export const makeManager = (
  processes: Array<{ pid: number; name: string }> = [],
  workspaceState: unknown = seededMemento('process-attach'),
  extraDeps: ManagerExtraDeps = {}
) =>
  new DebugConfigManager(
    { subscriptions: [], workspaceState } as unknown as vscode.ExtensionContext,
    {
      listProcesses: () => processes,
      // 端口探测缺省打「通」:既有端口模式用例都在端口可达面上(探测门是
      // IDE-PDBG-002 的产品行为,专用 describe 注入「不通」逐因分诊)
      probeTcpPort: extraDeps.probeTcpPort ?? (async () => ({ open: true })),
      ...(extraDeps.checkDebugpy ? { checkDebugpy: extraDeps.checkDebugpy } : {}),
      ...(extraDeps.installDebugpy ? { installDebugpy: extraDeps.installDebugpy } : {}),
      ...(extraDeps.startDebugpyListener
        ? { startDebugpyListener: extraDeps.startDebugpyListener }
        : {}),
      ...(extraDeps.listSshHosts ? { listSshHosts: extraDeps.listSshHosts } : {}),
      ...(extraDeps.selectedServer ? { selectedServer: extraDeps.selectedServer } : {}),
      ...(extraDeps.spawnTunnel ? { spawnTunnel: extraDeps.spawnTunnel } : {})
    }
  );

/** 本机 debugpy 预检替身(IDE-PDBG-002 分诊的注入面) */
export const preflightStatus = (
  kind: string,
  interpreterPath: string | null = '/usr/bin/python3',
  version: string | null = '1.8.0'
) => ({ kind, interpreterPath, version, message: `debugpy 预检:${kind}` });

export const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

// 构造器内 loadConfig 是异步读盘,留一个宏任务节拍让它落地
export const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** 各测试文件在 describe 前调用一次:打桩 window/debug + 每例清场 */
export function registerAttachTestHooks(): void {
  beforeAll(() => {
    for (const key of patchedKeys) {
      originalWindow[key] = windowish[key];
    }
    windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
      if (options) {
        inputOptions.push(options);
      }
      return inputs.shift();
    };
    windowish.showInformationMessage = async (message: string) => {
      messages.info.push(message);
      return infoQueue.shift();
    };
    windowish.showErrorMessage = async (message: string) => {
      messages.error.push(message);
      return undefined;
    };
    windowish.showWarningMessage = async (
      message: string,
      ...actions: string[]
    ): Promise<string | undefined> => {
      messages.warn.push(message);
      warnOffers.push({ message, actions });
      return warnQueue.shift();
    };
    windowish.showQuickPick = async (items: QuickPickLike[]) => {
      pickOffers.push(items);
      return pickQueue.shift();
    };
    (stubDebug as unknown as Record<string, unknown>).startDebugging = async (
      folder: unknown,
      config: Record<string, unknown>
    ) => {
      if (debugThrows) {
        throw debugThrows;
      }
      debugCalls.push({ folder, config, result: debugResult, throws: null });
      return debugResult;
    };
  });

  afterAll(() => {
    for (const key of patchedKeys) {
      windowish[key] = originalWindow[key];
    }
    delete (stubDebug as unknown as Record<string, unknown>).startDebugging;
  });

  beforeEach(() => {
    memoryFileSystem.reset();
    setWorkspaceAt(null);
    inputs.length = 0;
    inputOptions.length = 0;
    infoQueue.length = 0;
    warnQueue.length = 0;
    pickQueue.length = 0;
    messages.info.length = 0;
    messages.error.length = 0;
    messages.warn.length = 0;
    pickOffers.length = 0;
    warnOffers.length = 0;
    debugCalls.length = 0;
    debugResult = true;
    debugThrows = null;
  });
}
