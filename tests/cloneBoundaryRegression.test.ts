// UX-REVIEW-004e 回归源锁:玩家数据/克隆边界矩阵的证据钉。矩阵逐格归属
// (既有测试,本文件不重复其行为断言):
//   纯 TS 无 Rust 后端 → playerDataCloneRust.test.ts(五面 no-gate 如实)
//   缺连接 → cloneCommandsCoverage.test.ts(未配置 Source/Target 警告指引)
//     + playerCloneExportPreflight.test.ts(选择实体/DBID 前检查可恢复)
//   连接失败 → cloneCommandsCoverage.test.ts(建连失败/测试查询失败如实)
//     + playerDataCloneImportCommand.test.ts(探测会话失败=导入未开始)
//   无实体 → cloneCommandsCoverage.test.ts(导出:工作区无实体警告;
//     导入:def 推导不可用如实报错)
//   取消 → cloneCommandsCoverage.test.ts(早期取消/两次确认取消/Apply 期
//     取消回滚)+ playerDataClone.test.ts(取消中断只读执行)
//   预演与执行结果区分 → cloneCommandsCoverage.test.ts(预览→双确认→Apply;
//     COMMIT 不确定=「导入结果不确定」不引导重试)
//   线上只读边界 → databaseDrift.test.ts(语句白名单+READ ONLY 会话)
//     + playerDataPanelCoverage.test.ts(SELECT 1 只读探测/SQL 白名单形态)
//   本地/测试写入边界 → cloneCommandsCoverage.test.ts(Target 非 local/test
//     环境闸拒绝)+ playerDataCloneRust.test.ts(Rust 侧 fail-closed 复核)
// 本文件钉 004e 特有的一条:查询面纯 TS 结构锁——面板查询链
// (playerDataPanel.ts → backend/databaseDrift)零 Rust 桥依赖,Rust
// 不可用时查询面功能完整(无 gate 分支,不降级不虚构)。

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const panel = readFileSync(join(root, 'src/playerDataPanel.ts'), 'utf8');
const drift = readFileSync(join(root, 'src/backend/databaseDrift.ts'), 'utf8');

describe('UX-REVIEW-004e 查询面纯 TS 结构锁', () => {
  it('playerDataPanel.ts 零 Rust 桥依赖(不 import playerDataCloneRust/kodeCoreClient)', () => {
    expect(panel.includes('backend/playerDataCloneRust')).toBe(false);
    expect(panel.includes('kodeCoreClient')).toBe(false);
    expect(panel.includes('no-gate')).toBe(false);
  });

  it('查询链走只读白名单执行器:import databaseDrift 且创建 executor(连接测试+查询两处)', () => {
    expect(panel.includes("from './backend/databaseDrift'")).toBe(true);
    expect(panel.match(/createMysqlDriftExecutor\(/g)?.length).toBe(2);
    expect(drift.includes("READ_ONLY_LEADING_KEYWORDS = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN']")).toBe(true);
  });

  it('查询与连接测试入口在案(queryPlayerByDbid/testPlayerDatabaseConnection),白名单 SQL 构造单一出口', () => {
    expect(panel.includes('export async function queryPlayerByDbid')).toBe(true);
    expect(panel.includes('export async function testPlayerDatabaseConnection')).toBe(true);
    expect(panel.includes('export function buildPlayerQuerySql')).toBe(true);
  });
});
