/**
 * HOOK-TIMING-001 数据核契约测试:
 * 覆盖完整性(36 条实体回调全有 phase+1 条补录)、边双向一致、无环、
 * 用户点名锚点(def 属性注入在 onGetCell/cell 链之前)、
 * 引擎锚 containment(hooks.ts sourceLocation 逐字子串,不新造锚)。
 */
import { describe, it, expect } from 'vitest';
import {
  HOOK_SEQUENCING,
  TIMING_ANCHORS,
  ENTRY_SPI_SEQUENCING,
  coversAllKnownHooks,
  sequencingForHook,
  renderHookSequencingSection,
  renderEntrySpiSequencingSection,
  renderDefPropertyTimingNote,
} from '../src/backend/hookSequencing';
import { KBENGINE_HOOKS } from '../src/hooks';


const anchorKeys = new Set(Object.keys(TIMING_ANCHORS));

describe('hookSequencing 数据核(HOOK-TIMING-001)', () => {
  it('36 条实体回调全部有时序标注,另有 onLoseCell 补录', () => {
    expect(coversAllKnownHooks()).toBe(true);
    expect(Object.keys(HOOK_SEQUENCING)).toHaveLength(KBENGINE_HOOKS.length + 1);
    expect(HOOK_SEQUENCING.onLoseCell).toBeDefined();
    // 补录条目如实标注 hooks.ts 未收录。
    expect(HOOK_SEQUENCING.onLoseCell.anchors[0]).toContain('hooks.ts 未收录');
  });

  it('每条标注 phase/side/trigger/anchors 全齐', () => {
    for (const [name, seq] of Object.entries(HOOK_SEQUENCING)) {
      expect(seq.phase, `${name}.phase`).toBeTruthy();
      expect(seq.side, `${name}.side`).toBeTruthy();
      expect(seq.trigger, `${name}.trigger`).toBeTruthy();
      expect(seq.anchors.length, `${name}.anchors 非空`).toBeGreaterThan(0);
      for (const a of seq.anchors) {
        expect(a, `${name} 锚须带出处标注`).toMatch(/src\/hooks\.ts|docs\/knowledge\//);
      }
    }
  });

  it('钩子名时序边双向一致', () => {
    for (const [name, seq] of Object.entries(HOOK_SEQUENCING)) {
      for (const nxt of seq.after) {
        if (anchorKeys.has(nxt)) {
          continue; // 锚点键是单向语义钩子→锚,不要求锚→钩子
        }
        expect(HOOK_SEQUENCING[nxt], `${name}.after 引用未知钩子 ${nxt}`).toBeDefined();
        expect(
          HOOK_SEQUENCING[nxt]?.before,
          `${nxt}.before 须回指 ${name}`
        ).toContain(name);
      }
      for (const prev of seq.before) {
        if (anchorKeys.has(prev)) {
          continue;
        }
        expect(HOOK_SEQUENCING[prev], `${name}.before 引用未知钩子 ${prev}`).toBeDefined();
        expect(
          HOOK_SEQUENCING[prev]?.after,
          `${prev}.after 须回指 ${name}`
        ).toContain(name);
      }
    }
  });

  it('时序图无环(钩子名边)', () => {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const visit = (node: string, path: string[]): void => {
      const c = color.get(node) ?? WHITE;
      if (c === GRAY) {
        throw new Error(`时序环: ${[...path, node].join(' → ')}`);
      }
      if (c === BLACK) {
        return;
      }
      color.set(node, GRAY);
      for (const nxt of HOOK_SEQUENCING[node]?.after ?? []) {
        if (!anchorKeys.has(nxt)) {
          visit(nxt, [...path, node]);
        }
      }
      color.set(node, BLACK);
    };
    for (const name of Object.keys(HOOK_SEQUENCING)) {
      visit(name, []);
    }
  });

  it('用户点名锚点:def 属性注入先于 cell 链;cellData 在 onGetCell 即刻删除', () => {
    const onGetCell = HOOK_SEQUENCING.onGetCell;
    expect(onGetCell.before).toContain('def-属性注入');
    expect(onGetCell.before).toContain('cellData-就位');
    expect(onGetCell.after).toContain('cellData-删除');
    // 传送:新 space 就位在 onTeleportSuccess 之前。
    expect(HOOK_SEQUENCING.onTeleportSuccess.before).toContain('onTeleport');
    expect(HOOK_SEQUENCING.onTeleportSuccess.before).toContain('teleport-新space就位');
    // onLoseCell 后 cellData 永不复活。
    expect(HOOK_SEQUENCING.onLoseCell.after).toContain('cellData-永不复活');
    // 锚点表本体非空且带语料出处。
    for (const [key, anchor] of Object.entries(TIMING_ANCHORS)) {
      expect(anchor.label, `${key}.label`).toBeTruthy();
      expect(anchor.anchors.length, `${key}.anchors 非空`).toBeGreaterThan(0);
    }
  });

  it('引擎锚 containment:kbe/src 位置逐字来自 hooks.ts sourceLocation 或知识档已固化行号', () => {
    const sources = new Map(KBENGINE_HOOKS.map(h => [h.name, h.sourceLocation ?? '']));
    for (const [name, seq] of Object.entries(HOOK_SEQUENCING)) {
      const orig = sources.get(name);
      for (const anchor of seq.anchors) {
        // 知识档口径锚(标注 docs/knowledge):行号由知识档固化,只验出处存在;
        // hooks.ts 口径锚:引擎位置须逐字子串,不新造。
        if (!anchor.includes('docs/knowledge/')) {
          for (const tok of anchor.match(/kbe\/src\/[^(;)]+/g) ?? []) {
            expect(orig, `${name} 引擎位置须是 hooks.ts sourceLocation 逐字子串`).toContain(tok);
          }
        }
      }
    }
  });

  it('hover 时序段渲染:阶段+等宽箭头链+触发;未知名 null', () => {
    const section = renderHookSequencingSection('onGetCell');
    expect(section).toBeTruthy();
    expect(section!).toContain('**时序**');
    expect(section!).toContain('cell-attach');
    expect(section!).toContain('def 属性注入 → cellData 就位(cell 属性暂存) → onGetCell');
    expect(section!).toContain('触发:');
    expect(renderHookSequencingSection('onNoSuchHook')).toBeNull();
    // 无前后继钩子(如 onTurn)也有阶段行。
    const turn = renderHookSequencingSection('onTurn');
    expect(turn).toContain('movement');
    expect(turn).toContain('onTurn');
  });



  it('def 属性 hover 时序注:注入时机锚 + cellData 路由语义', () => {
    const note = renderDefPropertyTimingNote();
    expect(note).toContain('**注入时序**');
    expect(note).toContain('`.def` 注入');
    expect(note).toContain('cellData');
    expect(note).toContain('api-baseapp.md');
  });

  it('入口 SPI 时序数据:几何加载链与独立触发面', () => {
    expect(ENTRY_SPI_SEQUENCING.onSpaceGeometryLoaded.after).toEqual(['onAllSpaceGeometryLoaded']);
    expect(ENTRY_SPI_SEQUENCING.onAllSpaceGeometryLoaded.before).toEqual(['onSpaceGeometryLoaded']);
    expect(ENTRY_SPI_SEQUENCING.onSpaceData.before).toEqual([]);
    expect(ENTRY_SPI_SEQUENCING.onSpaceData.after).toEqual([]);
    const section = renderEntrySpiSequencingSection('onSpaceGeometryLoaded');
    expect(section).toContain('onSpaceGeometryLoaded → onAllSpaceGeometryLoaded');
    expect(renderEntrySpiSequencingSection('onNoSuchSpi')).toBeNull();
  });
});
