import * as vscode from 'vscode';
import type { ProcessEntry, ProcessCommandRunner } from './debugConfig';

/**
 * 解析 `ps -axo pid=,comm=` 输出:行首 PID + 空白 + 进程名(comm 可能含空格)。
 */
export function parsePsProcesses(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) {
      const pid = Number(match[1]);
      if (Number.isFinite(pid) && pid > 0) {
        entries.push({ pid, name: match[2].trim() });
      }
    }
  }
  return entries;
}

/**
 * 解析 `tasklist /fo csv /nh` 输出:`"名","PID",...`;末列内存数带千位逗号,
 * 只取前两列,不整行 JSON 化。
 */
export function parseTasklistProcesses(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split('","');
    if (cells.length < 2) {
      continue;
    }
    const name = cells[0].replace(/^"/, '').trim();
    const pid = Number(cells[1].replace(/"$/, '').trim());
    if (name.length > 0 && Number.isFinite(pid) && pid > 0) {
      entries.push({ pid, name });
    }
  }
  return entries;
}

/**
 * 进程选择器条目组(IDE-PDBG-005 起本地与远程共用,口径锁一致):组件名
 * 命中的进程置顶并标 `$(check) `,其余随后;description=PID(选中即取它)。
 */
export function buildProcessPickItems(
  processes: ProcessEntry[],
  componentName: string
): Array<{ label: string; description: string }> {
  const needle = componentName.toLowerCase();
  const matches = processes.filter(item => item.name.toLowerCase().includes(needle));
  const rest = processes.filter(item => !item.name.toLowerCase().includes(needle));
  const toItem = (entry: ProcessEntry): { label: string; description: string } => ({
    label: entry.name,
    description: String(entry.pid)
  });
  return [
    ...matches.map(entry => ({ ...toItem(entry), label: `$(check) ${entry.name}` })),
    ...rest.map(toItem)
  ];
}

/** 选择器结果 → PID:description 承载;取消/非法值归 undefined */
export function pidFromPick(picked: { description?: string } | undefined): number | undefined {
  if (!picked) {
    return undefined;
  }
  const pid = Number(picked.description);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * 进程清单器(批112 用户令):win32 走 tasklist CSV,其余走 ps;
 * 命令失败(无 ps/无权限)返回空清单,不抛——attach 流程自己提示。
 */
export function makeProcessLister(
  run: ProcessCommandRunner,
  platform: NodeJS.Platform = process.platform
): () => ProcessEntry[] {
  return () => {
    try {
      if (platform === 'win32') {
        return parseTasklistProcesses(run('tasklist /fo csv /nh'));
      }
      return parsePsProcesses(run('ps -axo pid=,comm='));
    } catch {
      return [];
    }
  };
}

/** 远程调试目标(批112 用户令:服务器 IP 数组,点击远程弹选择) */
export interface RemoteDebugTarget {
  name: string;
  host: string;
  port: number;
  /** 路径映射(DBG-002):localRoot/remoteRoot 成对提供才落——缺一侧整对不收 */
  localRoot?: string;
  remoteRoot?: string;
}

/** debugpy 默认监听端口(debugpy --listen 不带端口时的约定值) */
export const DEFAULT_DEBUGPY_PORT = 5678;

/**
 * 读取 kbengine.debug.remoteTargets(批112 用户令):name/host 缺一不收,
 * port 缺省/非法落 debugpy 默认 5678。localRoot/remoteRoot(DBG-002)
 * 成对非空才收——映射需要两侧,半配不猜、保持省略。
 */
export function readRemoteTargets(): RemoteDebugTarget[] {
  const config = vscode.workspace.getConfiguration('kbengine');
  const raw = config.get<Array<{ name?: string; host?: string; port?: number; localRoot?: unknown; remoteRoot?: unknown }>>(
    'debug.remoteTargets',
    []
  );
  const targets: RemoteDebugTarget[] = [];
  for (const item of raw ?? []) {
    // 设置里手写的数组难免混进 null/非对象条目:先整条剔除再逐键校验
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const host = typeof item.host === 'string' ? item.host.trim() : '';
    if (name.length === 0 || host.length === 0) {
      continue;
    }
    const port = typeof item.port === 'number' && item.port > 0 ? item.port : DEFAULT_DEBUGPY_PORT;
    const localRoot = typeof item.localRoot === 'string' ? item.localRoot.trim() : '';
    const remoteRoot = typeof item.remoteRoot === 'string' ? item.remoteRoot.trim() : '';
    const target: RemoteDebugTarget = { name, host, port };
    if (localRoot.length > 0 && remoteRoot.length > 0) {
      target.localRoot = localRoot;
      target.remoteRoot = remoteRoot;
    }
    targets.push(target);
  }
  return targets;
}

/** 远程目标的 pathMappings(DBG-002):成对才有,半配/无配返回 undefined */
export function remoteTargetPathMappings(
  target: Pick<RemoteDebugTarget, 'localRoot' | 'remoteRoot'>
): Array<{ localRoot: string; remoteRoot: string }> | undefined {
  if (target.localRoot === undefined || target.remoteRoot === undefined) {
    return undefined;
  }
  return [{ localRoot: target.localRoot, remoteRoot: target.remoteRoot }];
}

/**
 * 端口模式 attach 条目名(生成、幂等合并、状态指引共用一个真源)——名字带
 * `debugpy <port>`,端口变了即新条目名,老条目不残留指向旧口的同名项。
 */
export function portLaunchEntryName(componentName: string, port: number): string {
  return `KBEngine: Python attach to ${componentName} (debugpy ${port})`;
}

/**
 * KR-AUD-42:本扩展生成条目的隐藏管理标记。updateLaunchJson 的清理只认
 * 标记,不再按「KBEngine:」名字前缀区分——前缀是用户可见文案,用户手写的
 * 同前缀条目会被误删;标记由生成面统一打下,清理只回收自己的产出。
 */
export const KBENGINE_LAUNCH_GENERATED_KEY = '_kbengineGenerated';

/** 该条目是否本扩展生成(带隐藏管理标记);用户条目/无名条目一概不算 */
export function isKbengineGeneratedEntry(item: unknown): boolean {
  return (
    item !== null &&
    typeof item === 'object' &&
    (item as Record<string, unknown>)[KBENGINE_LAUNCH_GENERATED_KEY] === true
  );
}

/** 给生成条目打隐藏管理标记(幂等,不改其余字段) */
export function withGeneratedMarker<T extends Record<string, unknown>>(entry: T): T {
  return { ...entry, [KBENGINE_LAUNCH_GENERATED_KEY]: true };
}

/**
 * 端口模式 connect 条目体(type/request/connect 三件套 = attach 断点可用的
 * 最小面;type 与仓内其余生成条目同源走 debugpy 适配器)。
 */
export function buildPortLaunchEntry(
  componentName: string,
  host: string,
  port: number,
  pathMappings: Array<{ localRoot: string; remoteRoot: string }> | undefined,
  debuggerType: string
): Record<string, unknown> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return withGeneratedMarker({
    name: portLaunchEntryName(componentName, port),
    type: debuggerType,
    request: 'attach',
    connect: { host, port },
    justMyCode: false,
    pathMappings: pathMappings || [{ localRoot: workspaceFolder, remoteRoot: workspaceFolder }],
    presentation: { group: 'KBEngine', order: 3 }
  });
}

/**
 * 同组件「旧端口」生成条目的回收:端口改了不该留一条指向死口的条目在 F5
 * 下拉里。只认本扩展生成的精确名形 `KBEngine: Python attach to <组件>
 * (debugpy <口>)`(组件名与当前口都不匹配才算陈旧)——用户条目、PID 条目、
 * 命名实例条目(`组件#实例`)、远程条目一概不动。
 */
export function dropSupersededPortEntries(
  configurations: unknown[],
  componentName: string,
  port: number
): { configurations: unknown[]; removed: number } {
  const list = Array.isArray(configurations) ? configurations : [];
  const keepName = portLaunchEntryName(componentName, port);
  const prefix = `KBEngine: Python attach to ${componentName} (debugpy `;
  let removed = 0;
  const kept = list.filter(item => {
    const name =
      item !== null && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || name === keepName || !name.startsWith(prefix)) {
      return true;
    }
    // 余下必须是 `<数字>)` 才是同组件的端口条目(命名实例/手写同前缀的不误删)
    if (!/^\d+\)$/.test(name.slice(prefix.length))) {
      return true;
    }
    removed += 1;
    return false;
  });
  return { configurations: kept, removed };
}

/**
 * launch.json 条目幂等合并(动态写入的合并口径,绝不破坏用户配置):
 * - 无同名条目 → 追加在用户条目之后;
 * - 有同名条目 → 只覆写托管字段(type/request/connect;端口/主机变了要跟着
 *   走),其余字段(presentation、pathMappings、用户手改的一切)原样保留,
 *   位置不动;已在位则 changed=false(重复调用零写入);
 * - 非 KBEngine 条目与无名条目一律不动。
 */
export function mergePortLaunchEntry(
  configurations: unknown[],
  entry: Record<string, unknown>
): { configurations: unknown[]; changed: boolean } {
  const list = Array.isArray(configurations) ? configurations : [];
  const name = typeof entry.name === 'string' ? entry.name : '';
  const index = list.findIndex(
    item => item !== null && typeof item === 'object' && (item as { name?: unknown }).name === name
  );
  if (index < 0) {
    return { configurations: [...list, entry], changed: true };
  }
  const current = list[index] as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  next.type = entry.type;
  next.request = entry.request;
  // connect 合并而非替换:用户在 connect 里手加的字段(若有)一并保留
  next.connect = {
    ...(current.connect !== null && typeof current.connect === 'object' ? current.connect : {}),
    ...(entry.connect !== null && typeof entry.connect === 'object' ? entry.connect : {})
  };
  if (current.pathMappings === undefined && entry.pathMappings !== undefined) {
    next.pathMappings = entry.pathMappings;
  }
  if (current.justMyCode === undefined && entry.justMyCode !== undefined) {
    next.justMyCode = entry.justMyCode;
  }
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (!changed) {
    return { configurations: list, changed: false };
  }
  const configurations2 = [...list];
  configurations2[index] = next;
  return { configurations: configurations2, changed };
}

/**
 * IDE-AUD-002:每次附加尝试的唯一身份。进程内单调递增,保证并发同名
 * attach(同一组件/端口或同一进程名)各自可辨——会话追踪不再只按配置名
 * 匹配(两个同名附加会互相捕获对方会话,取消其一误停他人)。
 */
let attachAttemptSeq = 0;
export function nextAttachAttemptId(): string {
  attachAttemptSeq += 1;
  return `kode-attach-${attachAttemptSeq}`;
}
