import { describe, expect, it } from 'vitest';
import {
  buildProcessPickItems,
  parsePsProcesses,
  pidFromPick
} from '../src/debugConfig';
import {
  REMOTE_PS_ARGS,
  listRemoteProcesses,
  pickRemoteProcessId,
  type RemoteProcessPickerDeps
} from '../src/remoteProcessList';

// IDE-PDBG-005 远程进程枚举与选择:清单命令与本地同形(ps -axo pid=,comm=
// 经 ssh 前缀),解析复用 parsePsProcesses;选择器条目本地/远程共用
// buildProcessPickItems(组件名命中置顶 ✓);清单取不到如实报,不本地兜底。

const PS_OUTPUT = [
  '1041 sshd',
  '2207 cellapp',
  '2208 baseapp',
  '2300 vim',
  ''
].join('\n');

describe('listRemoteProcesses', () => {
  it('成功:ssh 前缀跑 ps,退出码 0 → 解析远端清单', async () => {
    const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const listing = await listRemoteProcesses(
      { host: 'gamesrv', user: 'ops', port: 2222, proxyJump: 'bastion' },
      async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return { stdout: PS_OUTPUT, stderr: '', exitCode: 0 };
      }
    );
    expect(listing.ok).toBe(true);
    expect(listing.processes).toEqual(parsePsProcesses(PS_OUTPUT));
    // 命令形状:BatchMode + 跳板 + 端口 + user@host -- ps 同本地形
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ssh');
    expect(calls[0].args).toEqual([
      '-o', 'BatchMode=yes',
      '-J', 'bastion',
      '-p', '2222',
      'ops@gamesrv',
      '--',
      ...REMOTE_PS_ARGS
    ]);
  });

  it('ssh 退出码非 0:如实失败带退出码与输出尾,不给清单', async () => {
    const listing = await listRemoteProcesses(
      { host: 'gamesrv' },
      async () => ({ stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 })
    );
    expect(listing.ok).toBe(false);
    expect(listing.processes).toBeUndefined();
    expect(listing.reason).toContain('ssh 退出码 255');
    expect(listing.reason).toContain('Permission denied');
  });

  it('注入面抛异常:归失败不冒泡(超时面在外层)', async () => {
    const listing = await listRemoteProcesses({ host: 'gamesrv' }, async () => {
      throw new Error('runner blew up');
    });
    expect(listing.ok).toBe(false);
    expect(listing.reason).toContain('runner blew up');
  });

  it('成功但空输出:空清单(远端真没有可见进程,不是失败)', async () => {
    const listing = await listRemoteProcesses(
      { host: 'gamesrv' },
      async () => ({ stdout: '', stderr: '', exitCode: 0 })
    );
    expect(listing.ok).toBe(true);
    expect(listing.processes).toEqual([]);
  });
});

describe('buildProcessPickItems / pidFromPick(本地与远程共用面)', () => {
  it('组件名命中置顶标 ✓,其余随后;description=PID', () => {
    const items = buildProcessPickItems(parsePsProcesses(PS_OUTPUT), 'cellapp');
    expect(items.map(item => item.label)).toEqual([
      '$(check) cellapp',
      'sshd',
      'baseapp',
      'vim'
    ]);
    expect(items[0].description).toBe('2207');
    expect(pidFromPick(items[0])).toBe(2207);
  });

  it('pidFromPick:取消/非数字/非正数归 undefined', () => {
    expect(pidFromPick(undefined)).toBeUndefined();
    expect(pidFromPick({ description: 'abc' })).toBeUndefined();
    expect(pidFromPick({ description: '0' })).toBeUndefined();
    expect(pidFromPick({ description: '42' })).toBe(42);
  });
});

describe('pickRemoteProcessId', () => {
  const makeDeps = (
    listing: { ok: boolean; processes?: Array<{ pid: number; name: string }>; reason?: string },
    picked: { description?: string } | undefined,
    log: { errors: string[]; picks: Array<Array<{ label: string; description: string }>> }
  ): RemoteProcessPickerDeps => ({
    listRemote: async () => listing,
    showQuickPick: async (items, options) => {
      log.picks.push(items);
      expect(options.placeHolder).toContain('gamesrv');
      return picked;
    },
    showErrorMessage: message => {
      log.errors.push(message);
      return undefined;
    }
  });

  it('清单失败:如实报错(含主机与原因),不弹选择器,返回 undefined', async () => {
    const log = { errors: [] as string[], picks: [] as Array<Array<{ label: string; description: string }>> };
    const pid = await pickRemoteProcessId('cellapp', 'gamesrv', makeDeps(
      { ok: false, reason: 'ssh 退出码 255:Permission denied (publickey).' },
      undefined,
      log
    ));
    expect(pid).toBeUndefined();
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain('gamesrv');
    expect(log.errors[0]).toContain('Permission denied');
    expect(log.picks).toHaveLength(0); // 绝不带病弹选择器
  });

  it('空清单:如实报「未获取到」,不弹选择器', async () => {
    const log = { errors: [] as string[], picks: [] as Array<Array<{ label: string; description: string }>> };
    const pid = await pickRemoteProcessId('cellapp', 'gamesrv', makeDeps(
      { ok: true, processes: [] },
      undefined,
      log
    ));
    expect(pid).toBeUndefined();
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain('未获取到进程列表');
    expect(log.picks).toHaveLength(0);
  });

  it('有清单:选择器与本地同形(命中置顶 ✓),选中取 description 里的 PID', async () => {
    const log = { errors: [] as string[], picks: [] as Array<Array<{ label: string; description: string }>> };
    const processes = parsePsProcesses(PS_OUTPUT);
    const pid = await pickRemoteProcessId('cellapp', 'gamesrv', makeDeps(
      { ok: true, processes },
      { description: '2207' },
      log
    ));
    expect(pid).toBe(2207);
    expect(log.errors).toHaveLength(0);
    // 条目组与本地 pickProcessId 完全同源:置顶 ✓ + description=PID
    expect(log.picks[0]).toEqual(buildProcessPickItems(processes, 'cellapp'));
    expect(log.picks[0][0].label).toBe('$(check) cellapp');
  });

  it('选择器取消:undefined,无报错', async () => {
    const log = { errors: [] as string[], picks: [] as Array<Array<{ label: string; description: string }>> };
    const pid = await pickRemoteProcessId('cellapp', 'gamesrv', makeDeps(
      { ok: true, processes: parsePsProcesses(PS_OUTPUT) },
      undefined,
      log
    ));
    expect(pid).toBeUndefined();
    expect(log.errors).toHaveLength(0);
  });
});
