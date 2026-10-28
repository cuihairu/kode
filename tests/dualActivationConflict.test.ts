import { describe, expect, it } from 'vitest';
import {
  detectDualActivation,
  formatDualActivationWarning
} from '../src/dualActivationConflict';

// IDE-REL-001 检测两个 Kode ID 是否同时激活:只有「实际共激活」(两个
// Kode 系 ID 都 isActive)才提示冲突;已安装但未激活(启用未触发/被
// 禁用——禁用扩展不进 extensions.all,采集面天然见不到)不算冲突,
// 如实分列不虚报。

const facts = (list: Array<[string, boolean]>) =>
  list.map(([id, isActive]) => ({ id, isActive }));

describe('detectDualActivation(共激活判定)', () => {
  it('两个 Kode ID 都实际激活 → 冲突,activeIds 字典序', () => {
    const verdict = detectDualActivation(facts([
      ['cuihairu.kode-kbengine', true],
      ['cuihairu.kode', true]
    ]));
    expect(verdict.conflict).toBe(true);
    expect(verdict.activeIds).toEqual(['cuihairu.kode', 'cuihairu.kode-kbengine']);
    expect(verdict.inactiveInstalledIds).toEqual([]);
  });

  it('一个激活一个已安装未激活 → 不算冲突,未激活的如实分列', () => {
    const verdict = detectDualActivation(facts([
      ['cuihairu.kode-kbengine', true],
      ['cuihairu.kode', false]
    ]));
    expect(verdict.conflict).toBe(false);
    expect(verdict.activeIds).toEqual(['cuihairu.kode-kbengine']);
    expect(verdict.inactiveInstalledIds).toEqual(['cuihairu.kode']);
  });

  it('只有自身激活 → 无冲突', () => {
    const verdict = detectDualActivation(facts([['cuihairu.kode-kbengine', true]]));
    expect(verdict.conflict).toBe(false);
    expect(verdict.activeIds).toEqual(['cuihairu.kode-kbengine']);
    expect(verdict.inactiveInstalledIds).toEqual([]);
  });

  it('三个共激活也判冲突(activeIds 全列)', () => {
    const verdict = detectDualActivation(facts([
      ['cuihairu.kode-kbengine', true],
      ['cuihairu.kode', true],
      ['cuihairu.kode-legacy', true]
    ]));
    expect(verdict.conflict).toBe(true);
    expect(verdict.activeIds).toEqual(['cuihairu.kode', 'cuihairu.kode-kbengine', 'cuihairu.kode-legacy']);
  });

  it('全部未激活 → 无冲突(装了没跑不是共激活)', () => {
    const verdict = detectDualActivation(facts([
      ['cuihairu.kode-kbengine', false],
      ['cuihairu.kode', false]
    ]));
    expect(verdict.conflict).toBe(false);
    expect(verdict.inactiveInstalledIds).toEqual(['cuihairu.kode', 'cuihairu.kode-kbengine']);
  });
});

describe('formatDualActivationWarning(冲突提示文案)', () => {
  it('冲突 → 文案点名两个激活 ID', () => {
    const text = formatDualActivationWarning(detectDualActivation(facts([
      ['cuihairu.kode-kbengine', true],
      ['cuihairu.kode', true]
    ])));
    expect(text).toContain('cuihairu.kode');
    expect(text).toContain('cuihairu.kode-kbengine');
    expect(text).toContain('同时激活');
  });

  it('无冲突 → null(零打扰)', () => {
    expect(formatDualActivationWarning(detectDualActivation(facts([
      ['cuihairu.kode-kbengine', true]
    ])))).toBeNull();
  });
});
