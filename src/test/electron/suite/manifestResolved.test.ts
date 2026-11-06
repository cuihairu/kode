import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// KODE-I18N-001/003:VS Code 真实 %key% 解析路径(本 suite 在真机 VS Code 扩展宿主里跑)。
// vscode.extensions.getExtension(...).packageJSON 返回的是 NLS 解析后的 manifest;
// vitest 层的 manifestI18n.test.ts 只能建模回退语义,本层补两条实际路径:
// ①(--manifestnls)默认 locale:解析产物无裸 %key% 残留;
// ②(--manifestfallback)runner 先把扩展复制到临时目录并删掉 zh-cn 包的
//   kbengine.command.refreshExplorer.title 键,再以 --locale=zh-cn 拉起:
//   被删键解析=默认包文案(回落),未删键对照=zh-cn 文案(locale 生效证明)。

const UNRESOLVED = /%[a-zA-Z0-9._-]+%/;
const VICTIM_COMMAND = 'kbengine.refreshExplorer';
const VICTIM_KEY = 'kbengine.command.refreshExplorer.title';
const CONTROL_KEY = 'kbengine.view.quickActions';

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
    // 双段启动的第一段只注册语言包,locale 尚未生效;跳过留给第二段断言
    if (vscode.env.language !== 'zh-cn') {
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
});
