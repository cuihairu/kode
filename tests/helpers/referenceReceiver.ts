import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// 参考接收端拉起助手(IDE-AUD-007/REV-022/REV-023 真实联调共用):
// 启动 scripts/hot-reload-receiver/referenceReceiver.mjs 子进程,回环端口
// 就绪(KODE_RECEIVER_PORT=)后返回句柄;dispose 杀进程并清暂存目录。

export interface ReferenceReceiver {
  readonly port: number;
  dispose(): void;
}

export async function startReferenceReceiver(
  mode: 'stage' | 'apply',
  scenario: 'accepted' | 'applied' | 'digest-mismatch' | 'echo' | 'error500',
  applyCommand?: string,
  artifactDir?: string
): Promise<ReferenceReceiver> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kode-receiver-wiring-'));
  const script = path.join(__dirname, '..', '..', 'scripts', 'hot-reload-receiver', 'referenceReceiver.mjs');
  // F3:apply 模式必须配真实应用命令(--apply-command)接收端才会回 applied;
  // 未配置时接收端如实回 accepted(仅暂存,未应用)。
  // F3 三轮:applied 前接收端对 --artifact-dir 引擎产物重算 sha256 与报文
  // sender_digests 比对一致才回 applied;缺目录一律不自称 applied。
  const args = [script, '--port', '0', '--root', root, '--mode', mode, '--scenario', scenario];
  if (applyCommand !== undefined) {
    args.push('--apply-command', applyCommand);
  }
  if (artifactDir !== undefined) {
    args.push('--artifact-dir', artifactDir);
  }
  const proc = spawn(
    process.execPath,
    args,
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('参考接收端启动超时')), 5000);
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/KODE_RECEIVER_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`参考接收端提前退出: code=${code} ${buffer}`));
    });
  });
  return {
    port,
    dispose: () => {
      proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
