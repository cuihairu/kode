// SRC-012 可选拆(2026-11-09)自 hotReloadReceiverRoundtrip.test.ts:参考接收端
// 共享装具(真实接收端启动 + 传输/回包/摘要助手 + 清理台账)迁入本模块。
// tests/helpers/ 不在 vitest include(tests/**/*.test.ts)内,仅作装具被导入,
// 遵循 debugConfigAttachHarness 先例:测试文件互相禁导入,共享装具放非收集模块。

import * as http from 'http';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { defaultReloadHttpRunner, HttpReloadTransport } from '../../src/backend/hotReloadTransport';

// IDE-AUD-007 / IDE-REV-022 / IDE-REV-023 真实联调面:回执协议证据不能只靠
// 模拟 JSON 字符串喂解析器——本套件拉起真实的参考接收端(scripts/hot-reload-
// receiver/referenceReceiver.mjs,零依赖 node:http 实现已记录契约),经真实
// node:http 回环网络驱动生产模块(HttpReloadTransport+defaultReloadHttpRunner
// +真实台账),逐场景取证:accepted 升格/applied digest 双证/digest 不符不升格/
// 非 JSON 回包保持未确认/非 2xx failed。请求/响应样本由 roundtripProbe 落盘。
//
// F3 四轮(2026-11-06 复审)设计级重做:applied 路径改为**接收端自己写产物**
// ——按报文 files 读到内容后由接收端自身代码直接落盘引擎目录(--artifact-dir),
// 写后重算 sha256 与 sender_digest 比对一致才回 applied(写失败/哈希不符→
// failed 且已写产物回滚);外部应用命令模式降级:命令副作用不可证实(无法证明
// 产物是本次命令写的),退出 0 也最多 accepted,绝不 applied。空操作场景从
// 设计上不存在假 applied:接收端没写产物就没有产物哈希可核验。

interface ReceiverHandle {
  port: number;
  root: string;
  proc: ReturnType<typeof spawn>;
}

export const RECEIVER_SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'hot-reload-receiver',
  'referenceReceiver.mjs'
);

const startReceiver = async (
  mode: string,
  scenario: string,
  extraArgs: string[] = [],
  shellPrelude?: string,
  rootOverride?: string
): Promise<ReceiverHandle> => {
  const root = rootOverride ?? mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-receiver-'));
  const argv = ['--port', '0', '--root', root, '--mode', mode, '--scenario', scenario, ...extraArgs];
  // shellPrelude:经 sh 包裹启动(如 ulimit 资源上限注入),仅测试构造资源型
  // 失败用;默认直接 spawn node。路径均无空格,单引号包裹足够。
  const proc =
    shellPrelude === undefined
      ? spawn(process.execPath, [RECEIVER_SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'inherit'] })
      : spawn(
          'sh',
          [
            '-c',
            `${shellPrelude}; exec '${process.execPath}' '${RECEIVER_SCRIPT}' ${argv.map(arg => `'${arg}'`).join(' ')}`
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] }
        );
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('receiver 启动超时')), 5000);
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/KODE_RECEIVER_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`receiver 提前退出: code=${code} ${buffer}`));
    });
  });
  return { port, root, proc };
};

// 描述域装具工厂:每用例新建一套(引擎目录/外部目录台账 + 助手),dispose() 即
// 原 afterEach 清理体;it 体经解构绑定拿到同名助手,原文零改动。接收端句柄台账
// (handles)只在 start/dispose 内部使用,不外露。
export interface HotReloadReceiverRoundtripHarness {
  engineDirs: string[];
  outsideDirs: string[];
  start(mode: string, scenario: string, extraArgs?: string[], shellPrelude?: string, rootOverride?: string): Promise<ReceiverHandle>;
  makeTransport(port: number): HttpReloadTransport;
  postReload(port: number, body: unknown): Promise<{ status: number; body: string }>;
  sha256(content: string): string;
  dispose(): void;
}

export function createHotReloadReceiverRoundtripHarness(): HotReloadReceiverRoundtripHarness {
  const handles: ReceiverHandle[] = [];
  const engineDirs: string[] = [];
  const outsideDirs: string[] = [];

  const start = async (mode: string, scenario: string, extraArgs: string[] = [], shellPrelude?: string, rootOverride?: string): Promise<ReceiverHandle> => {
    const handle = await startReceiver(mode, scenario, extraArgs, shellPrelude, rootOverride);
    handles.push(handle);
    return handle;
  };

  const makeTransport = (port: number): HttpReloadTransport =>
    new HttpReloadTransport(
      {
        name: 'aud007',
        url: `http://127.0.0.1:${port}/reload`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ${files} 占位:真实通道会把文件集 JSON 化进 body
        body: '{"files": ${files}}'
      },
      { run: request => defaultReloadHttpRunner(request) }
    );

  // F3 三轮:直连接收端的原始 POST(绕过通道模板)——专门钉接收端协议面
  // 本身(sender_digests 字段与应用产物核验),与经通道的 roundtrip 断言互补。
  const postReload = async (port: number, body: unknown): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } },
        response => {
          let raw = '';
          response.on('data', (chunk: Buffer) => {
            raw += chunk.toString('utf8');
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: raw }));
        }
      );
      request.on('error', reject);
      request.write(JSON.stringify(body));
      request.end();
    });

  const sha256 = (content: string): string =>
    createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

  const dispose = (): void => {
    for (const handle of handles) {
      handle.proc.kill();
      rmSync(handle.root, { recursive: true, force: true });
    }
    for (const dir of engineDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of outsideDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    handles.length = 0;
    engineDirs.length = 0;
    outsideDirs.length = 0;
  };

  return { engineDirs, outsideDirs, start, makeTransport, postReload, sha256, dispose };
}
