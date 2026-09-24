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
});
