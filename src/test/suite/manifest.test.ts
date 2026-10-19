import * as assert from 'assert';
import { createRequire } from 'module';

const manifest = createRequire(__filename)('../../../package.json');

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
    assert.strictEqual(views[quickIndex].name, '快速执行');

    const viewTitles = manifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    assert.ok(viewTitles.some(entry => entry.command === 'kbengine.quickActions.scanScripts' && entry.when === 'view == kbengine.quickActions'));
    assert.ok(!viewTitles.some(entry => entry.when === 'view == kbengine.entityExplorer' && entry.command.startsWith('kbengine.quickActions.')));
  });
});
