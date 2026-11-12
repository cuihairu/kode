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

/**
 * UX-REVIEW-010f 真机 zh-cn locale 公共装配(manifest 回退 / 运行时 bundle 回退
 * 两模式共用):zh-cn 显示语言需要语言包(离线 VS Code 无内置中文)——从
 * open-vsx 拉 ms-ceintl 语言包 vsix(缓存进 .vscode-test/,已 gitignore),
 * 解包到调用方给的暂存目录再装成 extensions-dir 里的安装布局,并写好
 * user-data 的 argv.json(locale=zh-cn)。locale 生效需要「注册语言包 →
 * 重启应用」两段:语言包目录与 user-data 持久化在 .vscode-test/ 下,两种
 * 模式都由 runTests 连跑两次(第一段注册,第二段 NLS 真正以 zh-cn 起宿主)。
 */
function prepareZhLocaleHost(
  extensionDevelopmentPath: string,
  unpackRoot: string
): { extensionsDir: string; userDataDir: string } {
  const cacheRoot = path.join(extensionDevelopmentPath, '.vscode-test', 'manifest-nls');
  const extensionsDir = path.join(cacheRoot, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });
  const lpVersion = '1.131.0';
  const lpVsix = path.join(extensionDevelopmentPath, '.vscode-test',
    `MS-CEINTL.vscode-language-pack-zh-hans-${lpVersion}.vsix`);
  if (!fs.existsSync(lpVsix)) {
    fs.mkdirSync(path.dirname(lpVsix), { recursive: true });
    // 先下 .part 再原子改名:断流残留的 .part 不会被下次的存在性检查误当缓存
    const lpPart = `${lpVsix}.part`;
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', lpPart,
      `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-zh-hans/${lpVersion}/file/MS-CEINTL.vscode-language-pack-zh-hans-${lpVersion}.vsix`]);
    fs.renameSync(lpPart, lpVsix);
  }
  execFileSync('unzip', ['-o', '-q', lpVsix, '-d', unpackRoot]);
  const lpRoot = path.join(extensionsDir, `ms-ceintl.vscode-language-pack-zh-hans-${lpVersion}`);
  fs.cpSync(path.join(unpackRoot, 'extension'), lpRoot, { recursive: true });
  const userDataDir = path.join(cacheRoot, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'argv.json'), JSON.stringify({ locale: 'zh-cn' }));
  return { extensionsDir, userDataDir };
}

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
  // IDE-AUD-017:自然编辑长会话(与 16s 短压力分开)——同一 field 装配,
  // 过滤切 longnatural(longSessionNatural.test.ts),预设时长+打字粒度
  // 编辑序列+RSS/worker/缓存趋势预算。
  const longNaturalMode = process.argv.includes('--longnatural');
  const finalMarksMode = process.argv.includes('--final');
  // IDE-GIT-012 历史宿主影响验收:与 --final 共用 field 装配(demo 资产+5000 外部根),
  // 另把工作区根建成 git 仓库+大历史(history_probe.py),suite 过滤切 history。
  const historyMode = process.argv.includes('--history');
  // IDE-AUD-017 长会话趋势:与 --final/--history 共用 field 装配(demo 资产+
  // 5000 外部根),suite 过滤切 longtrend(longSessionTrend.test.ts)。REV-034
  // 短压力(--longsession)原样保留,两套件互补互不覆盖。
  const longTrendMode = process.argv.includes('--longtrend');
  // IDE-LINT-012 快速修复边界验收:与 --field 共用装配(夹具由套件自写),
  // 过滤切 lintfix(lintQuickFixBoundaries.test.ts)——receiver-none 守卫
  // 修复在真实 VS Code 应用:多行调用/同行双 receiver/EOF/同级后续语句。
  const lintFixMode = process.argv.includes('--lintfix');
  const delFileMode = process.argv.includes('--delfile');
  const renameMode = process.argv.includes('--rename');
  // 面板打开冒烟(热更/运行时查询等):默认工作区即可,不装配 demo/field 夹具
  const panelOpenMode = process.argv.includes('--panelopen');
  if (panelOpenMode) {
    process.env.KODE_ELECTRON_SUITE = 'panelopen';
  }
  // KODE-I18N-001 manifest %key% 真机解析:默认工作区即可,读解析后的
  // extension.packageJSON 断言无裸 token 残留(真机层唯一能触达 VS Code
  // 实际 locale 解析路径的面)
  const manifestNlsMode = process.argv.includes('--manifestnls');
  if (manifestNlsMode) {
    process.env.KODE_ELECTRON_SUITE = 'manifestnls';
  }
  const dirtyMode = process.argv.includes('--dirty');
  // KSEM-CELL-15:cellData 全链(未保存 def 编辑 → 补全/F12/inlay/hover/诊断
  // 五面联动;真实 Rust 门)。kode-server 二进制缺席时整模式自动降级。
  const celldataMode = process.argv.includes('--celldata');
  let devPath = extensionDevelopmentPath;
  let workspacePath = path.resolve(extensionDevelopmentPath, 'tests/fixtures/electron-ws');
  let dbgLaunchArgs: string[] = [];
  // IDE-LIV-003..007 真机运行观测联验:工作区=KODE_LIV_WORKSPACE(引擎资产根,
  // 供 LIV-007 源码解析),引擎日志目录=KODE_LIV_ENGINE_LOG_DIR,证据出=
  // KODE_LIV_OUT;引擎须已在本机运行(组件发现走真实广播)。
  const liveMode = process.argv.includes('--live');
  if (liveMode) {
    process.env.KODE_ELECTRON_SUITE = 'live';
    if (!process.env.KODE_LIV_WORKSPACE) {
      throw new Error('--live 需要 KODE_LIV_WORKSPACE(引擎资产根工作区)');
    }
    workspacePath = process.env.KODE_LIV_WORKSPACE;
  }
  // KODE-DBG-001 真机验收:工作区=KODE_DBG_WORKSPACE(引擎资产根,回落
  // KODE_LIV_WORKSPACE),证据出=KODE_DBG_OUT;引擎须已在本机运行。
  // debugpy 附加还需要 debugpy 调试器扩展:套件首跑前由 dbglive 段落把
  // 本机已装的 ms-python.debugpy 复制进 .vscode-test/extensions(见下)。
  const dbgLiveMode = process.argv.includes('--dbglive');
  if (dbgLiveMode) {
    process.env.KODE_ELECTRON_SUITE = 'dbglive';
    workspacePath = process.env.KODE_DBG_WORKSPACE
      || process.env.KODE_LIV_WORKSPACE
      || workspacePath;
    // debugpy 调试器扩展(ms-python.debugpy 贡献 'debugpy' 调试类型)不在
    // 纯下载的测试 VS Code 里;测试实例直接挂本机用户扩展目录(该目录已
    // 由 `Code --install-extension ms-python.debugpy` 装好,依赖的
    // ms-python.python 也在),并配独立 user-data 免与日常实例互扰。
    dbgLaunchArgs = [
      '--extensions-dir',
      process.env.KODE_DBG_EXTENSIONS_DIR ?? path.join(os.homedir(), '.vscode', 'extensions'),
      '--user-data-dir',
      path.join(extensionDevelopmentPath, '.vscode-test', 'dbglive-user-data')
    ];
  }
  // KODE-I18N-003 缺 key 回退真机验证:临时扩展副本删 zh-cn 包一个键,以
  // --locale=zh-cn 拉起真 VS Code,断言该键解析结果=默认包文案(回落),
  // 未删键的对照键=zh-cn 文案(locale 生效证明)。--manifestnls 的无残留
  // 断言在此副本上继续有效。
  const manifestFallbackMode = process.argv.includes('--manifestfallback');
  // UX-REVIEW-010f 运行时 bundle(vscode.l10n)缺 key 回退真机验证:临时扩展
  // 副本连 l10n/ 目录一起复制,删掉 zh-cn 运行时 bundle 一个键,以
  // --locale=zh-cn 拉起真 VS Code。套件改从副本里的 out 装载(extensionTestsPath
  // 同步指向副本),套件内 import 的 nlsRuntime 与产品同文件同宿主,l10n
  // 上下文 = 被测扩展本体:被删键 l10nText=英文源串(回落),未删键对照=
  // zh-cn 文案(locale 生效证明)。--manifestnls 的无残留断言在此副本上继续
  // 有效(manifest 未动)。
  const bundleFallbackMode = process.argv.includes('--bundlefallback');
  if (manifestFallbackMode && bundleFallbackMode) {
    throw new Error('--manifestfallback and --bundlefallback are mutually exclusive');
  }
  let localeArgs: string[] = [];
  if (manifestFallbackMode) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-manifest-fallback-'));
    // 失败路径也不留临时副本:清理挂在创建之后立刻注册(先于下载/解包等易败操作)
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    for (const name of ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'language-configuration.json']) {
      fs.copyFileSync(path.join(extensionDevelopmentPath, name), path.join(temporaryRoot, name));
    }
    fs.cpSync(path.join(extensionDevelopmentPath, 'out'), path.join(temporaryRoot, 'out'), { recursive: true });
    fs.cpSync(path.join(extensionDevelopmentPath, 'snippets'), path.join(temporaryRoot, 'snippets'), { recursive: true });
    const zhPath = path.join(temporaryRoot, 'package.nls.zh-cn.json');
    const zhBundle = JSON.parse(fs.readFileSync(zhPath, 'utf8')) as Record<string, string>;
    delete zhBundle['kbengine.command.refreshExplorer.title'];
    fs.writeFileSync(zhPath, JSON.stringify(zhBundle, null, 2) + '\n');
    const { extensionsDir, userDataDir } =
      prepareZhLocaleHost(extensionDevelopmentPath, path.join(temporaryRoot, 'lp-unpack'));
    devPath = temporaryRoot;
    process.env.KODE_ELECTRON_SUITE = 'manifestnls';
    process.env.KODE_MANIFEST_FALLBACK_TEMP = temporaryRoot;
    localeArgs = ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--locale=zh-cn'];
  } else if (bundleFallbackMode) {
    // 套件仍从仓库 out 装载(extensionTestsPath 不动):扩展宿主的定制模块解析器
    // 只对「被测扩展根内」的模块做 realpath 收纳检查,仓库外装载点走普通 Node
    // 解析;副本内的模块要 require mocha/glob 必须依赖副本外的 node_modules,
    // 首跑/二跑实测被宿主拒收(套件搬进副本这条路结构性封死)。断言面改为
    // 执行被测扩展自己注册的 kbengine.l10nProbe 命令(命令回调在被测扩展
    // 上下文里跑,l10nText=真机产品同一条取词路径),不需要套件共享 l10n 上下文。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-bundle-fallback-'));
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    for (const name of ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'language-configuration.json']) {
      fs.copyFileSync(path.join(extensionDevelopmentPath, name), path.join(temporaryRoot, name));
    }
    fs.cpSync(path.join(extensionDevelopmentPath, 'out'), path.join(temporaryRoot, 'out'), { recursive: true });
    fs.cpSync(path.join(extensionDevelopmentPath, 'snippets'), path.join(temporaryRoot, 'snippets'), { recursive: true });
    // 运行时 bundle 目录也进副本:vscode.l10n 按 package.json 的 "l10n" 声明
    // 从扩展根的 l10n/ 取 bundle.l10n.<locale>.json
    fs.cpSync(path.join(extensionDevelopmentPath, 'l10n'), path.join(temporaryRoot, 'l10n'), { recursive: true });
    // 激活面也要跑(defParser 的 vendored fast-xml-parser):manifest 模式只读
    // packageJSON 不激活,本模式 verify 段经 l10nProbe 真激活,缺 vendor 必红;
    // resources/syntaxes 补齐走查宿主的主题与图标面(缺了只出无害警告日志)
    fs.cpSync(path.join(extensionDevelopmentPath, 'vendor'), path.join(temporaryRoot, 'vendor'), { recursive: true });
    fs.cpSync(path.join(extensionDevelopmentPath, 'resources'), path.join(temporaryRoot, 'resources'), { recursive: true });
    fs.cpSync(path.join(extensionDevelopmentPath, 'syntaxes'), path.join(temporaryRoot, 'syntaxes'), { recursive: true });
    const zhPath = path.join(temporaryRoot, 'l10n', 'bundle.l10n.zh-cn.json');
    const zhBundle = JSON.parse(fs.readFileSync(zhPath, 'utf8')) as Record<string, string>;
    // 受害键 = 工作台选择器占位(走查入口对齐 UX-REVIEW-010e/010f),对照键 =
    // 同一选择器的动作项文案
    delete zhBundle['Choose a KBEngine task'];
    fs.writeFileSync(zhPath, JSON.stringify(zhBundle, null, 2) + '\n');
    const { extensionsDir, userDataDir } =
      prepareZhLocaleHost(extensionDevelopmentPath, path.join(temporaryRoot, 'lp-unpack'));
    devPath = temporaryRoot;
    process.env.KODE_ELECTRON_SUITE = 'manifestnls';
    process.env.KODE_BUNDLE_FALLBACK_TEMP = temporaryRoot;
    localeArgs = ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--locale=zh-cn'];
  }
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
  } else if (fieldMode || attributionMode || longSessionMode || finalMarksMode || historyMode || longTrendMode || longNaturalMode || lintFixMode) {
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
    // IDE-REV-035 大当前文档注解夹具:超 256KiB 且带「仅本文件存在」的返回
    // 注解 BIGDOC_RETURN——大文档内 hover 命中时 preview 含该标记即证明走的是
    // 当前文档注解路径(小调用方的 JSONDATA 与其他文件均无此标记)。体量
    // 与 acc001 大文件同构(padding 同款),与无注解的 plain_var_large.py
    // 互不影响(acc001 的「无 ->」断言只针对原文件)。
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/plain_var_large_annotated.py'),
      [
        '# IDE-REV-035 fixture: oversized file WITH a current-document return annotation.',
        'def get_big_annotated() -> BIGDOC_RETURN:',
        '    return None',
        '',
        '',
        'big_value = get_big_annotated()',
        '',
        '',
        'class PlainVarLargeAnnotatedMixin:'
      ].concat(
        Array.from({ length: 5200 }, (_, index) =>
          `    def large_annotated_method_${index}(self):\n        return ${index}\n\n    # rev035 padding ${index}: oversized on purpose for worker dispatch`)
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
    // IDE-REV-037 关闭文件注解 TTL 交互夹具:调用方 import 引用「未打开」的
    // provider 模块(ttl_provider.py 全程不开,其注解只存在于磁盘注解快照);
    // 两标记 TTL_PROVIDER_RETURN / TTL_LOCAL_RETURN 全工作区各仅一处(套件
    // 断言词边界恰一处),命中 preview 含标记=答话来源的结构性证明——
    // local_value 来自当前文档桶,ttl_data 只能来自磁盘快照,过期后必失。
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/ttl_provider.py'),
      [
        '# IDE-REV-037 fixture: provider module, never opened by the test.',
        'def build_ttl_data() -> TTL_PROVIDER_RETURN:',
        '    return None'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(workspacePath, 'scripts/common/training/ttl_import_caller.py'),
      [
        '# IDE-REV-037 fixture: caller imports an unopened module (disk snapshot path).',
        'from training.ttl_provider import build_ttl_data',
        '',
        '',
        'def local_annotated() -> TTL_LOCAL_RETURN:',
        '    return None',
        '',
        '',
        'local_value = local_annotated()',
        'ttl_data = build_ttl_data()'
      ].join('\n')
    );
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
    process.env.KODE_ELECTRON_SUITE = finalMarksMode
      ? 'final'
      : longNaturalMode
        ? 'longnatural'
        : attributionMode
          ? 'attribution'
          : longSessionMode
            ? 'longsession'
            : historyMode
              ? 'history'
              : longTrendMode
                ? 'longtrend'
                : lintFixMode ? 'lintfix' : 'field';
    process.env.KODE_FIELD_WORKSPACE = workspacePath;
    process.env.KODE_FIELD_MODE = process.env.KODE_FIELD_MODE ?? 'enabled';
    process.env.KODE_FIELD_OUT = process.env.KODE_FIELD_OUT
      ?? path.resolve(extensionDevelopmentPath, 'docs/perf/2026-10-27-field-baseline-run.txt');
    process.env.KODE_HISTORY_OUT = process.env.KODE_HISTORY_OUT
      ?? path.resolve(extensionDevelopmentPath, 'docs/perf/2026-11-05-history-host-impact-run.txt');
    process.env.KODE_LINTFIX_OUT = process.env.KODE_LINTFIX_OUT
      ?? path.resolve(extensionDevelopmentPath, 'docs/perf/2026-11-06-lint-quickfix-boundaries-run.txt');
    process.env.KODE_AUD17_OUT = process.env.KODE_AUD17_OUT
      ?? path.resolve(extensionDevelopmentPath, 'docs/perf/2026-11-05-aud017-long-session-run.txt');
    if (historyMode) {
      // IDE-GIT-012:把工作区根建成 git 仓库 + 大历史(history_probe.py)。
      // 每提交追加一段,使 `git log -L` 走全部提交→查询在途窗口(大历史)。
      const git = (args: string[]): void => {
        execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
      };
      git(['init', '-q']);
      git(['config', 'user.email', 't@example.com']);
      git(['config', 'user.name', 'T']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'init']);
      const probePath = path.join(workspacePath, 'scripts', 'common', 'training', 'history_probe.py');
      fs.mkdirSync(path.dirname(probePath), { recursive: true });
      fs.writeFileSync(probePath, [
        '# IDE-GIT-012 large-history probe: one appended method per commit so',
        '# `git log -L` walks every commit (in-flight query window).',
        'class HistoryProbe:'
      ].join('\n'));
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'probe-base']);
      const commits = Number(process.env.KODE_HISTORY_COMMITS ?? '300');
      for (let i = 1; i <= commits; i += 1) {
        fs.appendFileSync(probePath, `\n    def m${i}(self):\n        return ${i}\n`);
        git(['add', '-A']);
        git(['commit', '-q', '-m', `c${i}`]);
      }
    }
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
  } else if (delFileMode) {
    // IDE-ACC-011 删除文件后的导航清理验收:GoneEntity 双段——CellMethods
    // <onGone>(实现 scripts/cell/GoneEntity.py,套件中途 fs.rmSync 真删)+
    // BaseMethods <onPing>(实现留守,且 ping 调 self.cell.onGone()=<onGone>
    // 的引用点)。删除后定义/实现列表不得再返回旧路径,引用与留守导航不牵连。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-delfile-'));
    workspacePath = temporaryRoot;
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'cell'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '	<GoneEntity hasBase="true" hasCell="true"></GoneEntity>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entity_defs', 'GoneEntity.def'), [
      '<root>',
      '    <BaseMethods>',
      '        <onPing>',
      '            <Arg>UINT8</Arg>',
      '        </onPing>',
      '    </BaseMethods>',
      '    <CellMethods>',
      '        <onGone>',
      '            <Arg>UINT8</Arg>',
      '        </onGone>',
      '    </CellMethods>',
      '</root>'
    ].join('\n'));
    // base 实现留守+提供 <onGone> 的调用点;cell 实现形参与 def <Arg> 对齐
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'base', 'GoneEntity.py'), [
      '# acc011 surviving base implementation: calls the cell method (reference point).',
      'class GoneEntity:',
      '',
      '    def onPing(self, level):',
      '        self.cell.onGone()'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'cell', 'GoneEntity.py'), [
      '# acc011 deletion target: removed mid-suite by fs.rmSync.',
      'class GoneEntity:',
      '',
      '    def onGone(self, level):',
      '        return None'
    ].join('\n'));
    fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, '.vscode/settings.json'), JSON.stringify({
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'delfile';
    process.env.KODE_DEL_ROOT = temporaryRoot;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (renameMode) {
    // IDE-ACC-012 重命名后的目标迁移验收:RenamedEntity 双段——CellMethods
    // <onMove>(实现 scripts/cell/RenamedEntity.py,套件中途经宿主
    // workspace.fs.rename 挪到平铺 scripts/RenamedEntity.py:归属约定按
    // basename 找候选,平铺形态在候选序列内=重命名后映射应迁到新 URI)+
    // BaseMethods <onPing>(实现留守,且 ping 调 self.cell.onMove()=
    // <onMove> 的引用点)。重命名后定义/实现列表只返回新 URI,引用列表
    // 无重复新旧目标,留守导航不牵连。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-rename-'));
    workspacePath = temporaryRoot;
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'cell'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '	<RenamedEntity hasBase="true" hasCell="true"></RenamedEntity>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entity_defs', 'RenamedEntity.def'), [
      '<root>',
      '    <BaseMethods>',
      '        <onPing>',
      '            <Arg>UINT8</Arg>',
      '        </onPing>',
      '    </BaseMethods>',
      '    <CellMethods>',
      '        <onMove>',
      '            <Arg>UINT8</Arg>',
      '        </onMove>',
      '    </CellMethods>',
      '</root>'
    ].join('\n'));
    // base 实现留守+提供 <onMove> 的调用点;cell 实现形参与 def <Arg> 对齐,
    // 套件中途挪到 scripts/ 平铺位(内容不变,basename 不变)
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'base', 'RenamedEntity.py'), [
      '# acc012 surviving base implementation: calls the cell method (reference point).',
      'class RenamedEntity:',
      '',
      '    def onPing(self, level):',
      '        self.cell.onMove()'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'cell', 'RenamedEntity.py'), [
      '# acc012 rename target: moved mid-suite via workspace.fs.rename to scripts/ flat layout.',
      'class RenamedEntity:',
      '',
      '    def onMove(self, level):',
      '        return None'
    ].join('\n'));
    fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, '.vscode/settings.json'), JSON.stringify({
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'rename';
    process.env.KODE_RENAME_ROOT = temporaryRoot;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (dirtyMode) {
    // IDE-ACC-013 未保存编辑与放弃编辑的导航验收:DirtyEntity 单段——
    // BaseMethods <onSpin>(实现 scripts/base/DirtyEntity.py,def onSpin 固定
    // 0 基第 3 行)。套件中途真实编辑器手势:开编辑器+顶部插 5 行(脏缓冲,
    // 方法挪到第 8 行,不保存)→ F12 必须落缓冲新行;revert+关闭后 → F12
    // 恢复磁盘行。
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-dirty-'));
    workspacePath = temporaryRoot;
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '	<DirtyEntity hasBase="true"></DirtyEntity>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'entity_defs', 'DirtyEntity.def'), [
      '<root>',
      '    <BaseMethods>',
      '        <onSpin>',
      '            <Arg>UINT8</Arg>',
      '        </onSpin>',
      '    </BaseMethods>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'scripts', 'base', 'DirtyEntity.py'), [
      '# acc013 dirty buffer navigation fixture.',
      'class DirtyEntity:',
      '',
      '    def onSpin(self, level):',
      '        return None'
    ].join('\n'));
    fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, '.vscode/settings.json'), JSON.stringify({
      'kbengine.showFinalConfigOnOpen': false,
      'kbengine.python.stubExport': false,
      'kbengine.python.extraPathsSync': false
    }, null, 2));
    process.env.KODE_ELECTRON_SUITE = 'dirty';
    process.env.KODE_DIRTY_ROOT = temporaryRoot;
    process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  } else if (celldataMode) {
    // KSEM-CELL-15 未保存 def 编辑的 cellData 全链验收(真实编辑器+真实 Rust
    // 门):双根工作区,根 A ChainEntity 走 Parent(ChainBase)/接口(ROLE)/组件
    // 槽(BagBox)三边,根 B 同名实体只带 alien 键(跨根负例)。套件中途真实
    // 编辑手势:打开根 A 实体 def 插入 bonus 属性(不保存),随后补全/F12/
    // inlay/hover/错键+写入类型诊断五面必须一起反映未保存内容。键宇宙走
    // $/kode/semantics/cellDataKeys(kode-server 二进制)——自动发现落空时
    // 整模式降级为默认工作区(套件不入列),不伪造通过。
    const repoRoot = path.resolve(extensionDevelopmentPath);
    const serverExecutable = process.platform === 'win32' ? 'kode-server.exe' : 'kode-server';
    const serverBinary = ['bin', path.join('target', 'debug'), path.join('target', 'release')]
      .map(dir => path.join(repoRoot, dir, serverExecutable))
      .find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
    // 陈旧二进制预检:扩展自动发现与这里同序(bin 优先)。bin/ 里的旧构建
    // 不含 cellDataKeys 方法时 runInRust 静默失败→诊断恒空,先在此点名,
    // 免得烧一轮真机运行才定位(2026-11-12 实测 bin/ 停在 11-08 无此方法)。
    const serverBinaryHasCellDataKeys = (candidate: string): boolean => {
      try {
        return fs.readFileSync(candidate).includes(Buffer.from('cellDataKeys'));
      } catch {
        return false;
      }
    };
    if (!serverBinary) {
      console.warn('[celldata] kode-server binary not found; cellData full-chain suite skipped.');
    } else if (!serverBinaryHasCellDataKeys(serverBinary)) {
      console.warn(
        `[celldata] ${serverBinary} lacks cellDataKeys; rebuild it (cargo build -p kode-server --release && cp target/release/kode-server bin/) or the suite will fail with empty diagnostics.`
      );
    } else {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-kbengine-celldata-'));
      const rootA = path.join(temporaryRoot, 'rootA');
      const rootB = path.join(temporaryRoot, 'rootB');
      const stageRoot = (root: string, defLines: string[], baseLines: string[], cellLines: string[]): void => {
        fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'interfaces'), { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'components'), { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts', 'cell'), { recursive: true });
        fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), [
          '<root>',
          '\t<ChainEntity hasBase="true" hasCell="true"></ChainEntity>',
          '</root>'
        ].join('\n'));
        fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'ChainEntity.def'), defLines.join('\n'));
        fs.writeFileSync(path.join(root, 'scripts', 'base', 'ChainEntity.py'), baseLines.join('\n'));
        fs.writeFileSync(path.join(root, 'scripts', 'cell', 'ChainEntity.py'), cellLines.join('\n'));
      };
      stageRoot(rootA, [
        '<root>',
        '    <Properties>',
        '        <gold>',
        '            <Type>UINT32</Type>',
        '            <Flags>CELL_PUBLIC</Flags>',
        '        </gold>',
        '    </Properties>',
        '    <Parent>ChainBase</Parent>',
        '    <Interfaces>',
        '        <Interface>ROLE</Interface>',
        '    </Interfaces>',
        '    <Components>',
        '        <bag>',
        '            <Type>BagBox</Type>',
        '        </bag>',
        '    </Components>',
        '</root>'
      ], [
        // base 侧只读:无动态键写入 → 世界封闭,未声明键的裸下标读可证 absent
        // (错键「确认」级诊断的成立前提;KSEM-CELL-09/10 开放世界语义)
        'class ChainEntity:',
        '',
        '    def onGetCellCellData(self, cellData):',
        '        self.snapshot = cellData',
        '',
        '    def audit(self):',
        '        total = self.cellData["gold"]',
        '        mana = self.cellData["mana"]',
        '        rank = self.cellData["roleRank"]',
        '        bag = self.cellData["bag"]',
        '        data = self.cellData',
        '        score = data["bonus"]',
        // 直读行:CELL-05 跳转面只认 self.cellData 直读(别名面是键宇宙/诊断
        // 面能力,跳转面不覆盖),F12 靶点用本行;上一行别名读留给 inlay 面
        '        dup = self.cellData["bonus"]',
        '        ghost = self.cellData["ghost"]'
      ], [
        // cell 侧承载动态键写入(写入类型面的靶点):worldOpen 只作用于错键面
        // (读缺失不可证),不影响写入类型校验(键声明后 str→UINT8 即报)
        'class ChainEntity:',
        '',
        '    def onGetCellCellData(self, cellData):',
        '        self.snapshot = cellData',
        '',
        '    def tune(self):',
        '        data = self.cellData',
        '        self.cellData["bonus"] = "x"',
        '        weight = self.cellData["gold"]'
      ]);
      fs.writeFileSync(path.join(rootA, 'scripts', 'entity_defs', 'ChainBase.def'), [
        '<root>',
        '    <Properties>',
        '        <mana>',
        '            <Type>UINT16</Type>',
        '            <Flags>CELL_PUBLIC</Flags>',
        '        </mana>',
        '    </Properties>',
        '</root>'
      ].join('\n'));
      fs.writeFileSync(path.join(rootA, 'scripts', 'entity_defs', 'interfaces', 'ROLE.def'), [
        '<root>',
        '    <Properties>',
        '        <roleRank>',
        '            <Type>UINT8</Type>',
        '            <Flags>CELL_PUBLIC</Flags>',
        '        </roleRank>',
        '    </Properties>',
        '</root>'
      ].join('\n'));
      fs.writeFileSync(path.join(rootA, 'scripts', 'entity_defs', 'components', 'BagBox.def'), [
        '<root>',
        '    <Properties>',
        '        <pouch>',
        '            <Type>UINT32</Type>',
        '        </pouch>',
        '    </Properties>',
        '</root>'
      ].join('\n'));
      stageRoot(rootB, [
        '<root>',
        '    <Properties>',
        '        <alien>',
        '            <Type>UINT8</Type>',
        '            <Flags>CELL_PUBLIC</Flags>',
        '        </alien>',
        '    </Properties>',
        '</root>'
      ], [
        'class ChainEntity:',
        '',
        '    def onGetCellCellData(self, cellData):',
        '        self.snapshot = cellData',
        '',
        '    def audit(self):',
        '        value = self.cellData["alien"]',
        '        cross = self.cellData["gold"]'
      ], [
        'class ChainEntity:',
        '',
        '    def onGetCellCellData(self, cellData):',
        '        self.snapshot = cellData',
        '',
        '    def audit(self):',
        '        value = self.cellData["alien"]',
        '        cross = self.cellData["gold"]'
      ]);
      fs.mkdirSync(path.join(temporaryRoot, '.vscode'), { recursive: true });
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
      process.env.KODE_ELECTRON_SUITE = 'celldata';
      process.env.KODE_CELLDATA_ROOT = temporaryRoot;
      process.env.KODE_CELLDATA_ROOT_A = rootA;
      process.env.KODE_CELLDATA_ROOT_B = rootB;
      process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    }
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

  const electronLaunch = () => runTests({
    extensionDevelopmentPath: devPath,
    extensionTestsPath,
    ...(fs.existsSync(cachedExecutable) ? { vscodeExecutablePath: cachedExecutable } : {}),
    launchArgs: [
      workspacePath,
      ...localeArgs,
      ...dbgLaunchArgs,
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
  if (manifestFallbackMode || bundleFallbackMode) {
    // 双段:第一段注册语言包(回退用例自 skip),第二段 zh-cn 必须生效并跑
    // 真断言(verify 段 locale 未生效会红,不会双 skip 全绿)
    const launchGate = manifestFallbackMode ? 'KODE_MANIFEST_LAUNCH' : 'KODE_BUNDLE_LAUNCH';
    process.env[launchGate] = 'register';
    await electronLaunch();
    process.env[launchGate] = 'verify';
    await electronLaunch();
    delete process.env[launchGate];
  } else {
    await electronLaunch();
  }
}

main().catch(error => {
  console.error('真机层启动失败:', error);
  process.exit(1);
});
