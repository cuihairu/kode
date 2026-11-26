/**
 * 真机走查:编辑器内体验面(2026-11-26 两个用户报修的可见行为钉)。
 * (1) ctrl+alt+shift+b/c 键绑定的真命令 kbengine.processOwnership.openCell:
 *     tmp 真落盘 scripts/<role>/interfaces/ 同名对(用户报的子路径丢失场景)
 *     + 对端只剩角色根同名的回落 + 全无对端原地不动,三态全走真命令链。
 * (2) 多 class 文件的 MRO 链 CodeLens(2026-11-26 广播门修复):在册实体
 *     同文件追加无关类,无关类方法必须零链(修前被 def-mixin 广播塞链);
 *     Avatar 自身方法链照常(保真面);全无关文件(movement.py)零链。
 * 全程真注册链:vscode.executeCodeLensProvider / vscode.commands.executeCommand,
 * 不自建 provider 实例——装配(provider 注册/索引/命令路由)本身是被测面。
 * 工作区 = --uxwalk 装配的 demo 资产 tmp 副本(可改写,零仓库污染)。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const DEMO_ROOT = process.env.KODE_DEMO_WORKSPACE;
const MRO_COMMAND = 'kbengine.python.mroChain';
// Avatar.py 0-based 行号锚(改写前原文):onMove 声明在 184 行(grep -n 185,
// ROLE 接口组合根链,真机实测 3 链出镜)。注意 reqAttack(cell 单侧定义,
// <2 定义者)不出镜,不能当锚。改写面在文件头插 1 行注释,原方法全部 +1
// ——「184 无镜且 185 有镜」就是索引吃到新版本的精确信号(旧版本必然把镜留在 184)。
const AVATAR_ONMOVE_BEFORE = 184;
const AVATAR_ONMOVE_AFTER = 185;
const SLEEP_MS = 500;
const WAIT_MS = 60000;

async function mroLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  // execute*Provider 系列要求文本模型已存在(未 open 的磁盘文件直接
  // Illegal argument,1.148 实测):先 openTextDocument 建 model。
  await vscode.workspace.openTextDocument(uri);
  const all = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider', uri);
  return (all ?? []).filter(lens => lens.command?.command === MRO_COMMAND);
}

function chainCount(lens: vscode.CodeLens): number {
  const args = (lens.command as unknown as { arguments?: [unknown[]] } | undefined)?.arguments;
  return Array.isArray(args?.[0]) ? (args![0] as unknown[]).length : -1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('真机走查:编辑器内体验面(openCell 互链 + MRO 链 CodeLens)', function () {
  // 索引轮询与多次真命令链,单用例预算放宽
  this.timeout(120000);

  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.ok(DEMO_ROOT, 'runTest.js --uxwalk must set KODE_DEMO_WORKSPACE');
    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, DEMO_ROOT);
    // 冷启动预热:轮询 Avatar.py(在册实体,def Interfaces ROLE)的 reqAttack
    // 出镜到非空再开测——稳态断言面,不等首扫收敛会把稳态红误报成红。
    const avatar = vscode.Uri.file(path.join(DEMO_ROOT!, 'scripts', 'cell', 'Avatar.py'));
    const deadline = Date.now() + WAIT_MS;
    let last = -1;
    while (Date.now() < deadline) {
      last = (await mroLenses(avatar)).length;
      if (last > 0) { return; }
      await sleep(SLEEP_MS);
    }
    assert.fail(`warmup timed out: Avatar.py never produced MRO lenses (last=${last})`);
  });

  it('openCell: base/interfaces/Hero.py 跳到 cell 镜像子路径(用户原报场景)', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-walk-oc-'));
    for (const role of ['base', 'cell', 'bots']) {
      fs.mkdirSync(path.join(root, 'scripts', role, 'interfaces'), { recursive: true });
    }
    const write = (rel: string): string => {
      const full = path.join(root, rel);
      fs.writeFileSync(full, 'class Hero:\n    pass\n', 'utf8');
      return full;
    };
    const base = write(path.join('scripts', 'base', 'interfaces', 'Hero.py'));
    const cell = write(path.join('scripts', 'cell', 'interfaces', 'Hero.py'));
    write(path.join('scripts', 'bots', 'interfaces', 'Hero.py'));
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(base));
      assert.strictEqual(vscode.window.activeTextEditor?.document.fileName, base, '起点=base 镜像位');
      await vscode.commands.executeCommand('kbengine.processOwnership.openCell');
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.fileName, cell,
        'openCell 应落到 cell/interfaces/Hero.py(子路径不丢)');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('openCell: 对端只有角色根同名也回落照跳', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-walk-fb-'));
    fs.mkdirSync(path.join(root, 'scripts', 'base', 'interfaces'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'cell'), { recursive: true });
    const base = path.join(root, 'scripts', 'base', 'interfaces', 'Activity.py');
    const cell = path.join(root, 'scripts', 'cell', 'Activity.py');
    fs.writeFileSync(base, 'class Activity:\n    pass\n', 'utf8');
    fs.writeFileSync(cell, 'class Activity:\n    pass\n', 'utf8');
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(base));
      await vscode.commands.executeCommand('kbengine.processOwnership.openCell');
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.fileName, cell,
        '无镜像位应回落角色根同名');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('openCell: 全无同名对端,编辑器如实不动', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-walk-no-'));
    fs.mkdirSync(path.join(root, 'scripts', 'base', 'interfaces'), { recursive: true });
    const base = path.join(root, 'scripts', 'base', 'interfaces', 'Nothing.py');
    fs.writeFileSync(base, 'class Nothing:\n    pass\n', 'utf8');
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(base));
      await vscode.commands.executeCommand('kbengine.processOwnership.openCell');
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.fileName, base,
        '无对端应原地不动(诚实不跳)');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('MRO 链 CodeLens: 全无关文件(movement.py)零链', async function () {
    const movement = vscode.Uri.file(
      path.join(DEMO_ROOT!, 'scripts', 'common', 'training', 'mixins', 'movement.py'));
    const lenses = await mroLenses(movement);
    assert.strictEqual(
      lenses.length, 0,
      `无关 mixin 文件不得出 MRO 链 CodeLens(实际 ${lenses.length} 条)`);
  });

  it('MRO 链 CodeLens: 在册实体同文件追加无关类,无关类零链+实体照常出链(修复面)', async function () {
    const avatarPath = path.join(DEMO_ROOT!, 'scripts', 'cell', 'Avatar.py');
    const original = fs.readFileSync(avatarPath, 'utf8');
    // 头插一行注释(原方法行号全部 +1,新版本入索引的精确信号)+ 尾追加
    // 无关类 WalkStrayMixin(用户报的「文件里还有别的 class 也被标记」形状)。
    // tmp 副本工作区,改写零仓库污染,进程退出即随 tmp 删除。
    const originalLines = original.split('\n');
    if (originalLines[originalLines.length - 1] === '') { originalLines.pop(); }
    const shifted = [
      '# uxwalk probe: shift every original line down by one',
      ...originalLines,
      '', '',
      'class WalkStrayMixin:',
      '    def stray(self):',
      '        pass'
    ].join('\n');
    // stray 的 def 行(0-based)= 归一后原行数 L:probe 头两空行在 L+1/L+2,
    // class 行在 L+3,def stray 在 L+4
    const strayDefLine = originalLines.length + 4;
    fs.writeFileSync(avatarPath, shifted);
    const avatar = vscode.Uri.file(avatarPath);
    // 轮询稳态:184 无镜+185 有镜(新版本入索引)+stray 行零镜(修复面)
    const deadline = Date.now() + WAIT_MS;
    let lenses: vscode.CodeLens[] = [];
    let converged = false;
    while (Date.now() < deadline) {
      lenses = await mroLenses(avatar);
      const lines = lenses.map(lens => lens.range.start.line);
      if (lines.includes(AVATAR_ONMOVE_AFTER)
        && !lines.includes(AVATAR_ONMOVE_BEFORE)
        && !lines.includes(strayDefLine)) {
        converged = true;
        break;
      }
      await sleep(SLEEP_MS);
    }
    const dump = lenses
      .map(lens => `  @${lens.range.start.line} ${chainCount(lens)}链 ${lens.command?.title ?? ''}`)
      .join('\n');
    assert.ok(converged,
      `改写后的 Avatar.py 未收敛到稳态\n`
      + `  期望: ${AVATAR_ONMOVE_BEFORE} 无镜 / ${AVATAR_ONMOVE_AFTER} 有镜 / stray@${strayDefLine} 零镜\n`
      + `  实际 MRO 镜:\n${dump || '  (无)'}`);
    // 保真面:实体自身方法链数与标题(用户可见证据)
    const onMove = lenses.find(lens => lens.range.start.line === AVATAR_ONMOVE_AFTER);
    assert.ok(onMove, 'onMove 应有 MRO 链镜');
    const count = chainCount(onMove);
    assert.ok(count > 0, `onMove 链数应 >0,实际 ${count}`);
    console.log(`[uxwalk] Avatar.onMove: ${count} 链「${onMove.command?.title ?? ''}」`);
    console.log(`[uxwalk] WalkStrayMixin.stray@${strayDefLine}: 0 链(修复面成立)`);
    console.log(`[uxwalk] Avatar.py MRO 镜总数: ${lenses.length}`);
  });
});
