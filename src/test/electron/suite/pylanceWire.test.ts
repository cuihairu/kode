import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// RUST-263 Pylance 真机接线实证(疑点 B=KBEngine 桩包识别、A=extraPaths
// `${workspaceFolder}` 变量形态、C=scripts 根探测范围界)。与 pylanceStubPriority
// (RUST-170,手写 settings 测优先级)互补:本套件跑的是 kode 的**默认激活链**
// (python.stubExport / python.extraPathsSync 全默认开),settings 由 kode 写,
// 被测问题是「kode 写出来的东西真 Pylance 吃不吃」。三段由 runTest --pylancewire
// 发射:段1=demo 标准布局默认态(stubCopy 默认开=桩包已复制、extraPaths 变量
// 形态已写);段2=同工作区显式 stubCopy:true 重启,激活链 silent 自动复制桩包,
// 测 KBEngine 桩包在真 Pylance 的解析落位(manual 命令尾部 await 通知关闭,
// headless 无人点掉必悬——run1 900s 超时实录,故走等价 silent 激活路径);
// 段3=探测范围外布局(kode 零写入+全 unresolved 边界)。三段共用本文件,
// PHASE 分流——正例臂(段1/2)与负例臂(段3)即本套件自身的红绿对照。
// 注:Pylance 读 VS Code 设置(python.analysis.*),不读 pyrightconfig.json
// (RUST-170 裁定);段内一切断言只认 executeDefinitionProvider / 真诊断集合。

const ROOT = process.env.KODE_PYLANCE_WIRE_ROOT;
const PHASE = process.env.KODE_PYLANCE_WIRE_PHASE ?? '1';
assert.ok(ROOT, 'runTest.js --pylancewire must set KODE_PYLANCE_WIRE_ROOT');

const PROBE = path.join(ROOT!, 'scripts', 'pylance_wire_probe.py');
const SCOPE_PROBE = path.join(ROOT!, 'app', 'pylance_scope_probe.py');
const SETTINGS = path.join(ROOT!, '.vscode', 'settings.json');
const STUBS_DIR = path.join(ROOT!, '.kbengine', 'stubs');

interface PythonSettings {
  extraPaths?: unknown;
  stubPath?: unknown;
  [key: string]: unknown;
}

function readSettings(): PythonSettings | null {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) as PythonSettings;
  } catch {
    return null;
  }
}

/** 探针文本里 identifier 首次出现处的行/列(ASCII 探针,列=字符数)。 */
async function tokenPosition(
  file: string,
  identifier: string
): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  const uri = vscode.Uri.file(file);
  const text = (await vscode.workspace.openTextDocument(uri)).getText();
  const at = text.indexOf(identifier);
  assert.ok(at >= 0, `probe token missing: ${identifier}`);
  const before = text.slice(0, at);
  const line = before.split('\n').length - 1;
  const character = at - (before.lastIndexOf('\n') + 1);
  return { uri, position: new vscode.Position(line, character) };
}

async function definitionTargets(file: string, identifier: string): Promise<string[]> {
  const { uri, position } = await tokenPosition(file, identifier);
  const raw = (await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider', uri, position
  )) as vscode.Location[] | vscode.Location | null | undefined;
  const locations = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return locations.map(location => location.uri.fsPath);
}

async function hoverText(file: string, identifier: string): Promise<string> {
  const { uri, position } = await tokenPosition(file, identifier);
  const raw = (await vscode.commands.executeCommand(
    'vscode.executeHoverProvider', uri, position
  )) as vscode.Hover[] | null | undefined;
  const parts: string[] = [];
  for (const hover of raw ?? []) {
    for (const part of hover.contents) {
      parts.push(typeof part === 'string' ? part : (part as vscode.MarkdownString).value);
    }
  }
  return parts.join('\n').slice(0, 300);
}

async function pylanceDiagnostics(file: string): Promise<vscode.Diagnostic[]> {
  const uri = vscode.Uri.file(file);
  // showTextDocument 让文档真正可见:Pylance 默认 diagnosticMode=openFilesOnly,
  // 仅 openTextDocument(API 开)不出诊断(run3 段3 空[]实录)。
  await vscode.window.showTextDocument(uri);
  return vscode.languages.getDiagnostics(uri).filter(diag => diag.source === 'Pylance');
}

async function poll<T>(
  probe: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (done(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/** .kbengine/stubs 下任意角色子目录(或顶层)的 KBEngine/__init__.pyi 全集。 */
function stubPackageInitFiles(): string[] {
  if (!fs.existsSync(STUBS_DIR)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of fs.readdirSync(STUBS_DIR)) {
    const initPath = path.join(STUBS_DIR, entry, 'KBEngine', '__init__.pyi');
    if (fs.existsSync(initPath)) {
      found.push(initPath);
    }
  }
  const topLevel = path.join(STUBS_DIR, 'KBEngine', '__init__.pyi');
  if (fs.existsSync(topLevel)) {
    found.push(topLevel);
  }
  return found;
}

const EVIDENCE: string[] = [];
afterEach(function () {
  for (const line of EVIDENCE.splice(0)) {
    console.log(`[rust-263-pylance] ${line}`);
  }
});

const phase1 = PHASE === '1' ? describe : describe.skip;
const phase2 = PHASE === '2' ? describe : describe.skip;
const phase3 = PHASE === '3' ? describe : describe.skip;

phase1('RUST-263 段1:demo 标准布局默认激活链(真 Pylance)', function () {
  // 激活链(桩导出→类型桩→extraPaths 同步)全异步;三臂轮询 + Pylance
  // 分析预热,给足 15 分钟。
  this.timeout(900000);

  before(async function () {
    this.timeout(120000);
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(pylance, 'Pylance 扩展未随宿主加载(检查 --extensions-dir 挂载)');
    await pylance.activate();
    EVIDENCE.push(`pylance version=${(pylance as vscode.Extension<unknown>).packageJSON.version}`);
    EVIDENCE.push(`vscode version=${vscode.version}`);
  });

  it('默认激活:kode 写 extraPaths(`${workspaceFolder}/scripts` 变量形态)', async function () {
    const settings = await poll(
      () => readSettings(),
      value => Array.isArray(value?.['python.analysis.extraPaths']),
      90000
    );
    const extraPaths = settings?.['python.analysis.extraPaths'] as string[];
    EVIDENCE.push(`settings python keys=${JSON.stringify({
      extraPaths: settings?.['python.analysis.extraPaths'],
      stubPath: settings?.['python.analysis.stubPath']
    })}`);
    assert.ok(
      extraPaths.some(entry => entry === '${workspaceFolder}/scripts'),
      `extraPaths 缺 scripts 根: ${JSON.stringify(extraPaths)}`
    );
  });

  it('默认态(stubCopy 默认开):桩包已复制;common 走变量形态 extraPaths 解析成功', async function () {
    // 默认态钉边界:kbengine.python.stubCopy 默认开(17570cb5 起),激活即复制
    // 桩包——不写 settings 也照跑。窄闸的 false 臂不在本链:真机三段的被测面是
    // 「kode 写出来的东西 Pylance 吃不吃」,关闸臂归单测(pythonStubExport /
    // pythonExtraPaths)覆盖。
    const initFiles = await poll(
      () => stubPackageInitFiles(),
      list => list.length > 0,
      90000
    );
    EVIDENCE.push(`default-state stub init files=${JSON.stringify(initFiles.map(file => file.slice(ROOT!.length)))}`);
    assert.ok(initFiles.length > 0, 'stubCopy 默认开:默认激活应复制 KBEngine 桩包');
    // 疑点 A 的正例:kode 写的 `${workspaceFolder}/scripts` 变量形态若真
    // Pylance 不展开,这里落空;落位即变量形态在真 Pylance 生效的实证。
    // 排在桩包复制之后:复制先落,extraPaths 同步才成,才谈得上被 Pylance 消费。
    const targets = await poll(
      () => definitionTargets(PROBE, 'DemoConsts'),
      paths => paths.some(target => target.endsWith('/scripts/common/DemoConsts.py')),
      180000
    );
    EVIDENCE.push(`DemoConsts def targets=${JSON.stringify(targets)}`);
    assert.ok(
      targets.some(target => target.endsWith('/scripts/common/DemoConsts.py')),
      `common 模块未经变量形态 extraPaths 解析: ${JSON.stringify(targets)}`
    );
    // 证据面(不断言):默认态 KBEngine 解析落位记录在案
    const kbeTargets = await definitionTargets(PROBE, 'KBEngine');
    EVIDENCE.push(`default-state KBEngine def targets=${JSON.stringify(kbeTargets)}`);
  });

});

phase2('RUST-263 段2:stubCopy 开(同工作区重启)——激活自动复制桩包,真 Pylance 识别', function () {
  this.timeout(900000);

  before(async function () {
    this.timeout(120000);
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(pylance, 'Pylance 扩展未随宿主加载(检查 --extensions-dir 挂载)');
    await pylance.activate();
  });

  it('激活链 silent 自动复制:KBEngine 桩包在盘,settings 全量记录(证据面)', async function () {
    const initFiles = await poll(
      () => stubPackageInitFiles(),
      list => list.length > 0,
      90000
    );
    EVIDENCE.push(`stub package init files=${JSON.stringify(initFiles.map(f => f.slice(ROOT!.length)))}`);
    assert.ok(initFiles.length > 0, 'stubCopy 开激活后桩包不在盘');
    EVIDENCE.push(`post-copy settings=${JSON.stringify({
      extraPaths: readSettings()?.['python.analysis.extraPaths'],
      stubPath: readSettings()?.['python.analysis.stubPath']
    })}`);
  });

  it('import KBEngine 定义落位 .kbengine/stubs(疑点 B 正例)', async function () {
    const targets = await poll(
      () => definitionTargets(PROBE, 'KBEngine'),
      paths => paths.some(target =>
        target.includes('.kbengine/stubs') && target.includes('KBEngine')),
      240000
    );
    EVIDENCE.push(`KBEngine def targets=${JSON.stringify(targets.map(t => t.slice(ROOT!.length)))}`);
    EVIDENCE.push(`KBEngine hover=${JSON.stringify(await hoverText(PROBE, 'KBEngine'))}`);
    // def 落位后再读一次:段2 首臂证据读的是拷贝后/同步完成前的瞬态,settled
    // 态才解释落位为何在 shared/——processMode 同步链(pythonProcessConfig)
    // 把 stubs/shared 写进 python.analysis.extraPaths 首位。
    EVIDENCE.push(`settled settings=${JSON.stringify({
      extraPaths: readSettings()?.['python.analysis.extraPaths'],
      stubPath: readSettings()?.['python.analysis.stubPath']
    })}`);
    // API 级有效值:Pylance 读的是配置系统合成结果,不只有盘上 .vscode/
    // settings.json(Workspace-scope 写入落工作区内部存储);def 落位在
    // stubs/shared 而盘上文件无该条目,有效值面才说得通。
    EVIDENCE.push(`effective python.analysis=${JSON.stringify({
      extraPaths: vscode.workspace.getConfiguration('python.analysis').get('extraPaths'),
      stubPath: vscode.workspace.getConfiguration('python.analysis').get('stubPath')
    })}`);
    assert.ok(
      targets.some(target => target.includes('.kbengine/stubs') && target.includes('KBEngine')),
      `KBEngine 未解析进 kode 导出桩: ${JSON.stringify(targets)}`
    );
    // 归属裁决:executeDefinitionProvider 聚合全部 provider(kode 自己也可能
    // 应答),def/hover 落位不足以证明「Pylance 侧识别」。诊断集合是 Pylance
    // 独占面——以 unused 提示出现为「Pylance 已分析本文件」信号,再断言无
    // unresolved;若此处红,则 def/hover 证据只能归 kode provider,疑点 B
    // 判「Pylance 未识别」。
    const diags = await poll(
      () => pylanceDiagnostics(PROBE),
      list => list.some(diag => /is not accessed|could not be resolved/.test(diag.message)),
      240000
    );
    EVIDENCE.push(`post-copy Pylance diagnostics=${JSON.stringify(
      diags.map(diag => ({ code: String((diag.code as { value?: string })?.value ?? diag.code), message: diag.message.slice(0, 120) }))
    )}`);
    assert.ok(
      !diags.some(diag => diag.message.includes('"KBEngine" could not be resolved')),
      'Pylance 侧仍报 KBEngine unresolved——def/hover 落位只能归 kode provider,疑点 B 判负'
    );
    // 机制钉死:settings 有效值只有 scripts+stubs(stubs/shared 不在其中,
    // stubPath=默认 typings),Pylance 却把 import KBEngine 解析到 stubs/shared/
    // KBEngine/__init__.pyi——唯一载体是 kode 激活链写的 pyrightconfig.json
    // (pythonProcessConfig extraPaths 首位=stubs/shared),即 Pylance 实读
    // pyrightconfig.json(RUST-170 档「不读」前提由此推翻;kbe-stub 虚拟文档
    // 层不可能产出盘上 fsPath,kode provider 假设已排除)。
    const pyrightConfigPath = path.join(ROOT!, 'pyrightconfig.json');
    const pyrightRaw = fs.existsSync(pyrightConfigPath)
      ? fs.readFileSync(pyrightConfigPath, 'utf8') : null;
    EVIDENCE.push(`pyrightconfig.json=${pyrightRaw ? pyrightRaw.slice(0, 500) : 'absent'}`);
    assert.ok(
      pyrightRaw !== null && pyrightRaw.includes('stubs/shared'),
      'pyrightconfig.json 缺失或不含 stubs/shared——落位机制存疑,须复查'
    );
  });
});

phase3('RUST-263 段3:探测范围外布局(kode 零写入+真 Pylance 全 unresolved)', function () {
  this.timeout(900000);

  before(async function () {
    this.timeout(120000);
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(pylance, 'Pylance 扩展未随宿主加载(检查 --extensions-dir 挂载)');
    await pylance.activate();
  });

  it('扩展照常激活(activationEvents 命中)且无 KBEngine 特征信号', async function () {
    // 激活发生标记:ensureDebugConfig 激活期在托管目录生成 debug.json 骨架。
    // 没有它就断言「零写入」会是空洞的绿(扩展没激活也零写入)。
    const debugConfig = path.join(ROOT!, '.kbengine', 'debug.json');
    const found = await poll(
      () => fs.existsSync(debugConfig),
      value => value,
      90000
    );
    EVIDENCE.push(`activation marker .kbengine/debug.json present=${found}`);
    assert.ok(found, '激活标记 debug.json 未出现——扩展未激活,负例断言不作数');
    // 负例的前提本身要钉住:夹具无任何 KBEngine 特征信号(.def / entities.xml
    // 等),否则「范围外」不成立——旧夹具 myserver/server 下带 .def + entities.xml,
    // 恰命中 workspaceGate 的特征 glob,复制+接线全部照跑,负例臂已失效。
    const signalFiles = await vscode.workspace.findFiles(
      '{**/*.def,**/entities.xml,**/types.xml,**/alias.xml,**/kbengine*.xml}',
      '**/node_modules/**',
      1
    );
    EVIDENCE.push(`scope-out feature signal files=${JSON.stringify(signalFiles.map(file => file.fsPath))}`);
    assert.strictEqual(signalFiles.length, 0, '负例夹具必须无 KBEngine 特征信号文件');
  });

  it('真 Pylance:探针 import 全部 unresolved(范围界实证)', async function () {
    const diags = await poll(
      () => pylanceDiagnostics(SCOPE_PROBE),
      list => list.some(diag => /reportMissingImports|Import/.test(String(diag.code))),
      240000
    );
    EVIDENCE.push(`scope-out Pylance diagnostics=${JSON.stringify(
      diags.map(diag => ({ code: String(diag.code), message: diag.message.slice(0, 160) }))
    )}`);
    assert.ok(
      diags.some(diag => diag.message.includes('KBEngine')),
      `KBEngine 导入无 unresolved 诊断: ${JSON.stringify(diags.map(d => d.message))}`
    );
    // scope_helper(同级普通模块)= RUST-170 C 阶段同款同目录兜底:kode 零接线时
    // 它是最低位解析来源,应解析到同级文件(run4 实测已如此;断言翻转实录:
    // 首版误按「importer 目录非搜索根」期望空,RUST-170 原裁定是排位序而非
    // 绝对缺席)。KBEngine 与之对照:桩包不在盘+零接线 → 全 unresolved。
    const helperTargets = await definitionTargets(SCOPE_PROBE, 'scope_helper');
    EVIDENCE.push(`scope-out scope_helper def=${JSON.stringify(helperTargets)}`);
    assert.ok(
      helperTargets.some(target => target.endsWith('/app/scope_helper.py')),
      `同目录兜底应解析同级 scope_helper: ${JSON.stringify(helperTargets)}`
    );
  });

  it('范围外布局零写入(分析完成后复核,非激活瞬间快照)', async function () {
    // 时序坑:激活链(桩导出→类型桩→extraPaths 同步)全异步,在 debug.json 标记
    // 出现后**立即**读 settings 会读到同步落盘前的空——旧臂的「零写入」就是这么
    // 假绿的(工作区 dump 实证:settings.json 与 pyrightconfig.json 事后都写了)。
    // 故本臂排在上一臂的 Pylance 分析轮询之后:Pylance 已分析完,激活链早跑完,
    // 此时再读才是真零写入。
    const settings = readSettings();
    EVIDENCE.push(`scope-out post-analysis settings=${JSON.stringify(settings)}`);
    assert.ok(
      settings?.['python.analysis.extraPaths'] === undefined,
      '范围外布局不应写 python.analysis.extraPaths'
    );
    assert.ok(
      settings?.['python.analysis.stubPath'] === undefined,
      '范围外布局不应写 python.analysis.stubPath'
    );
    assert.ok(
      !fs.existsSync(path.join(ROOT!, 'pyrightconfig.json')),
      '范围外布局不应写 pyrightconfig.json'
    );
    const stubRoot = path.join(ROOT!, '.kbengine', 'stubs');
    EVIDENCE.push(`scope-out stubs dir present=${fs.existsSync(stubRoot)}`);
    assert.ok(
      !fs.existsSync(stubRoot),
      '范围外布局不应复制 KBEngine 桩包'
    );
    const kbeTargets = await definitionTargets(SCOPE_PROBE, 'KBEngine');
    EVIDENCE.push(`scope-out post-analysis KBEngine def=${JSON.stringify(kbeTargets)}`);
    assert.strictEqual(kbeTargets.length, 0, '范围外布局 KBEngine 不应有定义落位');
  });
});
