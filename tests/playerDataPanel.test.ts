// CLONE-P5 骨架验收:「玩家数据」只读面板(用户令 2026-11-06:零编辑、仅查询)。
//
// 锁定三条硬口径:
// - 密码永不回显:树节点只有掩码/密文标记,断言不含任何明文字样;
// - 只读查询 SQL:dbid 仅十进制正整数,表名前缀经反引号剥离;
// - 派生不可用时如实降级(「未找到数据库配置段」),不虚构连接、不报错。
//
// 用户令 2026-11-09:连接要素一律以**最终合成配置**(resolve dbInterface)为
// 主真源——视图锁 defaults-only 告警(引擎默认值不许装成最终配置)与
// host/密码同源(不再派生 host + resolve 密码异源组合)。

import { describe, beforeEach, expect, it } from 'vitest';

import {
  buildPlayerDataTreeNodes,
  buildPlayerDatabaseView,
  buildPlayerQuerySql,
  playerDatabaseDefaultsOnlyWarning,
  testPlayerDatabaseConnection,
  queryPlayerByDbid,
  type PlayerDatabaseView
} from '../src/playerDataPanel';
import { resetConfigDerivedScanRootForTests } from '../src/configDerive';
import { resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

/** 有效面板视图样例(镜像 buildPlayerDatabaseView 产物形态) */
const view = (overrides: Partial<PlayerDatabaseView> = {}): PlayerDatabaseView => ({
  available: true,
  dbType: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4',
  encrypt: true,
  defaultsOnly: false,
  ...overrides
});

describe('CLONE-P5 玩家数据只读面板(骨架)', () => {
  beforeEach(() => {
    resetConfigDerivedScanRootForTests();
    resetRootConfigGenerationForTests();
    configurationOverrides.clear();
    stubWorkspace.workspaceFolders = [];
  });

  it('无派生档案 → 如实展示「未找到数据库配置段」', () => {
    const nodes = buildPlayerDataTreeNodes(null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toContain('Database config section not found');
    expect(nodes[0].description).toBe('dbmgr/databaseInterfaces/default');
  });

  it('mysql 档案:连接要素齐全,密码只出掩码(永不出明文)', () => {
    const nodes = buildPlayerDataTreeNodes(view());
    const iface = nodes[0];
    expect(iface.label).toContain('mysql');
    expect(iface.description).toBe('127.0.0.1:13306/kbe');
    const children = iface.children ?? [];
    const byLabel = (label: string): string =>
      String(children.find(child => child.label === label)?.description ?? '');
    expect(byLabel('Host')).toBe('127.0.0.1');
    expect(byLabel('Port')).toBe('13306');
    expect(byLabel('Account')).toBe('kbe');
    expect(byLabel('Database')).toBe('kbe');
    // RSA 密文:掩码 + 不解读
    expect(byLabel('Password')).toContain('RSA ciphertext');
    // 硬口径:整树序列化后不出现任何明文密码字段/值
    expect(JSON.stringify(nodes)).not.toMatch(/plainPassword|password":/);
  });

  it('明文可读密码(encrypt=false):掩码「明文可读,仅连接用」——仍不出值', () => {
    const nodes = buildPlayerDataTreeNodes(view({ encrypt: false, plainPassword: 'pw-from-final-config' }));
    const children = nodes[0].children ?? [];
    const password = String(children.find(child => child.label === 'Password')?.description ?? '');
    expect(password).toContain('●●●●●●');
    expect(password).toContain('plaintext');
    expect(password).not.toContain('pw-from-final-config');
  });

  it('redis 类型如实标注(KODE-REDIS-UI-001:连接面支持双后端,不再仅展示)', () => {
    const nodes = buildPlayerDataTreeNodes(view({ dbType: 'redis' }));
    expect(nodes[0].label).toContain('redis');
    // redis 已接入连接/预览面,不再标注「仅展示——连接面仅支持 mysql」
    expect(nodes[0].label).not.toContain('display only');
  });

  it('用户令 2026-11-09:defaults-only 如实标注——描述带「引擎默认」,来源注明缺元件配置', () => {
    const nodes = buildPlayerDataTreeNodes(view({ defaultsOnly: true }));
    const iface = nodes[0];
    expect(iface.description).toBe('127.0.0.1:13306/kbe (engine default)');
    const tooltip = String((iface.tooltip as { value?: string })?.value ?? iface.tooltip ?? '');
    expect(tooltip).toContain('kbengine.xml was not found');
    expect(tooltip).toContain(playerDatabaseDefaultsOnlyWarning().slice(0, 20));
    // 最终配置形态(非 defaults-only)不带告警
    const finalNodes = buildPlayerDataTreeNodes(view({ defaultsOnly: false }));
    expect(finalNodes[0].description).toBe('127.0.0.1:13306/kbe');
    const finalTooltip = String(
      (finalNodes[0].tooltip as { value?: string })?.value ?? finalNodes[0].tooltip ?? ''
    );
    expect(finalTooltip).toContain('final merged config');
    expect(finalTooltip).not.toContain('kbengine.xml was not found');
  });

  it('dbid 查询 SQL:仅十进制正整数;前缀缺省 tbl_,反引号剥除', () => {
    expect(buildPlayerQuerySql('12ab', '')).toBeNull();
    expect(buildPlayerQuerySql('-1', '')).toBeNull();
    expect(buildPlayerQuerySql('0x1f', '')).toBeNull();
    expect(buildPlayerQuerySql(' 42 ', '')).toBe(
      'SELECT * FROM `tbl_Account` WHERE `id` = 42'
    );
    expect(buildPlayerQuerySql('7', 'x_')).toBe('SELECT * FROM `x_Account` WHERE `id` = 7');
    // 前缀内反引号剥除(标识符注入防线)
    expect(buildPlayerQuerySql('7', 'x`_')).toBe('SELECT * FROM `x_Account` WHERE `id` = 7');
  });

  it('派生不可用:连接测试/查询如实降级,不虚构连接', async () => {
    await expect(testPlayerDatabaseConnection()).resolves.toContain('Database config section not found');
    await expect(queryPlayerByDbid('42')).resolves.toContain('Database config section not found');
  });

  it('非法 dbid:查询前即拒绝(仅十进制正整数)', async () => {
    await expect(queryPlayerByDbid('4.2')).resolves.toContain('decimal positive integers');
  });

  it('buildPlayerDatabaseView:双缓存全冷 → null(如实降级,不虚构)', () => {
    expect(buildPlayerDatabaseView()).toBeNull();
  });
});
