/**
 * 远程进程枚举与选择(IDE-PDBG-005):经 `ssh <host> -- ps -axo pid=,comm=`
 * 取远端进程清单,选择器口径与本地一致(共用 buildProcessPickItems,组件名
 * 命中置顶标 ✓);清单取不到如实报原因,绝不回落本地清单冒充远端。
 */

import {
  buildProcessPickItems,
  parsePsProcesses,
  pidFromPick,
  type ProcessEntry
} from './debugConfig';
import { defaultSpawnRunner, type SpawnRunner } from './pyspyDump';
import { buildSshExecArgs } from './remoteConnection';
import type { SshHostEntry } from './sshConfig';

/** 远端进程清单命令:与本地 makeProcessLister 完全同形,复用同一解析器 */
export const REMOTE_PS_ARGS = ['ps', '-axo', 'pid=,comm='];

export interface RemoteProcessListing {
  ok: boolean;
  processes?: ProcessEntry[];
  /** ok=false 时的一行可定位原因(ssh 退出码/超时/异常) */
  reason?: string;
}

/**
 * 列远端进程:ssh 前缀跑 ps,退出码非 0/异常都如实归失败(BatchMode 免密
 * 语义与隧道同口径);成功但空输出 = 空清单(远端真没有可见进程)。
 */
export async function listRemoteProcesses(
  entry: SshHostEntry,
  runner: SpawnRunner = defaultSpawnRunner,
  timeoutMs = 8000
): Promise<RemoteProcessListing> {
  const args = buildSshExecArgs(entry, REMOTE_PS_ARGS);
  try {
    const run = await runner('ssh', args, timeoutMs);
    if (run.exitCode !== 0) {
      const tail = `${run.stdout} ${run.stderr}`.trim().slice(-200);
      return {
        ok: false,
        reason: `ssh 退出码 ${run.exitCode}${tail.length > 0 ? `:${tail}` : ''}`
      };
    }
    return { ok: true, processes: parsePsProcesses(run.stdout) };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** UI 注入面:vscode 窗口面返回 Thenable(非 Promise),统一按 unknown 收(await 后再收窄) */
export interface RemoteProcessPickerDeps {
  listRemote(): Promise<RemoteProcessListing>;
  showQuickPick(
    items: Array<{ label: string; description: string }>,
    options: { placeHolder: string }
  ): unknown;
  showErrorMessage(message: string): unknown;
}

/**
 * 远程 PID 选择(对齐本地 pickProcessId):清单失败/空清单如实报错返回
 * undefined(不弹选择器、不本地兜底);有清单则组件名命中置顶 ✓。
 */
export async function pickRemoteProcessId(
  componentName: string,
  host: string,
  deps: RemoteProcessPickerDeps
): Promise<number | undefined> {
  const listing = await deps.listRemote();
  if (!listing.ok) {
    deps.showErrorMessage(
      `远端(${host})进程清单拿不到:${listing.reason ?? '未知原因'}(检查 ssh 免密登录与主机可达)`
    );
    return undefined;
  }
  const processes = listing.processes ?? [];
  if (processes.length === 0) {
    deps.showErrorMessage(`远端(${host})未获取到进程列表,无法选择(请确认目标机器上进程可见)`);
    return undefined;
  }
  const picked = (await deps.showQuickPick(buildProcessPickItems(processes, componentName), {
    placeHolder: `选择 ${componentName} 的目标进程 @${host}(✓ 匹配组件名的进程已置顶)`
  })) as { description?: string } | undefined;
  return pidFromPick(picked);
}
