import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// KODE-I18N-001/003 + UX-REVIEW-010f:VS Code 真实 %key% 解析路径(本 suite 在真机
// VS Code 扩展宿主里跑)。vscode.extensions.getExtension(...).packageJSON 返回的是
// NLS 解析后的 manifest;vitest 层的 manifestI18n.test.ts 只能建模回退语义,本层补
// 三条实际路径:
// ①(--manifestnls)默认 locale:解析产物无裸 %key% 残留;
// ②(--manifestfallback)runner 先把扩展复制到临时目录并删掉 zh-cn 包的
//   kbengine.command.refreshExplorer.title 键,再以 --locale=zh-cn 拉起:
//   被删键解析=默认包文案(回落),未删键对照=zh-cn 文案(locale 生效证明);
// ③(--bundlefallback)运行时 bundle(vscode.l10n)同款:临时副本连 l10n/ 一起
//   复制并删掉 zh-cn 运行时 bundle 的一个键,以 --locale=zh-cn 拉起后执行被测
//   扩展自注册的 kbengine.l10nProbe(回调在被测扩展上下文里取词):被删键=
//   英文源串(回落),未删键对照=zh-cn 文案(locale 生效证明)。

const UNRESOLVED = /%[a-zA-Z0-9._-]+%/;
const VICTIM_COMMAND = 'kbengine.refreshExplorer';
const VICTIM_KEY = 'kbengine.command.refreshExplorer.title';
const CONTROL_KEY = 'kbengine.view.quickActions';
// ③ 的运行时 bundle 受害/对照键(工作台选择器占位 + 动作项文案,与 runTest.ts
// --bundlefallback 删除的键一致;取词经被测扩展的 kbengine.l10nProbe 探针命令)
const L10N_VICTIM_KEY = 'Choose a KBEngine task';
const L10N_CONTROL_KEY = 'Find project files';

const collectUnresolved = (node: unknown, pathStr: string, out: string[]): void => {
  if (typeof node === 'string') {
    if (UNRESOLVED.test(node)) {
      out.push(`${pathStr}=${node}`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectUnresolved(value, `${pathStr}[${index}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectUnresolved(value, `${pathStr}.${key}`, out);
    }
  }
};

const loadExtensionPackageJson = (): Record<string, unknown> => {
  const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
  assert.ok(extension, 'extension under test not found in host');
  return extension.packageJSON as Record<string, unknown>;
};

describe('resolved manifest (VS Code actual %key% resolution)', () => {
  it('resolves every nls placeholder via the default bundle — no raw %key% leaks', () => {
    const pkg = loadExtensionPackageJson();
    const out: string[] = [];
    collectUnresolved(pkg['displayName'], 'displayName', out);
    collectUnresolved(pkg['description'], 'description', out);
    collectUnresolved(pkg['contributes'], 'contributes', out);
    // --manifestfallback 的临时副本删了 zh-cn 的 VICTIM_KEY,回落语义下解析
    // 产物应无任何裸 token(该键出默认包文案);抓到残留=回落语义证伪
    assert.deepStrictEqual(out, []);
  });

  it('missing zh-cn key falls back to the default bundle text (real host, --locale=zh-cn)', function () {
    const fallbackTemp = process.env.KODE_MANIFEST_FALLBACK_TEMP;
    if (!fallbackTemp) {
      this.skip();
      return;
    }
    // 双段启动的第一段只注册语言包,locale 尚未生效:register 段跳过;
    // verify 段 runner 已要求 zh-cn 必须生效,未生效 = 直接红(不是 skip),
    // 防「两段都 skip 也全绿」的假阳性门
    if (vscode.env.language !== 'zh-cn') {
      if (process.env.KODE_MANIFEST_LAUNCH === 'verify') {
        assert.fail(
          `verify launch requires an active zh-cn locale, got vscode.env.language=${vscode.env.language}`
        );
      }
      this.skip();
      return;
    }
    const nlsDefault = JSON.parse(
      fs.readFileSync(path.join(fallbackTemp, 'package.nls.json'), 'utf8')
    ) as Record<string, string>;
    const zhBundle = JSON.parse(
      fs.readFileSync(path.join(fallbackTemp, 'package.nls.zh-cn.json'), 'utf8')
    ) as Record<string, string>;
    const pkg = loadExtensionPackageJson();

    // 被删键:解析结果逐字等于默认包文案(不是裸 key、不是 undefined)
    const commands = (pkg['contributes'] as { commands: Array<{ command: string; title: string }> }).commands;
    const victim = commands.find(cmd => cmd.command === VICTIM_COMMAND);
    assert.ok(victim, 'victim command missing from resolved manifest');
    assert.strictEqual(victim.title, nlsDefault[VICTIM_KEY]);

    // 对照键(未删):解析结果=zh-cn 文案,证明本宿主 locale 真是 zh-cn,
    // 上面的回落不是「locale 没生效所以走了默认包」的假阳性
    const views = (pkg['contributes'] as { views: Record<string, Array<{ id: string; name: string }>> }).views;
    const quickActions = Object.values(views).flat().find(view => view.id === 'kbengine.quickActions');
    assert.ok(quickActions, 'control view missing from resolved manifest');
    assert.strictEqual(quickActions.name, zhBundle[CONTROL_KEY]);
    assert.notStrictEqual(nlsDefault[CONTROL_KEY], zhBundle[CONTROL_KEY], 'control pair must be a real en/zh contrast');
  });

  it('runtime bundle: deleted zh-cn key falls back to the English source string (real host, --locale=zh-cn)', async function () {
    const fallbackTemp = process.env.KODE_BUNDLE_FALLBACK_TEMP;
    if (!fallbackTemp) {
      this.skip();
      return;
    }
    // 与 ② 同款防假阳性门:register 段跳过;verify 段 locale 未生效直接红
    if (vscode.env.language !== 'zh-cn') {
      if (process.env.KODE_BUNDLE_LAUNCH === 'verify') {
        assert.fail(
          `verify launch requires an active zh-cn locale, got vscode.env.language=${vscode.env.language}`
        );
      }
      this.skip();
      return;
    }
    const enBundle = JSON.parse(
      fs.readFileSync(path.join(fallbackTemp, 'l10n', 'bundle.l10n.json'), 'utf8')
    ) as Record<string, string>;
    const zhBundle = JSON.parse(
      fs.readFileSync(path.join(fallbackTemp, 'l10n', 'bundle.l10n.zh-cn.json'), 'utf8')
    ) as Record<string, string>;
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'extension under test not found in host');
    // 断言面 = 被测扩展自己注册的探针命令:回调在被测扩展上下文里跑,
    // l10nText 走真机产品同一条取词路径(vscode.l10n 按扩展根 l10n/ 声明
    // 加载本副本的 bundle——副本已删受害键)。加载的确实是删键副本。
    assert.strictEqual(extension.extensionPath, fallbackTemp);
    await extension.activate();
    // 受害键(已删):回落英文源串——不是 zh 译文、不是 undefined、不是空串
    const victim = (await vscode.commands.executeCommand('kbengine.l10nProbe', L10N_VICTIM_KEY)) as unknown;
    assert.strictEqual(victim, enBundle[L10N_VICTIM_KEY]);
    // 对照键(未删):zh-cn 文案,证明本宿主 locale 真是 zh-cn,
    // 上面的回落不是「locale 没生效所以走了源串」的假阳性
    const control = (await vscode.commands.executeCommand('kbengine.l10nProbe', L10N_CONTROL_KEY)) as unknown;
    assert.strictEqual(control, zhBundle[L10N_CONTROL_KEY]);
    assert.notStrictEqual(enBundle[L10N_CONTROL_KEY], zhBundle[L10N_CONTROL_KEY], 'control pair must be a real en/zh contrast');
  });
});
