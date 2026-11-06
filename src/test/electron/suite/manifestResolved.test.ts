import * as assert from 'assert';
import * as vscode from 'vscode';

// KODE-I18N-001:VS Code 真实 %key% 解析路径(本 suite 在真机 VS Code 扩展宿主里跑,
// 默认 locale → 默认包 package.nls.json)。vscode.extensions.getExtension(...).packageJSON
// 返回的是 NLS 解析后的 manifest;语言包缺键时裸 %key% token 会原样残留。
// vitest 层的 manifestI18n.test.ts 只能建模回退语义,本层补「实际解析产物无残留」。

const UNRESOLVED = /%[a-zA-Z0-9._-]+%/;

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

describe('resolved manifest (VS Code actual %key% resolution)', () => {
  it('resolves every nls placeholder via the default bundle — no raw %key% leaks', () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'extension under test not found in host');

    const pkg = extension.packageJSON as Record<string, unknown>;
    const out: string[] = [];
    collectUnresolved(pkg['displayName'], 'displayName', out);
    collectUnresolved(pkg['description'], 'description', out);
    collectUnresolved(pkg['contributes'], 'contributes', out);
    assert.deepStrictEqual(out, []);
  });
});
