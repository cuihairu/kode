import * as assert from 'assert';
import { createRequire } from 'module';

const loadJson = createRequire(__filename);
const manifest = loadJson('../../../package.json');
const nlsDefault: Record<string, string> = loadJson('../../../package.nls.json');
const nlsZhCn: Record<string, string> = loadJson('../../../package.nls.zh-cn.json');

/** 视图分类名在 manifest 里是 %key% 占位,按语言包解析(默认 en / zh-cn 两态) */
const localizedViewNames = (bundle: Record<string, string>): string[] =>
  (manifest.contributes.views['kbengine-explorer'] as Array<{ id: string; name: string }>)
    .map(view => view.name.replace(/^%([^%]+)%$/, (_m, key: string) => bundle[key] ?? key));

describe('Extension manifest', () => {
  it('registers activation events for all contributed commands', () => {
    const activationEvents = new Set<string>(manifest.activationEvents);
    const commands = manifest.contributes.commands.map((item: { command: string }) => item.command);

    for (const command of commands) {
      assert.ok(
        activationEvents.has(`onCommand:${command}`),
        `Missing activation event for command ${command}`
      );
    }
  });

  it('contributes hot-reload snippets for the python language', () => {
    const snippets = manifest.contributes.snippets as Array<{ language: string; path: string }>;

    const pythonSnippet = snippets.find(entry => entry.language === 'python');
    assert.ok(pythonSnippet, 'python snippet contribution missing');
    assert.strictEqual(pythonSnippet.path, './snippets/kbengine-python.json');
  });

  it('keeps def and types.xml snippet contributions intact', () => {
    const snippets = manifest.contributes.snippets as Array<{ language: string; path: string }>;

    assert.ok(snippets.some(entry => entry.language === 'kbengine-def' && entry.path === './snippets/kbengine.json'));
    assert.ok(snippets.some(entry => entry.language === 'xml' && entry.path === './snippets/kbengine-types-xml.json'));
  });

  it('contributes quick actions as an independent view before Entities', () => {
    const views = manifest.contributes.views['kbengine-explorer'] as Array<{ id: string; name: string }>;
    const quickIndex = views.findIndex(view => view.id === 'kbengine.quickActions');
    const entityIndex = views.findIndex(view => view.id === 'kbengine.entityExplorer');
    assert.ok(quickIndex >= 0, 'quick actions view missing');
    assert.ok(entityIndex > quickIndex, 'quick actions should be listed before Entities');
    assert.strictEqual(views[quickIndex].name, '%kbengine.view.quickActions%');

    // 分类标签双语:英文 locale 出英文,中文 locale 出中文(与 vscode.l10n 同一 i18n 面)
    const enNames = localizedViewNames(nlsDefault);
    const zhNames = localizedViewNames(nlsZhCn);
    assert.strictEqual(enNames[quickIndex], 'Quick Actions');
    assert.strictEqual(zhNames[quickIndex], '快速执行');
    assert.deepStrictEqual(Object.keys(nlsZhCn).sort(), Object.keys(nlsDefault).sort());
    assert.ok(zhNames.every((name, index) => name !== enNames[index] || name === 'Telnet'),
      '除 Telnet 外分类标签必须中英有别');

    const viewTitles = manifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    assert.ok(viewTitles.some(entry => entry.command === 'kbengine.quickActions.scanScripts' && entry.when === 'view == kbengine.quickActions'));
    assert.ok(!viewTitles.some(entry => entry.when === 'view == kbengine.entityExplorer' && entry.command.startsWith('kbengine.quickActions.')));
  });
});
