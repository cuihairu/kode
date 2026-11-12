/**
 * 打包产物可装载烟测(2026-11-12 nightly 回归门):VSIX 交付面是 esbuild
 * bundle(out/extension.js),而 demo 门禁走的是 tsc 逐文件输出——jsonc-parser
 * 经 lib/umd/main.js(platform=node 默认只认 main 字段)进 bundle 后,UMD
 * 工厂体内参数遮蔽的 require('./impl/format' 等)原样留在运行时,宿主按
 * out/ 相对路径解析必然 MODULE_NOT_FOUND,模块求值死亡 → activate 不运行 →
 * 全部侧栏视图停在「已声明、无提供者」(用户报:There is no data provider
 * registered that can provide view data)。本测试用与 bundle 脚本同一组旗标
 * 现场产 bundle,并以最小 vscode 替身真装载一次:任何依赖再以「main 字段
 * UMD/动态 require 泄漏」形态进包,装载即红,不再等 nightly 才炸。
 * 修复口径:三条 node 侧 esbuild 命令加 --main-fields=module,main,jsonc-parser
 * 走 lib/esm/main.js(纯 ESM,正常内联)。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const repoRoot = join(__dirname, '..');

/** 与 package.json bundle 脚本一致的 node 侧旗标(main-fields 为修复点)。 */
const NODE_BUNDLE_FLAGS = {
  external: ['vscode'],
  format: 'cjs' as const,
  platform: 'node' as const,
  target: 'node18',
  minify: true,
  mainFields: ['module', 'main']
};

/**
 * 最小 vscode 替身:只满足 bundle 顶层求值面(与 2026-11-12 现场探测一致
 * ——装载面触碰的 window/workspace/languages 等取值,activate 不调用)。
 * 真宿主里 vscode 由扩展宿主提供;替身缺面会在装载期立即暴露。
 */
const VSCODE_STUB_SOURCE = `
const config = { get: () => true, update: async () => undefined, has: () => true, inspect: () => undefined };
const emp = { dispose: () => {} };
class StubEventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}
module.exports = {
  l10n: { t: (m) => m },
  window: new Proxy({}, { get: () => () => emp }),
  workspace: new Proxy({}, { get: (t, p) => {
    if (p === 'getConfiguration') return () => config;
    if (p === 'workspaceFolders') return [];
    return () => emp;
  } }),
  commands: { registerCommand: () => emp, executeCommand: async () => undefined },
  languages: { createDiagnosticCollection: () => ({ delete() {}, clear() {}, set() {}, dispose() {} }) },
  Uri: {
    file: (f) => ({ fsPath: f, path: f, scheme: 'file', query: '', fragment: '', with: () => ({}) }),
    parse: (s) => ({ fsPath: s, scheme: 'file', query: '', fragment: '', with: () => ({}) }),
    joinPath: () => ({})
  },
  EventEmitter: StubEventEmitter,
  Disposable: { from: () => emp },
  TreeItem: class { constructor(label) { this.label = label; } },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  MarkdownString: class { appendCodeblock() {} appendText() {} },
  extensions: { getExtension: () => undefined },
  version: '1.96.0',
  env: { appName: 'bundle-load-smoke', language: 'en', uriScheme: 'vscode' }
};
`;

let workDir: string | null = null;

afterAll(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe('bundle 可装载烟测(nightly 2026-11-12 回归门)', () => {
  it('bundle 脚本三条 node 侧 esbuild 命令都带 --main-fields=module,main(修复点漂移即红)', () => {
    const requirePkg = createRequire(import.meta.url);
    const bundleScript = requirePkg(join(repoRoot, 'package.json')).scripts.bundle as string;
    const segments = bundleScript.split('&&').map(segment => segment.trim());
    const nodeSegments = segments.filter(
      segment => segment.startsWith('esbuild ') && segment.includes('--platform=node')
    );
    expect(nodeSegments.length).toBe(3); // extension + pythonParserWorker + defParserWorker
    for (const segment of nodeSegments) {
      expect(segment, segment.slice(0, 60)).toContain('--main-fields=module,main');
    }
  });

  it('按脚本旗标产 bundle 并以 vscode 替身真装载(UMD 运行时 require 泄漏即红)', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'kode-bundle-load-'));
    const outfile = join(workDir, 'extension.js');
    const stubPath = join(workDir, 'vscode-stub.cjs');
    writeFileSync(stubPath, VSCODE_STUB_SOURCE, 'utf8');

    await build({
      entryPoints: [join(repoRoot, 'src', 'extension.ts')],
      outfile,
      bundle: true,
      logLevel: 'silent',
      ...NODE_BUNDLE_FLAGS
    });
    expect(existsSync(outfile)).toBe(true);

    // UMD 工厂泄漏的直接痕迹(jsonc-parser lib/umd/main.js 的 impl 分解 require)
    const bundleText = await import('node:fs').then(fs => fs.readFileSync(outfile, 'utf8'));
    expect(bundleText.includes('require("./impl/'), 'UMD 工厂 require 泄漏进 bundle').toBe(false);

    const requireBundle = createRequire(import.meta.url);
    const resolveHook = Module as unknown as {
      _resolveFilename: (request: string, ...rest: unknown[]) => string;
    };
    const originalResolve = resolveHook._resolveFilename;
    resolveHook._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') {
        return stubPath;
      }
      return originalResolve.call(this, request, ...rest);
    };
    try {
      const loaded = requireBundle(outfile);
      expect(loaded).toBeTruthy();
    } finally {
      resolveHook._resolveFilename = originalResolve;
    }
  }, 60000);
});
