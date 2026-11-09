import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FINDING_SENTINEL,
  mapFindingsToDiagnostics
} from '../src/processTopologyDiagnostics';
import type { ProcessTopologyFinding } from '../src/backend/processTopologyRust';

// C-17 findings → 诊断规范映射(纯逻辑):哨兵 <manifest> 解析成实际清单路径、
// def finding 直传 filePath、related 逐条映射、清单路径不可解析时跳过不误报、
// 行号夹取下界 1。

const finding = (overrides: Partial<ProcessTopologyFinding> = {}): ProcessTopologyFinding => ({
  target: 'manifest',
  filePath: MANIFEST_FINDING_SENTINEL,
  line: 3,
  severity: 2,
  message: '端口冲突:baseapp_2 与 baseapp_1 都监听 20005',
  code: 'kbengine.processTopologyDuplicatePort',
  related: [],
  ...overrides
});

describe('mapFindingsToDiagnostics(findings→诊断规范)', () => {
  it('哨兵 <manifest> 解析成实际清单路径', () => {
    const specs = mapFindingsToDiagnostics([finding()], () => '/ws/process_topology.xml');
    expect(specs).toHaveLength(1);
    expect(specs[0].filePath).toBe('/ws/process_topology.xml');
    expect(specs[0].line).toBe(3);
    expect(specs[0].code).toBe('kbengine.processTopologyDuplicatePort');
    expect(specs[0].severity).toBe(2);
  });

  it('def finding 直接用 filePath(不解析哨兵)', () => {
    const specs = mapFindingsToDiagnostics(
      [finding({
        target: 'def',
        filePath: '/defs/entity_defs/Avatar.def',
        line: 8,
        message: '实体 Avatar 有持久化属性,但拓扑缺 dbmgr',
        code: 'kbengine.processTopologyMissingDbmgr'
      })],
      () => '/ws/process_topology.xml'
    );
    expect(specs[0].filePath).toBe('/defs/entity_defs/Avatar.def');
    expect(specs[0].line).toBe(8);
  });

  it('related 逐条映射(哨兵 related 也解析)', () => {
    const specs = mapFindingsToDiagnostics(
      [finding({
        related: [
          { filePath: MANIFEST_FINDING_SENTINEL, line: 1, message: '清单未声明 cellapp' },
          { filePath: '/defs/entity_defs/Monster.def', line: 8, message: 'Monster def 位置' }
        ]
      })],
      () => '/ws/process_topology.xml'
    );
    expect(specs[0].related).toHaveLength(2);
    expect(specs[0].related[0].filePath).toBe('/ws/process_topology.xml');
    expect(specs[0].related[1].filePath).toBe('/defs/entity_defs/Monster.def');
  });

  it('清单路径不可解析(无 workspace 根)→ 清单类 finding 跳过不误报', () => {
    const specs = mapFindingsToDiagnostics(
      [finding(), finding({ target: 'def', filePath: '/defs/entity_defs/Avatar.def' })],
      () => null
    );
    // 哨兵解析失败的那条跳过;def 类保留(其 filePath 不依赖 workspace 根)。
    expect(specs).toHaveLength(1);
    expect(specs[0].filePath).toBe('/defs/entity_defs/Avatar.def');
  });

  it('行号夹取下界 1(0 行防御)', () => {
    const specs = mapFindingsToDiagnostics(
      [finding({ target: 'def', filePath: '/d.def', line: 0 })],
      () => null
    );
    expect(specs[0].line).toBe(1);
  });

  it('空 findings → 空规范', () => {
    expect(mapFindingsToDiagnostics([], () => '/ws/process_topology.xml')).toEqual([]);
  });
});
