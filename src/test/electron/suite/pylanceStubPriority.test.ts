import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// RUST-170:对 Pylance 用真实环境验证 stub 优先级与跳转目标,不凭猜测宣称
// 跳源成功。夹具=KODE_PYLANCE_WORKSPACE(scripts/verify/lsp-stub-priority.mjs
// --emit-fixture 预建的三层同名 KBEngine.pyi:scripts/ 同目录、.kbengine/stubs
// (python.analysis.stubPath)、extraroot(python.analysis.extraPaths),
// Avatar.py 里 `import KBEngine` + `KBEngine.addTimer(1.0)`)。套件逐级物理
// 裁掉上层 stub,轮询 vscode.executeDefinitionProvider 的真实返回直到落位,
// 逐级记录实际 URI 作证据;hover 原文随证据落盘。这是真 VS Code + 真 Pylance
// 扩展进程内跑的。对照车道(pyright,独立 LSP 客户端驱动真进程)见同一脚本
// 默认模式。
// 注:Pylance 读 VS Code 设置(python.analysis.*);pyrightconfig.json 当年按
// 「Pylance 不读」设计双写(本夹具 .vscode/settings.json 与对照车道的
// pyrightconfig.json 内容同一套,两面一致故结果不受影响)。该前提已被
// 2026-11-18 RUST-263 段2 实测推翻(Pylance 实读 kode 写的 pyrightconfig.json
// 搜索根,见 docs/review/2026-11-18-rust-263-pylance-wire-realenv.md);
// kode 自身 stub 同步仍关,避免激活链写设置污染测量面。

const WS = process.env.KODE_PYLANCE_WORKSPACE;
assert.ok(WS, 'runTest.js --pylance must set KODE_PYLANCE_WORKSPACE');

const AVATAR = path.join(WS!, 'scripts/entity/Avatar.py');
const SAME_DIR_PYI = path.join(WS!, 'scripts/KBEngine.pyi');
const STUB_PATH_PYI = path.join(WS!, '.kbengine/stubs/KBEngine.pyi');

/** KBEngine.addTimer 调用点上 addTimer 标识符的位置(ASCII 夹具,列=字符数)。 */
async function callSite(): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  const uri = vscode.Uri.file(AVATAR);
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const at = text.indexOf('KBEngine.addTimer');
  assert.ok(at >= 0, 'fixture call site missing');
  const before = text.slice(0, at);
  const line = before.split('\n').length - 1;
  const character = at - (before.lastIndexOf('\n') + 1) + 'KBEngine.'.length;
  return { uri, position: new vscode.Position(line, character) };
}

async function definitionTargets(): Promise<string[]> {
  const { uri, position } = await callSite();
  const raw = (await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider', uri, position
  )) as vscode.Location[] | vscode.Location | null | undefined;
  const locations = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return locations.map(location => location.uri.fsPath);
}

async function hoverEvidence(): Promise<string> {
  const { uri, position } = await callSite();
  const raw = (await vscode.commands.executeCommand(
    'vscode.executeHoverProvider', uri, position
  )) as vscode.Hover[] | null | undefined;
  const parts: string[] = [];
  for (const hover of raw ?? []) {
    for (const part of hover.contents) {
      parts.push(typeof part === 'string' ? part : (part as vscode.MarkdownString).value);
    }
  }
  return parts.join('\n').slice(0, 400);
}

/**
 * 轮询定义落位直到全部命中 expectedSuffix 或超时;返回最后观测(证据面)。
 * presence 口径:期望落点出现在结果里即算落位(其余 provider 可能追加
 * 各自面的结果,如实记录不裁掉)。
 */
async function pollUntil(expectedSuffix: string, timeoutMs: number): Promise<{ paths: string[]; reached: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    try {
      last = await definitionTargets();
      if (last.length > 0 && last.every(target => target.endsWith(expectedSuffix))) {
        return { paths: last, reached: true };
      }
    } catch {
      // provider 尚未就绪(编辑器/语言服务器启动期),继续轮询
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return { paths: last, reached: false };
}

describe('RUST-170 Pylance 真机 stub 优先级(逐级裁层)', function () {
  // 三阶段 × 180s 轮询上限 + 宿主/Pylance 启动期,给足 15 分钟
  this.timeout(900000);

  let evidence: string[] = [];

  before(async () => {
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.ok(pylance, 'Pylance 扩展未随宿主加载(检查 .vscode-test/extensions)');
    await pylance.activate();
    evidence = [];
    // 打开一次让 Pylance 开始分析(didOpen 随 openTextDocument 发出)
    await vscode.workspace.openTextDocument(vscode.Uri.file(AVATAR));
  });

  afterEach(function () {
    // 每级证据即打即留:失败时 mocha 输出里也有完整落位轨迹
    for (const line of evidence.splice(0)) {
      console.log(`[rust-170-pylance] ${line}`);
    }
  });

  it('实测阶梯:stubPath 胜三层 → 裁 stubPath 回退 extraPaths → 只剩同目录时同目录兜底', async () => {
    // 期望按真机实测(两服务器同裁定):绝对 import 解析序=stubPath >
    // extraPaths > 同目录 .pyi,importer 目录不是绝对 import 的搜索根。
    assert.ok(fs.existsSync(SAME_DIR_PYI), '夹具缺同目录 stub(先跑 emit-fixture)');
    assert.ok(fs.existsSync(STUB_PATH_PYI), '夹具缺 stubPath stub');

    // 阶段 A:三层并存,期望=stubPath(实测第一级,同目录不参与)
    const stageA = await pollUntil('/.kbengine/stubs/KBEngine.pyi', 180000);
    evidence.push(`A tiers=all reached=${stageA.reached} targets=${JSON.stringify(stageA.paths)}`);
    evidence.push(`A hover=${JSON.stringify(await hoverEvidence())}`);
    assert.ok(stageA.reached, `A:stubPath .pyi 未落位,实际=${JSON.stringify(stageA.paths)}`);

    // 阶段 B:物理删 stubPath stub(同目录仍在盘)→ 期望=extraPaths
    // (同目录在场也不参战,与 pyright 车道 D 变体同裁定)
    fs.rmSync(STUB_PATH_PYI);
    const stageB = await pollUntil('/extraroot/KBEngine.pyi', 180000);
    evidence.push(`B tiers=-stubPath reached=${stageB.reached} targets=${JSON.stringify(stageB.paths)}`);
    assert.ok(stageB.reached, `B:extraPaths .pyi 未落位,实际=${JSON.stringify(stageB.paths)}`);

    // 阶段 C:再删 extraPaths stub,只剩同目录 → 期望=同目录 .pyi
    // (证明同目录仍是一条真实解析来源,只是排位最低)
    fs.rmSync(path.join(WS!, 'extraroot/KBEngine.pyi'));
    const stageC = await pollUntil('/scripts/KBEngine.pyi', 180000);
    evidence.push(`C tiers=-extraPaths reached=${stageC.reached} targets=${JSON.stringify(stageC.paths)}`);
    evidence.push(`C hover=${JSON.stringify(await hoverEvidence())}`);
    assert.ok(stageC.reached, `C:同目录 .pyi 未落位,实际=${JSON.stringify(stageC.paths)}`);
  });
});
