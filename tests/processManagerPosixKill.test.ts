import { describe, expect, it, vi } from 'vitest';
import { killProcessTree } from '../src/backend/processManager';

// RUST-199(旧 EXEC-011)POSIX 腿:detached setsid 进程组长的树杀语义。
// killProcessTree POSIX 分支(processManager.ts:154-166):
// ①process.kill(-pid) 组杀成功→true,信号原样传组;
// ②组杀抛(组长已回收 ESRCH/并非组长)→回落 child.kill 单 pid;
// ③无 child →回落 process.kill(pid) 正 pid;
// ④两路全抛→false 如实。
// win32 taskkill 三臂与 R2-F23 无效 pid 闸已有钉(processManager.test.ts),
// 本文件只钉 POSIX 腿,平台经 deps.platform 注入不依赖宿主。

function fakeChild(kill: (signal?: NodeJS.Signals) => boolean): never {
  return { kill } as never;
}

describe('killProcessTree POSIX arms (RUST-199)', () => {
  it('组长负 pid 组杀成功→true,信号按原样传组', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const ok = await killProcessTree(4321, 'SIGTERM', undefined, { platform: 'linux' });
      expect(ok).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('组杀抛(ESRCH/并非组长)→回落 child.kill 单 pid,不再碰正 pid', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) {
        throw new Error('ESRCH');
      }
      throw new Error('positive pid must not be signalled when child is present');
    }) as never);
    const childKill = vi.fn(() => true);
    try {
      const ok = await killProcessTree(4321, 'SIGKILL', fakeChild(childKill), { platform: 'linux' });
      expect(ok).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(childKill).toHaveBeenCalledTimes(1);
      expect(childKill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('组杀抛且无 child →回落正 pid 单杀→true', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) {
        throw new Error('ESRCH');
      }
      return true;
    }) as never);
    try {
      const ok = await killProcessTree(4321, 'SIGTERM', undefined, { platform: 'linux' });
      expect(ok).toBe(true);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenNthCalledWith(1, -4321, 'SIGTERM');
      expect(kill).toHaveBeenNthCalledWith(2, 4321, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('组杀与正 pid 两路全抛→false 如实,child 缺省不虚报', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
    }) as never);
    try {
      const ok = await killProcessTree(4321, 'SIGTERM', undefined, { platform: 'linux' });
      expect(ok).toBe(false);
      expect(kill).toHaveBeenCalledTimes(2);
    } finally {
      kill.mockRestore();
    }
  });

  it('child.kill 回落结果如实透传(false 不虚报成功)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) {
        throw new Error('ESRCH');
      }
      throw new Error('positive pid must not be signalled when child is present');
    }) as never);
    const childKill = vi.fn(() => false);
    try {
      const ok = await killProcessTree(4321, 'SIGTERM', fakeChild(childKill), { platform: 'darwin' });
      expect(ok).toBe(false);
      expect(childKill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });
});
