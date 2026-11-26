/**
 * Remote process enumeration and selection (IDE-PDBG-005): fetch the remote process
 * list via `ssh <host> -- ps -axo pid=,comm=`, with the picker ruling matching the
 * local one (shared buildProcessPickItems, a component-name hit pinned to the top
 * with ✓); when the list cannot be fetched, report the reason honestly, never fall
 * back to the local list passing it off as remote.
 */

import {
  buildProcessPickItems,
  parsePsProcesses,
  pidFromPick,
  type ProcessEntry
} from '../debugConfig';
import { defaultSpawnRunner, type SpawnRunner } from './pyspyDump';
import { buildSshExecArgs } from './remoteConnection';
import type { SshHostEntry } from './sshConfig';

/** The remote process list command: exactly the same shape as the local makeProcessLister, reusing the same parser */
export const REMOTE_PS_ARGS = ['ps', '-axo', 'pid=,comm='];

export interface RemoteProcessListing {
  ok: boolean;
  processes?: ProcessEntry[];
  /** A one-line locatable reason when ok=false (ssh exit code / timeout / exception) */
  reason?: string;
}

/**
 * List remote processes: run ps behind an ssh prefix; a non-zero exit code or an
 * exception is honestly counted as failure (the BatchMode passwordless semantics
 * share the tunnel's ruling); success with empty output = an empty list (the remote
 * truly has no visible processes).
 */
export async function listRemoteProcesses(
  entry: SshHostEntry,
  runner: SpawnRunner = defaultSpawnRunner,
  timeoutMs = 8000
): Promise<RemoteProcessListing> {
  try {
    // Argument building stays inside the try: an illegal target declaration (a leading '-'/control characters) is honestly reported as a listing failure
    const run = await runner('ssh', buildSshExecArgs(entry, REMOTE_PS_ARGS), timeoutMs);
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

/** UI injection face: the vscode window face returns Thenable (not Promise), uniformly collected as unknown (awaited first, then narrowed) */
export interface RemoteProcessPickerDeps {
  listRemote(): Promise<RemoteProcessListing>;
  showQuickPick(
    items: Array<{ label: string; description: string }>,
    options: { placeHolder: string }
  ): unknown;
  showErrorMessage(message: string): unknown;
}

/**
 * Remote PID selection (aligned with the local pickProcessId): a listing failure /
 * empty list reports honestly and returns undefined (no picker shown, no local
 * fallback); with a list, a component-name hit is pinned to the top with ✓.
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
