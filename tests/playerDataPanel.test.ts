// CLONE-P5 骨架验收:「玩家数据」只读面板(用户令 2026-11-06:零编辑、仅查询)。
//
// 锁定三条硬口径:
// - 密码永不回显:树节点只有掩码/密文标记,断言不含任何明文字样;
// - 只读查询 SQL:dbid 仅十进制正整数,表名前缀经反引号剥离;
// - 派生不可用时如实降级(「未找到数据库配置段」),不虚构连接、不报错。

import { describe, beforeEach, expect, it } from 'vitest';

import {
  buildPlayerDataTreeNodes,
  buildPlayerQuerySql,
  testPlayerDatabaseConnection,
  queryPlayerByDbid
} from '../src/playerDataPanel';
import { resetConfigDerivedScanRootForTests } from '../src/configDerive';
import { resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

/** 有效派生档案样例(镜像 Rust derive_database 输出形态) */
const profile = (overrides: Partial<Parameters<typeof buildPlayerDataTreeNodes>[0]> = {}) => ({
  available: true,
  dbType: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4',
  encrypt: true,
  passwordAvailable: false,
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
    expect(nodes[0].label).toContain('未找到数据库配置段');
    expect(nodes[0].description).toBe('dbmgr/databaseInterfaces/default');
  });

  it('mysql 档案:连接要素齐全,密码只出掩码(永不出明文)', () => {
    const nodes = buildPlayerDataTreeNodes(profile());
    const iface = nodes[0];
    expect(iface.label).toContain('mysql');
    expect(iface.description).toBe('127.0.0.1:13306/kbe');
    const children = iface.children ?? [];
    const byLabel = (label: string): string =>
      String(children.find(child => child.label === label)?.description ?? '');
    expect(byLabel('主机')).toBe('127.0.0.1');
    expect(byLabel('端口')).toBe('13306');
    expect(byLabel('账号')).toBe('kbe');
    expect(byLabel('数据库')).toBe('kbe');
    // RSA 密文:掩码 + 不解读
    expect(byLabel('密码')).toContain('RSA 密文');
    // 硬口径:整树序列化后不出现任何明文密码字段/值
    expect(JSON.stringify(nodes)).not.toMatch(/plainPassword|password":/);
  });

  it('明文可读密码(encrypt=false):掩码「明文可读,仅连接用」——仍不出值', () => {
    const nodes = buildPlayerDataTreeNodes(profile({ encrypt: false, passwordAvailable: true }));
    const children = nodes[0].children ?? [];
    const password = String(children.find(child => child.label === '密码')?.description ?? '');
    expect(password).toContain('●●●●●●');
    expect(password).toContain('明文可读');
  });

  it('redis 类型如实标注「仅展示——连接面仅支持 mysql」', () => {
    const nodes = buildPlayerDataTreeNodes(profile({ dbType: 'redis' }));
    expect(nodes[0].label).toContain('redis');
    expect(nodes[0].label).toContain('仅展示');
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
    await expect(testPlayerDatabaseConnection()).resolves.toContain('未找到数据库配置段');
    await expect(queryPlayerByDbid('42')).resolves.toContain('未找到数据库配置段');
  });

  it('非法 dbid:查询前即拒绝(仅十进制正整数)', async () => {
    await expect(queryPlayerByDbid('4.2')).resolves.toContain('十进制正整数');
  });
});
