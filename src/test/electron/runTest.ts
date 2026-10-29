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
  const multirootMode = process.argv.includes('--multiroot');
  const freshFileMode = process.argv.includes('--freshfile');
  const stormMode = process.argv.includes('--storm');
  // IDE-ACC-008 归因验收:与 --field 共用同一工作区装配(demo 资产+5000 文件
  // 外部根=同机同项目口径),suite 过滤切到 attribution,双跑
  // enabled/KODE_FIELD_MODE=disabled 两面(serviceAttribution.test.ts)。
  // IDE-ACC-009 长会话资源边界:同样共用装配,过滤切 longsession
  // (longSessionResources.test.ts)。
  const attributionMode = process.argv.includes('--attribution');
  const longSessionMode = process.argv.includes('--longsession');
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
  } else if (fieldMode || attributionMode || longSessionMode) {
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
    // IDE-ACC-001 普通变量冷 hover 夹具:调用方同文件 def 返回注解(命中面=
    // HOV-010 快照级联第一层)+ 大文件无注解被调(空结果面=级联全落空,体量
    // 超 worker 阈值 256KiB,解析派发 worker 线程)。大文件刻意不带 '->'
    // 返回注解,套件对此有断言(防夹具悄悄退化成有注解)。
    const accCallerPath = path.join(workspacePath, 'scripts/common/training/plain_var_caller.py');
    fs.mkdirSync(path.dirname(accCallerPath), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/plain_var_large.py'),
      [
        '# IDE-ACC-001 fixture: oversized file with no return annotations.',
        'def get_unannotated_data():',
        '    return None',
        '',
        '',
        'class PlainVarLargeMixin:'
      ].concat(
        Array.from({ length: 5200 }, (_, index) =>
          `    def large_method_${index}(self):\n        return ${index}\n\n    # acc001 padding ${index}: oversized on purpose for worker dispatch`)
      ).join('\n')
    );
    fs.writeFileSync(accCallerPath, [
      '# IDE-ACC-001 plain-variable cold hover fixture.',
      'from training.plain_var_large import get_unannotated_data',
      '',
      '',
      'def get_annotated_data() -> JSONDATA:',
      '    return None',
      '',
      '',
      'data = get_annotated_data()',
      'plain_local_info = get_unannotated_data()'
    ].join('\n'));
    // IDE-ACC-003 首次事件 CodeLens 夹具:调用方 __init__ 里 addEvent(回调 def
    // 处应出「事件回调」镜)+ ping 里 emitEvent(应出监听数镜);监听方文件两
    // 个类各 addEvent 同名事件——全仓共 3 处注册,emitEvent 处的监听数镜应恰为
    // 「3 处监听」(计数断言锚定真实夹具内容,不是非空即过)。
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/event_caller_demo.py'),
      [
        '# IDE-ACC-003 first event CodeLens fixture: caller side.',
        'class EventCallerDemo:',
        '    def __init__(self):',
        '        self.addEvent(EV_TRAIN, self.on_train)',
        '',
        '    def on_train(self):',
        '        return None',
        '',
        '    def ping(self):',
        '        self.emitEvent(EV_TRAIN)'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/event_listener_demo.py'),
      [
        '# IDE-ACC-003 first event CodeLens fixture: two listeners for EV_TRAIN.',
        'class EventListenerOne:',
        '    def __init__(self):',
        '        self.addEvent(EV_TRAIN, self.on_train)',
        '',
        '    def on_train(self):',
        '        return None',
        '',
        '',
        'class EventListenerTwo:',
        '    def __init__(self):',
        '        self.addEvent(EV_TRAIN, self.on_train)',
        '',
        '    def on_train(self):',
        '        return None'
      ].join('\n')
    );
    process.env.KODE_ELECTRON_SUITE = attributionMode
      ? 'attribution'
      : longSessionMode ? 'longsession' : 'field';
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
  } else if (multirootMode) {
    // IDE-ACC-004 多根同名实体跳转验收:A/B 两根各自标准布局,同一实体名
    // TwinEntity 双方都注册——但 def 段(A=BaseMethods/B=CellMethods)、形参
    // (A=1×UINT16/B=2×STRING)与落点(A=base/B=cell)全不同。根配对若退化成
    // 「最后注册者覆盖」,签名与落点断言立即互相矛盾,不留侥幸面。用
    // .code-workspace 双 folder 打开真多根宿主。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-multiroot-'));
    const rootA = path.join(temporaryRoot, 'rootA');
    const rootB = path.join(temporaryRoot, 'rootB');
    const writeRoot = (root: string, section: 'BaseMethods' | 'CellMethods', args: string[]): void => {
      const entityDir = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(entityDir, { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts', 'cell'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), [
        '<root>',
        `	<TwinEntity hasBase="true" hasCell="true"></TwinEntity>`,
        '</root>'
      ].join('\n'));
      fs.writeFileSync(path.join(entityDir, 'TwinEntity.def'), [
        '<root>',
        `    <${section}>`,
        '        <onPing>',
        ...args.map(arg => `            <Arg>${arg}</Arg>`),
        '        </onPing>',
        `    </${section}>`,
        '</root>'
      ].join('\n'));
      // python 实现形参个数与 def <Arg> 对齐(过 pythonSignatureMatchesDeclaredArgs)
      const pyArgs = ['self', ...args.map((_, index) => `a${index}`)].join(', ');
      const pyBody = [
        `# acc004 ${path.basename(root)} implementation`,
        'class TwinEntity:',
        '',
        `    def onPing(${pyArgs}):`,
        `        return '${path.basename(root)}'`
      ].join('\n');
      fs.writeFileSync(path.join(root, 'scripts', 'base', 'TwinEntity.py'), pyBody);
      fs.writeFileSync(path.join(root, 'scripts', 'cell', 'TwinEntity.py'), pyBody);
    };
    writeRoot(rootA, 'BaseMethods', ['UINT16']);
    writeRoot(rootB, 'CellMethods', ['STRING', 'STRING']);
    const wsFile = path.join(temporaryRoot, 'dual.code-workspace');
    fs.writeFileSync(wsFile, JSON.stringify({
      folders: [{ path: rootA }, { path: rootB }],
      settings: {
        'kbengine.showFinalConfigOnOpen': false,
        'kbengine.python.stubExport': false,
        'kbengine.python.extraPathsSync': false
      }
    }, null, 2));
    workspacePath = wsFile;
    process.env.KODE_ELECTRON_SUITE = 'multiroot';
    process.env.KODE_MULTIROOT_A = rootA;
    process.env.KODE_MULTIROOT_B = rootB;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (freshFileMode) {
    // IDE-ACC-005 新增文件后的首次导航验收:会话启动时实现文件刻意缺席
    // (cell/ 目录空),套件中途 fs 现场创建 FreshEntity.py——watcher 的
    // onDidCreate 必须把它带入索引,首次 def→python F12 命中新文件,
    // 全程不执行任何窗口重载命令。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-fresh-'));
    workspacePath = temporaryRoot;
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'cell'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '	<FreshEntity hasCell="true"></FreshEntity>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entity_defs', 'FreshEntity.def'), [
      '<root>',
      '    <CellMethods>',
      '        <onFresh>',
      '            <Arg>UINT8</Arg>',
      '        </onFresh>',
      '    </CellMethods>',
      '</root>'
    ].join('\n'));
    fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, '.vscode/settings.json'), JSON.stringify({
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'freshfile';
    process.env.KODE_FRESH_ROOT = temporaryRoot;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (stormMode) {
    // IDE-ACC-006 连续输入后的补全与诊断验收:StormEntity 的 def 把 mA/mB
    // 都声明在 BaseMethods,python 经 self.cell 调用必出「段错配」诊断且
    // 消息点名被调方法——输入风暴交替改写被调方法名,风暴结束后诊断必须
    // 只剩最终版本(mB),中间版本(mA)一个不留;补全面在风暴后于 self.h
    // 前缀取 def 属性 hp。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-storm-'));
    workspacePath = temporaryRoot;
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '	<StormEntity hasBase="true" hasCell="true"></StormEntity>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entity_defs', 'StormEntity.def'), [
      '<root>',
      '    <Properties>',
      '        <hp>',
      '            <Type>UINT32</Type>',
      '        </hp>',
      '    </Properties>',
      '    <BaseMethods>',
      '        <mA>',
      '            <Arg>UINT8</Arg>',
      '        </mA>',
      '        <mB>',
      '            <Arg>UINT8</Arg>',
      '        </mB>',
      '    </BaseMethods>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'base', 'StormEntity.py'), [
      'class StormEntity:',
      '    def tick(self):',
      '        self.cell.mA()'
    ].join('\n'));
    fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, '.vscode/settings.json'), JSON.stringify({
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'storm';
    process.env.KODE_STORM_ROOT = temporaryRoot;
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
