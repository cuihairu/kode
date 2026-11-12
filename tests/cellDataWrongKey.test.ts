import { describe, expect, it } from 'vitest';
import { cellDataWrongKeyFindings } from '../src/backend/cellDataWrongKey';
import {
  trackCellDataKeys,
  cellDataKeyWorldOpen
} from '../src/backend/cellDataKeyTracking';
import type { CellDataKeyEntry } from '../src/backend/cellDataCompletion';

// KSEM-CELL-10 错键提示判据面。三条验收各一条断言:
// - 封闭世界 + 裸下标读未知键 → 确定性缺失(可带拼写候选);
// - 开放世界(动态键写/update) → 只给低置信建议,绝不报缺失;
// - .get() 永不报必然 KeyError,只给低置信建议。
// 事实面复用 CELL-09 的 trackCellDataKeys,不重算。

const entry = (key: string, typeLabel = 'STRING'): CellDataKeyEntry => ({
  key,
  kind: 'defField',
  typeLabel,
  sourceFile: 'Avatar.def',
  sourceLine: 4
});

const UNIVERSE = [entry('hp'), entry('mp'), entry('skill')];

const wrap = (body: string): string => `class Avatar:\n    def onGetCell(self):\n${body}\n`;

const bodyOf = (key: string): string => {
  const indent = '        ';
  return [
    `${indent}def f(self):`,
    `${indent}    v = self.cellData["${key}"]`
  ].join('\n');
};

describe('cellDataWrongKeyFindings(封闭世界)', () => {
  it('裸下标读未知键 → 确定性缺失 + 拼写候选(声明来源)', () => {
    const text = wrap('        v = self.cellData["hpe"]');
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('confirmed');
    expect(findings[0]?.key).toBe('hpe');
    expect(findings[0]?.candidate).toBe('hp');
    expect(findings[0]?.message).toContain('不存在于该实体已声明的字段');
    expect(findings[0]?.message).toContain('最接近的声明键是「hp」');
    expect(findings[0]?.message).toContain('Avatar.def:5');
  });

  it('未知键无候选 → 仍确定性缺失,不给建议', () => {
    const text = wrap('        v = self.cellData["zzzzzzz"]');
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('confirmed');
    expect(findings[0]?.candidate).toBe('');
    expect(findings[0]?.message).not.toContain('最接近');
  });
});

describe('cellDataWrongKeyFindings(开放世界)', () => {
  it('动态键写入 → 只给低置信建议,不报缺失', () => {
    const text = wrap(
      ['        self.cellData[key] = 1', '        v = self.cellData["hpe"]'].join('\n')
    );
    expect(cellDataKeyWorldOpen(text)).toBe(true);
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('hint');
    expect(findings[0]?.message).toContain('疑似');
  });

  it('update( 增键面 → 世界开放', () => {
    const text = wrap(
      ['        self.cellData.update({"a": 1})', '        v = self.cellData["hpe"]'].join('\n')
    );
    expect(cellDataKeyWorldOpen(text)).toBe(true);
  });
});

describe('cellDataWrongKeyFindings(get 形态)', () => {
  it('get 永不报必然 KeyError,只给低置信建议', () => {
    const text = wrap('        v = self.cellData.get("hpe")');
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('hint');
    expect(findings[0]?.message).toContain('疑似「hp」');
  });

  it('get 带默认值 → 消息标明不会因缺失抛错', () => {
    const text = wrap('        v = self.cellData.get("hpe", 0)');
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, false);
    expect(findings[0]?.hasDefault).toBe(true);
    expect(findings[0]?.message).toContain('不会因缺失抛错');
  });

  it('get 已知键 → 不报', () => {
    const text = wrap('        v = self.cellData.get("hp")');
    const facts = trackCellDataKeys(text, UNIVERSE);
    expect(cellDataWrongKeyFindings(facts, UNIVERSE, false)).toHaveLength(0);
  });
});

describe('cellDataWrongKeyFindings(不误报)', () => {
  it('写入即引入键:scriptAdded 写点不报', () => {
    const text = wrap('        self.cellData["hpe"] = 1');
    const facts = trackCellDataKeys(text, UNIVERSE);
    expect(cellDataWrongKeyFindings(facts, UNIVERSE, false)).toHaveLength(0);
  });

  it('声明键读不报(初始即有)', () => {
    const text = wrap('        v = self.cellData["hp"]');
    const facts = trackCellDataKeys(text, UNIVERSE);
    expect(cellDataWrongKeyFindings(facts, UNIVERSE, false)).toHaveLength(0);
  });

  it('已证存在的未知键不报(本作用域内先写后读)', () => {
    const text = wrap(
      ['        self.cellData["tmp"] = 1', '        v = self.cellData["tmp"]'].join('\n')
    );
    const facts = trackCellDataKeys(text, UNIVERSE);
    expect(facts.some(fact => fact.op.key === 'tmp' && fact.op.kind === 'read' && fact.presence === 'present')).toBe(true);
    expect(cellDataWrongKeyFindings(facts, UNIVERSE, false)).toHaveLength(0);
  });
});

describe('候选唯一性(不硬造)', () => {
  it('平局候选 → 不给建议但保留确定性缺失', () => {
    const entries = [entry('hp'), entry('mp')];
    const text = wrap('        v = self.cellData["xp"]');
    const facts = trackCellDataKeys(text, entries);
    const findings = cellDataWrongKeyFindings(facts, entries, false);
    // xp 到 hp/mp 距离同为 1:平局不给候选,但封闭世界下的确定性缺失仍成立
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('confirmed');
    expect(findings[0]?.candidate).toBe('');
  });

  it('距离超上限的键 → 无候选', () => {
    const text = wrap('        v = self.cellData["abcdefgh"]');
    const facts = trackCellDataKeys(text, UNIVERSE);
    const findings = cellDataWrongKeyFindings(facts, UNIVERSE, false);
    expect(findings[0]?.candidate).toBe('');
  });
});

describe('事实面消费契约', () => {
  it('CELL-09 事实给出 presence/keyClass,本面据此分级(不重算)', () => {
    const text = wrap('        v = self.cellData["hpe"]');
    const fact = trackCellDataKeys(text, UNIVERSE).find(
      item => item.op.key === 'hpe' && item.op.kind === 'read'
    );
    expect(fact?.presence).toBe('absent');
    expect(fact?.keyClass).toBe('unknown');
  });
});