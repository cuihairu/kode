/**
 * API-PARAM-HOVER-001 数据核契约测试:
 * create-entity 家族 params/returns 覆盖 100%、双语非空、与签名逐参一致、
 * 语料锚(api-baseapp.md §2)、entityType→运行时类映射(base 侧优先/not-found
 * 如实)、渲染段(zh/en)。
 */
import { describe, it, expect } from 'vitest';
import {
  KBE_SYMBOLS,
  buildEntityTypeRuntimeHints,
  renderKbeParamsSection,
  renderKbeReturnsSection,
  KBE_PARAM_DOC_SOURCE_ANCHOR
} from '../src/kbeModuleIndex';
import { createKbeSymbolHover } from '../src/languageProviders/hoverBuilders';

/** create-entity 家族(任务书面:7 条,FromDBID 三变体在内)。 */
const FAMILY = [
  'createEntity',
  'createEntityLocally',
  'createEntityAnywhere',
  'createEntityRemotely',
  'createEntityFromDBID',
  'createEntityAnywhereFromDBID',
  'createEntityRemotelyFromDBID'
];

const familyEntries = FAMILY.map(name => {
  const entry = KBE_SYMBOLS.find(symbol => symbol.name === name);
  if (!entry) {
    throw new Error(`family symbol missing: ${name}`);
  }
  return entry;
});

describe('kbeModuleIndex params/returns 数据核(API-PARAM-HOVER-001)', () => {
  it('create-entity 家族 7 条 params/returns/entityTypeHint 全覆盖', () => {
    for (const entry of familyEntries) {
      expect(entry.params, `${entry.name}.params 非空`).toBeTruthy();
      expect(entry.params!.length, `${entry.name} 至少 entityType 一参`).toBeGreaterThanOrEqual(1);
      expect(entry.returns, `${entry.name}.returns`).toBeTruthy();
      expect(entry.returns!.entityTypeHint, `${entry.name} 家族恒 entityTypeHint`).toBe(true);
      expect(entry.params![0].name, `${entry.name} 首参=entityType`).toBe('entityType');
    }
  });

  it('逐参与签名一致:每参是签名的顶层形参;optional ⟺ 该形参段带默认值', () => {
    // 顶层逗号拆分(嵌套 [ ] / ( ) 内的逗号不算),否则 Dict[str, Any] 会误切。
    const topLevelParams = (signature: string): string[] => {
      const body = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of body) {
        if (ch === '[' || ch === '(') { depth++; current += ch; }
        else if (ch === ']' || ch === ')') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      if (current.trim()) { parts.push(current.trim()); }
      return parts;
    };
    for (const entry of familyEntries) {
      const segments = topLevelParams(entry.signature);
      for (const param of entry.params!) {
        const segment = segments.find(seg => seg.startsWith(`${param.name}:`) || seg.startsWith(`${param.name} =`));
        expect(segment, `${entry.name}.${param.name} 须是签名顶层形参`).toBeTruthy();
        const hasDefault = segment!.includes('=');
        expect(param.optional, `${entry.name}.${param.name} optional=${param.optional} 须与签名默认值 ${hasDefault} 一致`).toBe(hasDefault);
        expect(param.description, `${entry.name}.${param.name} 中文描述非空`).toBeTruthy();
        expect(param.descriptionEn, `${entry.name}.${param.name} 英文描述非空(GEN-DEF-1d)`).toBeTruthy();
      }
    }
  });

  it('returns.type 与签名尾部同源;双语描述非空', () => {
    for (const entry of familyEntries) {
      const tail = entry.signature.split('->')[1]?.trim() ?? '';
      expect(entry.returns!.type, `${entry.name} returns.type 与签名尾一致`).toBe(tail);
      expect(entry.returns!.description, `${entry.name} 返回中文描述非空`).toBeTruthy();
      expect(entry.returns!.descriptionEn, `${entry.name} 返回英文描述非空`).toBeTruthy();
    }
  });

  it('语料锚:参数段尾注 api-baseapp.md §2;params dict 语义=cellData 路由+.def 默认', () => {
    expect(KBE_PARAM_DOC_SOURCE_ANCHOR).toContain('docs/knowledge/api-baseapp.md');
    for (const entry of familyEntries) {
      const dictParam = entry.params!.find(param => param.name === 'params');
      if (dictParam) {
        expect(dictParam.description, `${entry.name} params dict 须提 cellData 路由`).toContain('cellData');
        expect(dictParam.description, `${entry.name} params dict 须提 .def 默认`).toContain('.def 默认');
        expect(dictParam.descriptionEn).toContain('cellData');
      }
    }
    const fromDbid = familyEntries.find(entry => entry.name === 'createEntityFromDBID')!;
    const callback = fromDbid.params!.find(param => param.name === 'callback')!;
    expect(callback.description, 'FromDBID 回调形 (baseRef, databaseID, wasActive)').toContain('(baseRef, databaseID, wasActive)');
  });

  it('非家族符号不携带 params/returns(分批推进,不冒充)', () => {
    for (const symbol of KBE_SYMBOLS) {
      if (FAMILY.includes(symbol.name)) {
        continue;
      }
      expect(symbol.params, `${symbol.name} 非家族面本批不应有 params`).toBeUndefined();
      expect(symbol.returns, `${symbol.name} 非家族面本批不应有 returns`).toBeUndefined();
    }
  });
});

describe('entityType→运行时类映射(API-PARAM-HOVER-001)', () => {
  it('base 侧脚本优先;存在性经注入判定;not-found 如实标', () => {
    const hints = buildEntityTypeRuntimeHints(
      [
        { name: 'Account', pythonFiles: ['/ws/scripts/base/Account.py', '/ws/scripts/client/Account.py'] },
        { name: 'Monster', pythonFiles: ['/ws/scripts/base/Monster.py'] },
        { name: 'Ghost', pythonFiles: [] }
      ],
      candidate => candidate === '/ws/scripts/base/Account.py'
    );
    expect(hints).toEqual([
      { entityType: 'Account', scriptPath: '/ws/scripts/base/Account.py', found: true },
      { entityType: 'Monster', scriptPath: '/ws/scripts/base/Monster.py', found: false },
      { entityType: 'Ghost', scriptPath: '', found: false }
    ]);
  });

  it('无 base 侧线索时取第一个 owner 文件(诚实呈现注册表解析结果)', () => {
    const hints = buildEntityTypeRuntimeHints(
      [{ name: 'Plain', pythonFiles: ['/ws/scripts/common/Plain.py'] }],
      () => true
    );
    expect(hints[0]).toEqual({ entityType: 'Plain', scriptPath: '/ws/scripts/common/Plain.py', found: true });
  });

  it('Windows 反斜杠路径也能识别 base 段', () => {
    const hints = buildEntityTypeRuntimeHints(
      [{ name: 'W', pythonFiles: ['C:\\ws\\scripts\\client\\W.py', 'C:\\ws\\scripts\\base\\W.py'] }],
      () => true
    );
    expect(hints[0].scriptPath).toBe('C:\\ws\\scripts\\base\\W.py');
  });
});

describe('params/returns 渲染段(API-PARAM-HOVER-001)', () => {
  it('参数段:标题+逐参+可选标记+语料锚;zh/en 双脸', () => {
    const entry = familyEntries.find(e => e.name === 'createEntity')!;
    const zh = renderKbeParamsSection(entry, 'zh-cn');
    expect(zh).toContain('**参数**');
    expect(zh).toContain('`entityType`');
    expect(zh).toContain('`params` (可选) ');
    expect(zh).toContain('cellData');
    expect(zh).toContain(KBE_PARAM_DOC_SOURCE_ANCHOR);
    const en = renderKbeParamsSection(entry, 'en');
    expect(en).toContain('**Parameters**');
    expect(en).toContain('`params` (optional) ');
    expect(en).toContain('cellData');
  });

  it('返回值段:类型+描述+entityType 映射行(found/not-found 双脸)', () => {
    const entry = familyEntries.find(e => e.name === 'createEntity')!;
    const section = renderKbeReturnsSection(entry, 'zh-cn', [
      { entityType: 'Account', scriptPath: 'scripts/base/Account.py', found: true },
      { entityType: 'Ghost', scriptPath: '', found: false }
    ]);
    expect(section).toContain('**返回** `Union[Entity, None]`');
    expect(section).toContain('同步返回');
    expect(section).toContain('`Account` → `scripts/base/Account.py`');
    expect(section).toContain('`Ghost` → 未找到类文件(not-found)');
  });

  it('映射超过 30 条截断并给总数;无 hints 不出映射块', () => {
    const entry = familyEntries.find(e => e.name === 'createEntity')!;
    const many = Array.from({ length: 35 }, (_, i) => ({
      entityType: `E${i}`, scriptPath: `scripts/base/E${i}.py`, found: true
    }));
    const section = renderKbeReturnsSection(entry, 'zh-cn', many)!;
    expect(section).toContain('`E29`');
    expect(section).not.toContain('`E30` →');
    expect(section).toContain('共 35 个注册实体');
    const noHints = renderKbeReturnsSection(entry, 'zh-cn')!;
    expect(noHints).not.toContain('entityType →');
  });

  it('无 params/returns 数据返回 null(诚实边界)', () => {
    const bare = KBE_SYMBOLS.find(symbol => symbol.name === 'time')!;
    expect(renderKbeParamsSection(bare, 'zh-cn')).toBeNull();
    expect(renderKbeReturnsSection(bare, 'zh-cn')).toBeNull();
  });
});

/** hover.contents 取纯文本(vscodeStub Hover 的 MarkdownString.value)。 */
function hoverText(hover: { contents: unknown }): string {
  const c = hover.contents as { value?: string } | string;
  return typeof c === 'string' ? c : String(c?.value ?? '');
}

describe('kbe 符号 hover 接线(API-PARAM-HOVER-001)', () => {
  it('家族 7 条 hover 都带参数段+返回值段;带 params dict 的挂 cellData 时序锚', () => {
    for (const entry of familyEntries) {
      const text = hoverText(createKbeSymbolHover(entry));
      expect(text, `${entry.name} 参数段`).toContain('**参数**');
      expect(text, `${entry.name} 返回值段`).toContain('**返回**');
      expect(text, `${entry.name} typings 锚保留`).toContain(entry.sourceFile);
      if (entry.params!.some(param => param.name === 'params')) {
        expect(text, `${entry.name} cellData 时序锚`).toContain('cellData');
      }
    }
  });

  it('createKbeSymbolHover 接受 entityTypeHints 并渲染映射行', () => {
    const entry = familyEntries.find(e => e.name === 'createEntityLocally')!;
    const text = hoverText(createKbeSymbolHover(entry, {
      entityTypeHints: [
        { entityType: 'Account', scriptPath: 'scripts/base/Account.py', found: true }
      ]
    }));
    expect(text).toContain('`Account` → `scripts/base/Account.py`');
    expect(text).toContain('同步返回');
  });

  it('非家族符号 hover 形不变(无参数/返回段)', () => {
    const bare = KBE_SYMBOLS.find(symbol => symbol.name === 'time')!;
    const text = hoverText(createKbeSymbolHover(bare));
    expect(text).not.toContain('**参数**');
    expect(text).not.toContain('**返回**');
    expect(text).toContain('**time**');
  });
});
