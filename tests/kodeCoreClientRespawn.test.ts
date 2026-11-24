import { describe, it, expect } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';

// :3036 复现(用户对照实验:缺失二进制首次 ENOENT 报错、第二次不重新拉起进程)。
// 钉死 client 层语义:start() 对 spawn ENOENT 必须每次都重新 spawn 一次
// (失败账不得被记成「已尝试」)。
describe('KodeCoreClient respawn after spawn ENOENT (:3036)', () => {
  it('second start() re-spawns after ENOENT failure', async () => {
    const lifecycle: string[] = [];
    const client = new KodeCoreClient({
      binaryPath: '/nonexistent/kode-server-repro',
      initializeParams: { processId: process.pid, capabilities: {} },
      onLifecycle: line => lifecycle.push(line)
    });
    await expect(client.start()).rejects.toMatchObject({ code: 'EXITED' });
    await expect(client.start()).rejects.toMatchObject({ code: 'EXITED' });
    const spawnAttempts = lifecycle.filter(line => line.startsWith('spawn failed')).length;
    expect(spawnAttempts, 'each start() must spawn once, got ' + spawnAttempts).toBe(2);
    await client.dispose();
  });
});
