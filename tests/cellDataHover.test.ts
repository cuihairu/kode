import { describe, expect, it } from 'vitest';
import {
  cellDataHoverMarkdown,
  type CellDataHoverInputs
} from '../src/backend/cellDataHover';

const base = (over: Partial<CellDataHoverInputs>): CellDataHoverInputs => ({
  role: 'base',
  entity: 'Avatar',
  keys: [
    { key: 'hp', kind: 'defField', typeLabel: 'UINT32', sourceFile: 'Avatar.def', sourceLine: 5 },
    { key: 'position', kind: 'builtin', typeLabel: 'Vector3Like', sourceFile: null, sourceLine: null }
  ],
  inWindow: false,
  state: null,
  ...over
});

describe('cellDataHoverMarkdown (KSEM-CELL-14)', () => {
  it('lists declared keys with def sources for a base script', () => {
    const md = cellDataHoverMarkdown(base({}));
    expect(md).toContain('`hp` · UINT32 · Avatar.def:5');
    expect(md).toContain('`position` · Vector3Like');
    expect(md).toContain('来源/Source: 2 键');
    expect(md).toContain('2 keys from the entity');
  });

  it('does not invent keys when the universe is unavailable', () => {
    const md = cellDataHoverMarkdown(base({ keys: null }));
    expect(md).toContain('键宇宙不可用');
    expect(md).not.toContain('`hp`');
  });

  it('says so honestly when the entity declares no cell properties', () => {
    const md = cellDataHoverMarkdown(base({ keys: [] }));
    expect(md).toContain('声明集为空');
  });

  it('caps the key list and reports the overflow count', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      key: `k${i}`, kind: 'defField' as const, typeLabel: 'UINT32',
      sourceFile: 'Avatar.def', sourceLine: i + 1
    }));
    const md = cellDataHoverMarkdown(base({ keys: many }));
    expect(md).toContain('`k11`');
    expect(md).not.toContain('`k12`');
    expect(md).toContain('共 13 键');
  });

  it('gives base scripts the snapshot semantics with engine citations', () => {
    const md = cellDataHoverMarkdown(base({}));
    expect(md).toContain('cellDataDict_');
    expect(md).toContain('entity.h:276');
    expect(md).toContain('entity.cpp:1108-1123');
    expect(md).toContain(':1024');
  });

  it('tells cell scripts the engine never installs the attribute', () => {
    const md = cellDataHoverMarkdown(base({ role: 'cell' }));
    expect(md).toContain('不安装');
    expect(md).toContain('entity_macro.h:408-412');
    expect(md).toContain('AttributeError');
  });

  it('marks the proven deleted state inside onGetCell before any rebuild', () => {
    const md = cellDataHoverMarkdown(base({ inWindow: true, state: 'absent' }));
    expect(md).toContain('⚠ 引擎已删');
    expect(md).toContain('entity.cpp:1024');
    expect(md).toContain('AttributeError');
    expect(md).toContain('rebuilds it');
  });

  it('marks the rebuilt state after an in-method store', () => {
    const md = cellDataHoverMarkdown(base({ inWindow: true, state: 'present' }));
    expect(md).toContain('✓ 已在本方法体内重建');
    expect(md).toContain('rebuilt earlier');
  });

  it('makes no definite claim outside onGetCell', () => {
    const md = cellDataHoverMarkdown(base({ inWindow: false, state: null }));
    expect(md).toContain('不做确定结论');
    expect(md).not.toContain('⚠');
  });

  it('marks the proven-state section not applicable for cell scripts', () => {
    const md = cellDataHoverMarkdown(base({ role: 'cell', inWindow: false, state: null }));
    expect(md).toContain('cell 侧不适用');
  });

  it('links the real published knowledge pages for both languages', () => {
    const md = cellDataHoverMarkdown(base({}));
    expect(md).toContain('https://cuihairu.github.io/kode/zh/knowledge/entity-lifecycle-reference');
    expect(md).toContain('https://cuihairu.github.io/kode/knowledge/entity-lifecycle-reference');
    expect(md).toContain('https://cuihairu.github.io/kode/zh/knowledge/api-baseapp-entity');
    expect(md).toContain('https://cuihairu.github.io/kode/knowledge/api-baseapp-entity');
  });

  it('keeps the behavior-note shape: --- separator then bilingual sections', () => {
    const md = cellDataHoverMarkdown(base({}));
    expect(md.startsWith('\n\n---\n\n')).toBe(true);
    expect(md).toContain('`self.cellData`');
    expect(md).toContain('Avatar');
    expect(md).toContain('角色/Role: base');
  });
});
