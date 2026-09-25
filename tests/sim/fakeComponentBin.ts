import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 假组件二进制工厂:在临时 bin 目录里生成可编程的"KBEngine 组件可执行
 * 文件"。脚本以 node 运行,跨平台;行为与真实引擎进程对 serverManager
 * 可观察面完全一致(stdout/stderr 流、退出码、信号语义)。
 *
 * 行为规格(docs/redesign.md 阶段 2):
 * - run:常驻;可先打印启动标记、cwd、指定环境变量的注入值
 * - stderr:常驻;先向 stderr 输出一段文本
 * - exit:启动后立即以给定退出码退出。POSIX 下用 /bin/sh 脚本——node
 *   解释器冷启动在并行负载下可能超过 serverManager 的 1 秒启动宽限期,
 *   会让"秒退进程不触发启动成功提示"的断言变成时序抽奖;sh 启动毫秒级,
 *   退出确定性早于宽限期(win32 仍用 node 脚本,该平台无 shebang 语义)
 * - ignore-sigterm:先安装 SIGTERM 处理器再打印标记(标记出现即证明
 *   忽略已生效,规避"信号抢在 trap 安装前送达"的竞态),然后常驻,
 *   只能被 SIGKILL 杀死
 * - unexecutable:文件存在但剥掉执行权限(chmod 000)——spawn 报 EACCES
 */

export type FakeComponentBehavior =
  | {
      kind: 'run';
      /** 启动后先打印的标记行 */
      stdoutMarker?: string;
      /** 打印进程工作目录(pwd 语义) */
      printCwd?: boolean;
      /** 打印指定环境变量的注入值,如 KBE_BIN_PATH */
      echoEnv?: string[];
      /** 同时向 stderr 打印的内容 */
      stderr?: string;
    }
  | { kind: 'exit'; code: number }
  | { kind: 'ignore-sigterm'; marker?: string }
  | { kind: 'unexecutable' };

const KEEPALIVE = 'setInterval(function () {}, 3600000);';

const scriptBody = (behavior: FakeComponentBehavior): { shebang: string; body: string } => {
  switch (behavior.kind) {
    case 'run': {
      const lines: string[] = [];
      if (behavior.stdoutMarker) {
        lines.push(`process.stdout.write(${JSON.stringify(`${behavior.stdoutMarker}\n`)});`);
      }
      if (behavior.printCwd) {
        lines.push('process.stdout.write(process.cwd() + "\\n");');
      }
      for (const key of behavior.echoEnv ?? []) {
        lines.push(
          `process.stdout.write(${JSON.stringify(key)} + "=" + (process.env[${JSON.stringify(key)}] || "") + "\\n");`
        );
      }
      if (behavior.stderr) {
        lines.push(`process.stderr.write(${JSON.stringify(`${behavior.stderr}\n`)});`);
      }
      lines.push(KEEPALIVE);
      return { shebang: '#!/usr/bin/env node', body: lines.join('\n') };
    }
    case 'exit':
      return process.platform === 'win32'
        ? { shebang: '#!/usr/bin/env node', body: `process.exit(${behavior.code});` }
        : { shebang: '#!/bin/sh', body: `exit ${behavior.code};` };
    case 'ignore-sigterm':
      return {
        shebang: '#!/usr/bin/env node',
        body: [
          'process.on("SIGTERM", function () {});',
          `process.stdout.write(${JSON.stringify(`${behavior.marker ?? 'sigterm-ignored'}\n`)});`,
          KEEPALIVE
        ].join('\n')
      };
    case 'unexecutable':
      return { shebang: '#!/usr/bin/env node', body: KEEPALIVE };
    default:
      throw new Error(`Unknown fake component behavior: ${(behavior as { kind: string }).kind}`);
  }
};

export class FakeComponentBin {
  private constructor(readonly root: string, readonly binPath: string) {}

  static async create(): Promise<FakeComponentBin> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fakebin-'));
    const binPath = path.join(root, 'bin');
    fs.mkdirSync(binPath, { recursive: true });
    return new FakeComponentBin(root, binPath);
  }

  /** 生成一个假组件可执行文件,返回其绝对路径 */
  write(name: string, behavior: FakeComponentBehavior): string {
    const scriptPath = path.join(this.binPath, name);
    const { shebang, body } = scriptBody(behavior);
    fs.writeFileSync(scriptPath, `${shebang}\n${body}\n`, 'utf8');
    fs.chmodSync(scriptPath, behavior.kind === 'unexecutable' ? 0o000 : 0o755);
    return scriptPath;
  }

  /** 直接拉起一个假组件(不经过 serverManager,供独立进程断言) */
  launch(name: string, args: string[] = [], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): childProcess.ChildProcess {
    return childProcess.spawn(path.join(this.binPath, name), args, {
      cwd: options?.cwd,
      env: options?.env
    });
  }

  async dispose(): Promise<void> {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
