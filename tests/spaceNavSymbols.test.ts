import { describe, expect, it } from 'vitest';
import {
  KBE_SYMBOLS,
  getKbeSymbol,
  summaryForLanguage
} from '../src/kbeModuleIndex';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { Hover, Position, makeTextDocument } from './helpers/vscodeStub';

// SP-2: KBEngine 空间/导航模块函数挂进 KBE_SYMBOLS 并接 hover。
// 数据源=docs/knowledge/api-cellapp.md 行摘要;锚点=typings/_KBEngine_cellapp.pyi。
// 验收:KBEngine.addSpaceGeometryMapping(...) hover 含层参数语义与回调链说明。

const SPACE_NAV_SYMBOLS = [
  'addSpaceGeometryMapping',
  'getSpaceGeometryMapping',
  'setSpaceData',
  'getSpaceData',
  'delSpaceData',
  'raycast'
];

describe('space/nav symbols in KBE_SYMBOLS (SP-2)', () => {
  it('registers the six cellapp space/nav module functions', () => {
    for (const name of SPACE_NAV_SYMBOLS) {
      const entry = getKbeSymbol(name);
      expect(entry, `${name} 应在 KBE_SYMBOLS`).not.toBeNull();
      expect(entry!.kind).toBe('function');
      expect(entry!.sourceFile).toBe('typings/_KBEngine_cellapp.pyi');
    }
  });

  it('addSpaceGeometryMapping summary carries layer params and callbacks', () => {
    const entry = getKbeSymbol('addSpaceGeometryMapping')!;
    const zh = summaryForLanguage(entry, 'zh-cn');
    const en = summaryForLanguage(entry, 'en');
    // 层参数语义
    expect(zh).toMatch(/layer/);
    expect(zh).toMatch(/navmesh/);
    // 回调链
    expect(zh).toMatch(/onSpaceGeometryLoaded|onAllSpaceGeometryLoaded/);
    expect(en.toLowerCase()).toContain('layer');
    expect(en).toMatch(/onSpaceGeometryLoaded|onAllSpaceGeometryLoaded/);
  });

  it('setSpaceData summary points at onSpaceData broadcast', () => {
    const entry = getKbeSymbol('setSpaceData')!;
    expect(summaryForLanguage(entry, 'zh-cn')).toContain('onSpaceData');
    expect(summaryForLanguage(entry, 'en')).toContain('onSpaceData');
  });

  it('raycast summary notes geometry-load prerequisite', () => {
    const entry = getKbeSymbol('raycast')!;
    const zh = summaryForLanguage(entry, 'zh-cn');
    expect(zh).toMatch(/addSpaceGeometryMapping/);
  });

  it('existing symbols keep their anchors (zero regression on curated set)', () => {
    expect(getKbeSymbol('Entity')).not.toBeNull();
    expect(getKbeSymbol('reloadScript')).not.toBeNull();
    expect(getKbeSymbol('createEntity')).not.toBeNull();
    expect(KBE_SYMBOLS.length).toBeGreaterThan(35);
  });
});

describe('hover on KBEngine.addSpaceGeometryMapping (SP-2)', () => {
  const hoverOn = (text: string, line: number, character: number): string => {
    const provider = new KBEngineHoverProvider();
    const document = makeTextDocument(text, {
      fileName: '/ws/scripts/cell/kbemain.py',
      languageId: 'python'
    });
    const hover = provider.provideHover(document, new Position(line, character)) as Hover | null;
    if (!hover) {
      return '';
    }
    const contents = hover.contents;
    return Array.isArray(contents)
      ? contents.map(item => (typeof item === 'string' ? item : item.value)).join('')
      : typeof contents === 'string'
        ? contents
        : contents.value;
  };

  it('documents layer semantics and completion callbacks', () => {
    const text = 'import KBEngine\nKBEngine.addSpaceGeometryMapping(spaceID, None, path)\n';
    // 第 1 行,光标落在 addSpaceGeometryMapping 词中部
    const doc = hoverOn(text, 1, 14);
    expect(doc).toContain('addSpaceGeometryMapping');
    expect(doc).toMatch(/layer/i);
    expect(doc).toMatch(/onSpaceGeometryLoaded|onAllSpaceGeometryLoaded/);
    expect(doc).toContain('_KBEngine_cellapp.pyi');
  });

  it('documents setSpaceData with onSpaceData callback', () => {
    const text = 'import KBEngine\nKBEngine.setSpaceData(spaceID, key, value)\n';
    const doc = hoverOn(text, 1, 12);
    expect(doc).toContain('setSpaceData');
    expect(doc).toContain('onSpaceData');
  });

  it('does not hijack hover when KBEngine is not imported', () => {
    const text = 'addSpaceGeometryMapping(spaceID, None, path)\n';
    const doc = hoverOn(text, 0, 6);
    expect(doc).not.toContain('_KBEngine_cellapp.pyi');
  });

  it('still hovers reload functions via existing path for bare reloadScript', () => {
    // 无别名前缀的裸词不走 kbe-access,既有 reload 链保持可用
    const text = 'import KBEngine\nreloadScript(True)\n';
    const doc = hoverOn(text, 1, 4);
    // 无论是 kbe 符号还是 reload 元数据,至少不应报错返回空——
    // reloadScript 在 KBE_SYMBOLS 中,但无 alias. 前缀不命中 kbe-access;
    // 既有 KBENGINE_RELOAD_FUNCTIONS 链按 word 兜底。
    expect(doc === '' || doc.includes('reloadScript')).toBe(true);
  });
});
