import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildScenarioPath } from '../src/backend/flowScenarioPath';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import type { FlowCallResolverResult } from '../src/backend/flowCallResolver';

// FLOW-021(旧 KFLOW-UI-08)真实业务流转验收:登录 / 创建角色入场 / 一次
// 战斗 RPC 三个场景全部取自 tests/fixtures/kbengine-demo-assets 真实项目
// 资产(scripts/{base,cell,client}/*.py + entity_defs/*.def)。def 注册表在
// 运行时从真实 .def 推导(沿 <Parent> 链),实现注册表沿父链扫真实脚本(缺
// 位=如实 null),行号一律运行时推导——不手写行号、不冒充真实项目覆盖。
//
// 验收面口径(每条都与解析层语义对齐,不是随便断):
//   - S1 登录:基座 self.client.onLoginOK 全链三步(local→send→remote-exec);
//   - S2 入场:reqCreateAvatar 走查如实停在引擎边界(createEntityLocally/
//     giveClientTo 是引擎 API,不是静态 RPC 边——不虚构远端执行帧);
//     入场续 onEnterSpace→reqRadarPing 本地可达,基座中继经 getattr 局部
//     变量接收者不可静态证明(如实 unknown-receiver,无发送步);
//     雷达中继基座腿 onRadarPush→client.onMonsterNear 发送面连接,但客户端
//     实现缺口(client/Avatar.py 无 onMonsterNear)如实不虚构执行帧;
//   - S3 战斗:cell 侧本地结算帧可达(覆写 onDamaged);两条跨进程腿如实
//     未连——超类调用 Avatar.receiveDamage(跨文件导入类)与击杀奖励
//     killer.base.cellAddExperience(entities.get 引擎引用,落点不可静态
//     绑定,FLOW-007 口径)各带 unknown-receiver;战斗结算的基座腿
//     cellAddExperience→client.onLevelUp 全链三步(含 def 父链:Monster 的
//     cellAddExperience 经 <Parent> Avatar 落 Avatar.def)。

const ASSETS = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const SCRIPTS = path.join(ASSETS, 'scripts');

type Section = 'BaseMethods' | 'CellMethods' | 'ClientMethods';
const SECTION_TO_FACE: Record<Section, string> = {
  BaseMethods: 'base',
  CellMethods: 'cell',
  ClientMethods: 'client'
};

const defFileOf = (entity: string): string =>
  path.join(SCRIPTS, 'entity_defs', `${entity}.def`);
const scriptPath = (face: string, entity: string): string =>
  path.join(SCRIPTS, face, `${entity}.py`);

const textCache = new Map<string, string>();
const readDef = (entity: string): string => {
  const key = `def/${entity}`;
  if (!textCache.has(key)) {
    textCache.set(key, readFileSync(defFileOf(entity), 'utf8'));
  }
  return textCache.get(key) ?? '';
};
const readScript = (face: string, entity: string): string => {
  const key = `${face}/${entity}`;
  if (!textCache.has(key)) {
    textCache.set(key, readFileSync(scriptPath(face, entity), 'utf8'));
  }
  return textCache.get(key) ?? '';
};

/** 源行运行时定位(解析层 callSite.line 同为 0 基,直接对表) */
const lineOf = (face: string, entity: string, needle: string): number => {
  const index = readScript(face, entity).split('\n').findIndex(line => line.includes(needle));
  expect(index, `fixture ${face}/${entity}.py must contain: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

/** def <Parent> 链(Monster→Avatar);无 Parent=空 */
const parentOf = (entity: string): string | null =>
  readDef(entity).match(/<Parent>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/Parent>/)?.[1] ?? null;
const defChain = (entity: string): string[] => {
  const chain = [entity];
  let cursor = entity;
  while (parentOf(cursor)) {
    cursor = parentOf(cursor) as string;
    chain.push(cursor);
  }
  return chain;
};

/** 运行时推导 def 注册表:实体+段+方法 → def 声明位置(真实行号) */
const resolveDefMethod = (
  entity: string,
  section: Section,
  methodName: string
): { defFile: string; line: number } | null => {
  for (const owner of defChain(entity)) {
    const text = readDef(owner);
    const sectionMatch = text.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`));
    if (!sectionMatch) {
      continue;
    }
    const methodMatch = sectionMatch[1].match(new RegExp(`<${methodName}>`));
    if (!methodMatch || methodMatch.index === undefined) {
      continue;
    }
    const sectionStart = text.indexOf(sectionMatch[0]);
    const line =
      text.slice(0, sectionStart).split('\n').length +
      sectionMatch[1].slice(0, methodMatch.index).split('\n').length -
      1;
    return { defFile: defFileOf(owner), line };
  }
  return null;
};

/** 运行时推导实现注册表:沿父链扫真实脚本(缺位=如实 null) */
const resolveImplementation = (
  entity: string,
  section: Section,
  methodName: string
): {
  filePath: string;
  line: number;
  signature: string;
  className: string;
  inheritedFrom: string | null;
} | null => {
  const face = SECTION_TO_FACE[section];
  const chain = defChain(entity);
  for (let depth = 0; depth < chain.length; depth += 1) {
    const owner = chain[depth];
    let lines: string[];
    try {
      lines = readScript(face, owner).split('\n');
    } catch {
      continue; // 该面无此实体脚本(Monster 无 base 面):如实降级
    }
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^[ \t]*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (match && match[1] === methodName) {
        return {
          filePath: scriptPath(face, owner),
          line: i + 1,
          signature: lines[i].trim(),
          className: owner,
          inheritedFrom: depth === 0 ? null : owner
        };
      }
    }
  }
  return null;
};

const WALK_FILES = [
  scriptPath('base', 'Account'),
  scriptPath('base', 'Avatar'),
  scriptPath('cell', 'Avatar'),
  scriptPath('cell', 'Monster'),
  scriptPath('client', 'Account'),
  scriptPath('client', 'Avatar')
];

const graphCache = new Map<string, FlowCallResolverResult | null>();
const resolveFile = (face: string, entity: string): FlowCallResolverResult | null => {
  const filePath = scriptPath(face, entity);
  if (!graphCache.has(filePath)) {
    graphCache.set(
      filePath,
      resolveFlowCallSites({ text: readScript(face, entity), filePath, rootKey: 'demo' })
    );
  }
  return graphCache.get(filePath) ?? null;
};

const edgesFrom = (face: string, entity: string, fn: string) =>
  resolveFile(face, entity)?.edges.filter(edge => edge.fromNodeId.includes(`#${fn}`)) ?? [];

const walk = (face: string, entity: string, fn: string) =>
  buildScenarioPath({
    rootKey: 'demo',
    entry: { filePath: scriptPath(face, entity), functionName: fn },
    files: WALK_FILES,
    resolveFile: filePath => {
      const pair = WALK_FILES.find(candidate => candidate === filePath);
      if (!pair) {
        return null;
      }
      const faceOf = pair.split(`${path.sep}scripts${path.sep}`)[1]?.split(path.sep)[0] ?? '';
      const entityOf = pair.split(path.sep).pop()?.replace(/\.py$/, '') ?? '';
      return resolveFile(faceOf, entityOf);
    },
    resolveDefMethod,
    resolveImplementation
  });

describe('FLOW-021 真实业务流转(登录/入场/战斗,全部真实项目资产)', () => {
  it('S1 登录:onClientEnabled → client.onLoginOK 全链(基座→客户端三步)', () => {
    const result = walk('base', 'Account', 'onClientEnabled');
    expect(result.steps.map(step => step.kind)).toEqual([
      'local-frame',
      'cross-process-send',
      'remote-exec'
    ]);
    expect(result.steps.map(step => step.role)).toEqual(['base', 'client', 'client']);
    expect(result.steps.map(step => step.depth)).toEqual([0, 0, 1]);
    expect(result.steps[0].label).toContain('Account.onClientEnabled');
    expect(result.steps[1].label).toContain('onLoginOK');
    expect(result.steps[2].label).toContain('Account.onLoginOK');
    // 远端执行步经同一条发送边悬挂(两段连接的 via 面一致)
    expect(result.steps[2].viaSendEdgeId).toBe(result.steps[1].viaSendEdgeId);
    expect(result.steps[2].viaSendEdgeId).not.toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('S2 入场:reqCreateAvatar 走查如实停在引擎边界(createEntityLocally/giveClientTo 非静态 RPC)', () => {
    const result = walk('base', 'Account', 'reqCreateAvatar');
    expect(result.steps.map(step => step.kind)).toEqual(['local-frame']);
    expect(result.steps[0].role).toBe('base');
    expect(result.steps[0].label).toContain('Account.reqCreateAvatar');
    expect(result.truncated).toBe(false);
    // 解析面不虚构:该帧没有任何 async-send 边(引擎驱动的建实体/交接不走静态边)
    const frameEdges = edgesFrom('base', 'Account', 'reqCreateAvatar');
    expect(frameEdges.length).toBeGreaterThan(0);
    expect(frameEdges.every(edge => edge.syncAsync !== 'async-send')).toBe(true);
    // 建实体与交接各留诚实未解析痕迹(引擎 API / 类外声明)
    expect(frameEdges.some(edge => edge.unresolvedReason?.code === 'native-function')).toBe(true);
    expect(frameEdges.some(edge => edge.unresolvedReason?.code === 'missing-declaration')).toBe(true);
  });

  it('S2 入场续:onEnterSpace → reqRadarPing 本地可达;getattr 基座中继不可静态证明', () => {
    const result = walk('cell', 'Avatar', 'onEnterSpace');
    expect(result.steps.map(step => step.kind)).toEqual(['local-frame', 'local-frame']);
    expect(result.steps.map(step => step.role)).toEqual(['cell', 'cell']);
    expect(result.steps.map(step => step.depth)).toEqual([0, 1]);
    expect(result.steps[0].label).toContain('Avatar.onEnterSpace');
    expect(result.steps[1].label).toContain('reqRadarPing');
    // 基座中继经局部变量(base = getattr(self, 'base', None))接收者不可证:
    // 无发送步、无 remote-exec;解析面留 unknown-receiver 诚实痕迹
    const radarEdges = edgesFrom('cell', 'Avatar', 'reqRadarPing');
    expect(radarEdges.every(edge => edge.syncAsync !== 'async-send')).toBe(true);
    expect(radarEdges.some(edge => edge.unresolvedReason?.code === 'unknown-receiver')).toBe(true);
  });

  it('S2 雷达中继基座腿:onRadarPush → client.onMonsterNear 发送面连接;客户端实现缺口如实', () => {
    const result = walk('base', 'Avatar', 'onRadarPush');
    expect(result.steps.map(step => step.kind)).toEqual(['local-frame', 'cross-process-send']);
    expect(result.steps[1].role).toBe('client');
    expect(result.steps[1].label).toContain('onMonsterNear');
    // 真实项目缺口:client/Avatar.py 无 onMonsterNear 实现 → 不虚构执行帧
    expect(readScript('client', 'Avatar').includes('def onMonsterNear')).toBe(false);
    // def 侧声明真实存在(Avatar.def ClientMethods)
    const defDecl = resolveDefMethod('Avatar', 'ClientMethods', 'onMonsterNear');
    expect(defDecl?.defFile.endsWith('Avatar.def')).toBe(true);
    expect(defDecl?.line).toBeGreaterThan(0);
    // 受众前有分支护栏(if self.client is not None)→ 候选如实记录
    expect(
      result.branchCandidates.some(candidate => candidate.text.includes('self.client is not None'))
    ).toBe(true);
  });

  it('S3 战斗 cell 侧:本地结算帧可达;超类调用与 entities.get 奖励腿如实未连', () => {
    const result = walk('cell', 'Monster', 'receiveDamage');
    expect(result.steps.map(step => step.kind)).toEqual(['local-frame', 'local-frame']);
    expect(result.steps.map(step => step.depth)).toEqual([0, 1]);
    expect(result.steps[0].label).toContain('Monster.receiveDamage');
    expect(result.steps[1].label).toContain('Monster.onDamaged');
    expect(result.steps.every(step => step.role === 'cell')).toBe(true);
    // 腿一:超类调用 Avatar.receiveDamage(self,...) — 跨文件导入类,接收者不可证
    const combatEdges = edgesFrom('cell', 'Monster', 'receiveDamage');
    const superCall = combatEdges.find(
      edge => edge.callSite?.line === lineOf('cell', 'Monster', 'Avatar.receiveDamage(self')
    );
    expect(superCall?.unresolvedReason?.code).toBe('unknown-receiver');
    // 腿二:击杀奖励 killer.base.cellAddExperience — entities.get 引擎引用,
    // 发送面如实立 rpc 边但落点不可静态绑定(FLOW-007 口径)
    const rewardSend = combatEdges.find(
      edge => edge.callSite?.line === lineOf('cell', 'Monster', 'killer.base.cellAddExperience(')
    );
    expect(rewardSend?.messageKind).toBe('rpc');
    expect(rewardSend?.syncAsync).toBe('async-send');
    expect(rewardSend?.unresolvedReason?.code).toBe('unknown-receiver');
  });

  it('S3 战斗结算基座腿:cellAddExperience → client.onLevelUp 全链(def 父链推导)', () => {
    const result = walk('base', 'Avatar', 'cellAddExperience');
    expect(result.steps.map(step => step.kind)).toEqual([
      'local-frame',
      'cross-process-send',
      'remote-exec'
    ]);
    expect(result.steps.map(step => step.role)).toEqual(['base', 'client', 'client']);
    expect(result.steps.map(step => step.depth)).toEqual([0, 0, 1]);
    expect(result.steps[1].label).toContain('onLevelUp');
    expect(result.steps[2].label).toContain('Avatar.onLevelUp');
    // 结算前有分支护栏(if self.client is not None)→ 候选如实记录
    expect(
      result.branchCandidates.some(candidate => candidate.text.includes('self.client is not None'))
    ).toBe(true);
    // 实现叶真实存在:client/Avatar.onLevelUp(非继承,本类实现)
    const impl = resolveImplementation('Avatar', 'ClientMethods', 'onLevelUp');
    expect(impl?.filePath).toBe(scriptPath('client', 'Avatar'));
    expect(impl?.inheritedFrom ?? null).toBeNull();
    // def 父链:Monster 的 cellAddExperience 经 <Parent> Avatar 落 Avatar.def
    const def = resolveDefMethod('Monster', 'BaseMethods', 'cellAddExperience');
    expect(def?.defFile.endsWith('Avatar.def')).toBe(true);
    expect(def?.line).toBeGreaterThan(0);
    // 实现父链:Monster 在 base 面无脚本 → 沿父链落 base/Avatar.py(inheritedFrom)
    const implInherited = resolveImplementation('Monster', 'BaseMethods', 'cellAddExperience');
    expect(implInherited?.filePath).toBe(scriptPath('base', 'Avatar'));
    expect(implInherited?.inheritedFrom).toBe('Avatar');
  });
});
