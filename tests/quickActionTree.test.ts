import { describe, expect, it } from 'vitest';
import { QuickActionTreeProvider } from '../src/quickActionTree';

describe('QuickActionTreeProvider', () => {
  it('renders action names with the actual script basename and binds row click to execution', async () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => [{ name: '启动服务', type: 'script', target: 'C:/workspace/scripts/start_server.bat' }]
    });
    const [row] = await provider.getChildren();

    expect(row.label).toBe('启动服务 · start_server.bat');
    expect(row.description).toBe('start_server.bat');
    expect(row.command).toMatchObject({
      command: 'kbengine.quickActions.runByName',
      arguments: ['启动服务']
    });
  });

  it('shows a configuration hint and makes the empty row trigger script scanning', async () => {
    const provider = new QuickActionTreeProvider({ getActions: async () => [] });
    const [row] = await provider.getChildren();

    expect(row.label).toContain('.kbengine/debug.json');
    expect(row.label).toContain('quickActions');
    expect(row.command).toMatchObject({ command: 'kbengine.quickActions.scanScripts' });
  });
});
