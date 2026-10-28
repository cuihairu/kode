// 真机层入口(真机验收令 2026-10-10):用 @vscode/test-electron 拉起真 VS Code
// 扩展宿主,把 out/test/electron/suite 下的用例交给宿主内 mocha 执行。
// 与 src/test/runTest.ts(fake-vscode 装配烟测,纯 node)不同,本层消费的是
// 真编辑器 API 面:executeCompletionItemProvider / executeHoverProvider /
// executeDefinitionProvider / executeDocumentSymbolProvider / 诊断集合。
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // 仓库根 = out/test/electron 上溯三级(与 main 字段同根)
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const demoMode = process.argv.includes('--demo');
  const vsixMode = process.argv.includes('--vsix');
  const fieldMode = process.argv.includes('--field');
  let devPath = extensionDevelopmentPath;
  let workspacePath = path.resolve(extensionDevelopmentPath, 'tests/fixtures/electron-ws');
  if (demoMode) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-demo-'));
    const demoSource = path.resolve(extensionDevelopmentPath, 'tests/fixtures/kbengine-demo-assets');
    workspacePath = path.join(temporaryRoot, 'kbengine-demo-assets');
    fs.cpSync(demoSource, workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.vscode/settings.json'), JSON.stringify({
      'kbengine.assetsRoot': '.',
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false,
      'kbengine.jumpLog': true
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'demo';
    process.env.KODE_DEMO_WORKSPACE = workspacePath;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (vsixMode) {
    // IDE-REL-006 安装后烟测:vsce 真打包 → 解包成安装布局(extension/ =
    // 扩展根)→ 以解包产物为扩展开发路径加载。宿主内跑的是包内文件,
    // 不是仓库树;套件(vsixSmoke.test.ts)对 hover/跳转/worker 路径发
    // 有命中断言的请求。KODE_VSIX_PATH 可注入预构建 vsix(复跑提速/
    // prove-red 对照),缺省现场 vsce package。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-vsix-'));
    const demoSource = path.resolve(extensionDevelopmentPath, 'tests/fixtures/kbengine-demo-assets');
    workspacePath = path.join(temporaryRoot, 'kbengine-demo-assets');
    fs.cpSync(demoSource, workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.vscode/settings.json'), JSON.stringify({
      'kbengine.assetsRoot': '.',
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false,
      'kbengine.jumpLog': true
    }, null, 2));
    // 烟测 worker 用例:调用方(小文件,层3 file-scope 只解析它自己)+ 实现
    // (大文件)。大文件 >PYTHON_WORKER_PARSE_THRESHOLD(256 KiB),在扩展
    // 宿主内必然派发 worker 线程解析(worker=包内 out/pythonParserWorker.js);
    // 跳转命中只能由层2 索引(需大文件已入索引)给出——实现与调用分文件是
    // 刻意的:同文件时层3 会用当前文档内联解析兜底,worker 面就被绕开。
    // 阈值上再留 44 KiB 余量,防解析器/阈值后续微调时用例悄悄退化。
    const SMOKE_PY_MIN_BYTES = 300 * 1024;
    const smokePyHeader = [
      '# IDE-REL-006 vsix smoke fixture: oversized on purpose so the extension',
      '# host dispatches parsing to the worker thread (see vsixSmoke.test.ts).',
      'class SmokeWorkerMixin:',
      '    def smoke_worker_method(self):',
      '        return 42'
    ].join('\n');
    const smokePadLine = (index: number): string =>
      `# vsix smoke padding ${index}: keep this file over the worker dispatch threshold`;
    const smokePadCount = Math.ceil(
      (SMOKE_PY_MIN_BYTES - Buffer.byteLength(smokePyHeader)) / (smokePadLine(0).length + 1)
    ) + 1;
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/smoke_worker_large.py'),
      [smokePyHeader, ...Array.from({ length: smokePadCount }, (_, index) => smokePadLine(index))].join('\n')
    );
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/smoke_worker_caller.py'),
      [
        '# IDE-REL-006 vsix smoke: caller side of the oversized-file worker case.',
        '# The implementation lives in smoke_worker_large.py (over the worker',
        '# dispatch threshold), so a hit here means the packaged worker parsed it.',
        'from training.smoke_worker_large import SmokeWorkerMixin',
        '',
        '',
        'class SmokeWorkerCaller(SmokeWorkerMixin):',
        '    def call_smoke_worker_method(self):',
        '        return self.smoke_worker_method()  # nav: vsix-smoke-worker'
      ].join('\n')
    );
    const vsixPath = process.env.KODE_VSIX_PATH
      ?? path.join(temporaryRoot, 'kode-kbengine-smoke.vsix');
    if (!process.env.KODE_VSIX_PATH) {
      execFileSync('pnpm', [
        'exec', 'vsce', 'package', '--no-dependencies', '--out', vsixPath
      ], { cwd: extensionDevelopmentPath, stdio: 'inherit' });
    }
    const unpackRoot = path.join(temporaryRoot, 'vsix-unpacked');
    execFileSync('unzip', ['-o', '-q', vsixPath, '-d', unpackRoot], { stdio: 'inherit' });
    devPath = path.join(unpackRoot, 'extension');
    process.env.KODE_ELECTRON_SUITE = 'vsix';
    process.env.KODE_VSIX_WORKSPACE = workspacePath;
    process.env.KODE_VSIX_EXT_DIR = devPath;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (fieldMode) {
    // P0-4b 现场基线:工作区用 demo 资产(含 nav: runtime-damage 符号),
    // 外部资产根用生成器现造 ~5000 文件 large 场景(绝对路径,真扫描外部根)。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-field-'));
    const demoSource = path.resolve(extensionDevelopmentPath, 'tests/fixtures/kbengine-demo-assets');
    workspacePath = path.join(temporaryRoot, 'kbengine-demo-assets');
    fs.cpSync(demoSource, workspacePath, { recursive: true });
    const perfOut = path.join(temporaryRoot, 'perf-assets');
    execFileSync(process.execPath, [
      path.resolve(extensionDevelopmentPath, 'scripts/generate-perf-assets.mjs'),
      '--out', perfOut,
      '--large-files', '5000'
    ], { stdio: 'inherit' });
    const externalRoot = path.join(perfOut, 'large');
    fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.vscode/settings.json'), JSON.stringify({
      'kbengine.assetsRoot': externalRoot,
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'field';
    process.env.KODE_FIELD_WORKSPACE = workspacePath;
    process.env.KODE_FIELD_MODE = process.env.KODE_FIELD_MODE ?? 'enabled';
    process.env.KODE_FIELD_OUT = process.env.KODE_FIELD_OUT
      ?? path.resolve(extensionDevelopmentPath, 'docs/perf/2026-10-27-field-baseline-run.txt');
    // 禁用对照=VS Code 裸面:开发扩展经 extensionDevelopmentPath 强制加载且激活由
    // workspaceContains/onLanguage 自动触发,--disable-extension 对开发扩展无效,
    // 故禁用模式把 extensionDevelopmentPath 指向空目录——扩展完全不加载,suite 仍经
    // extensionTestsPath 在宿主内运行(裸面:无 provider,指标摘要全空)。
    const disabled = process.env.KODE_FIELD_MODE === 'disabled';
    if (disabled) {
      devPath = path.join(temporaryRoot, 'empty-dev');
      fs.mkdirSync(devPath, { recursive: true });
    }
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  }

  const cachedVersion = process.env.KODE_VSCODE_VERSION ?? '1.141.0';
  const executableName = process.platform === 'win32' ? 'Code.exe' : 'code';
  const cachedExecutable = path.resolve(
    extensionDevelopmentPath,
    '.vscode-test',
    `vscode-${process.platform}-${process.arch}-${cachedVersion}`,
    executableName
  );

  await runTests({
    extensionDevelopmentPath: devPath,
    extensionTestsPath,
    ...(fs.existsSync(cachedExecutable) ? { vscodeExecutablePath: cachedExecutable } : {}),
    launchArgs: [
      workspacePath,
      // 无显示环境(headless/CI)必需:xvfb 下禁 GPU 与沙箱
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // 关掉欢迎页/恢复提示,保证工作区按参数打开
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
}

main().catch(error => {
  console.error('真机层启动失败:', error);
  process.exit(1);
});
