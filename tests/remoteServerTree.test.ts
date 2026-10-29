import { describe, expect, it } from 'vitest';
import {
  LOCAL_SERVER_ID,
  RemoteServerTreeItem,
  RemoteServerTreeProvider,
  buildRemoteServerNodes
} from '../src/remoteServerTree';

// IDE-PDBG-004 远程服务器视图:节点组序(本地恒首+默认选中、config 项
// 别名序、手动项随后、与 config 同名的手动项不重复)、树 provider 取数
// 面与刷新、节点点击命令接 select。

describe('buildRemoteServerNodes', () => {
  const hosts = [
    { host: 'zeta', hostname: '10.0.0.9' },
    { host: 'alpha', proxyJump: 'bastion' }
  ];

  it('本地恒第一且默认选中;config 项别名序;选中项标 ✓', () => {
    const nodes = buildRemoteServerNodes({ hosts }, [], '');
    expect(nodes.map(node => node.id)).toEqual([LOCAL_SERVER_ID, 'alpha', 'zeta']);
    expect(nodes[0].kind).toBe('local');
    expect(nodes[0].selected).toBe(true); // 未选任何 = 本地
    const picked = buildRemoteServerNodes({ hosts }, [], 'zeta');
    expect(picked.map(node => node.selected)).toEqual([false, false, true]);
  });

  it('手动项随后;与 config 同名的手动项不重复列', () => {
    const nodes = buildRemoteServerNodes({ hosts }, ['manual-host', 'zeta'], 'manual-host');
    expect(nodes.map(node => node.id)).toEqual([LOCAL_SERVER_ID, 'alpha', 'zeta', 'manual-host']);
    expect(nodes.find(node => node.id === 'manual-host')?.kind).toBe('manual');
    expect(nodes.find(node => node.id === 'manual-host')?.selected).toBe(true);
    expect(nodes.filter(node => node.id === 'zeta')).toHaveLength(1); // config 里的优先
  });

  it('快照未就绪(null):只剩本地+手动项,不空转', () => {
    const nodes = buildRemoteServerNodes({ hosts: [] }, ['manual'], LOCAL_SERVER_ID);
    expect(nodes.map(node => node.id)).toEqual([LOCAL_SERVER_ID, 'manual']);
  });
});

describe('RemoteServerTreeProvider', () => {
  it('getChildren 走注入取数面;refresh 触发变更事件', () => {
    let selected = LOCAL_SERVER_ID;
    const provider = new RemoteServerTreeProvider({
      getSnapshot: () => ({ hosts: [{ host: 'gamesrv' }], configPath: '/home/u/.ssh/config', configExists: true }),
      getManualHosts: () => ['manual-host'],
      getSelected: () => selected
    });
    let events = 0;
    provider.onDidChangeTreeData(() => {
      events += 1;
    });
    const items = provider.getChildren();
    expect(items.map(item => item.label)).toEqual(['本地(直接执行)', 'gamesrv', 'manual-host']);
    expect(items[0].description).toContain('✓ 已选');

    selected = 'gamesrv';
    provider.refresh();
    expect(events).toBe(1);
    const refreshed = provider.getChildren();
    expect(refreshed[1].description).toContain('✓ 已选');
    // 节点点击接 select 命令,带节点 id
    expect(refreshed[1].command?.command).toBe('kbengine.remoteServers.select');
    expect(refreshed[1].command?.arguments).toEqual(['gamesrv']);
  });

  it('树项面:config 项描述带跳板,手动项 contextValue 供右键移除', () => {
    const configItem = new RemoteServerTreeItem({
      id: 'alpha',
      kind: 'ssh-config',
      entry: { host: 'alpha', hostname: '10.1.1.1', proxyJump: 'bastion' },
      selected: false
    });
    expect(configItem.contextValue).toBe('remote-server-ssh-config');
    expect(configItem.description).toContain('跳板 bastion');
    expect(configItem.tooltip).toContain('ProxyJump bastion');

    const manualItem = new RemoteServerTreeItem({
      id: 'manual-host',
      kind: 'manual',
      entry: { host: 'manual-host' },
      selected: false
    });
    expect(manualItem.contextValue).toBe('remote-server-manual');
    expect(manualItem.tooltip).toContain('手动添加项');
  });
});
