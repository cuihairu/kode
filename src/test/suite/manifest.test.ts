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
});
