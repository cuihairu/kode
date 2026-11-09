import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  KBENGINE_ENTRY_HOOKS,
  getEntryHookByName,
  isEntryScriptFile
} from '../src/backend/entryHooks';
import { KBEngineCompletionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import {
  CompletionItemKind,
  Hover,
  Position,
  makeTextDocument
} from './helpers/vscodeStub';
import { resolveEngineRoot } from './helpers/engineRoot';

const engineRoot = resolveEngineRoot();

// SP-1: 入口脚本(kbemain.py)模块级 SPI——与实体 hooks(有 self)分离的数据面。
// 数据源=docs/knowledge/entry-script-spi-methods.md;sourceLocation 对齐引擎实调行。
const SPACE_ENTRY_HOOKS = ['onSpaceData', 'onSpaceGeometryLoaded', 'onAllSpaceGeometryLoaded'];

describe('entry hook data', () => {
  it('covers the space trio with unique names', () => {
    const names = KBENGINE_ENTRY_HOOKS.map(hook => hook.name);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of SPACE_ENTRY_HOOKS) {
      expect(names).toContain(expected);
    }
  });

  it('documents module-level signatures without self', () => {
    for (const hook of KBENGINE_ENTRY_HOOKS) {
      expect(hook.description.length, hook.name).toBeGreaterThan(0);
      expect(hook.documentation.length, hook.name).toBeGreaterThan(0);
      expect(hook.timing.length, hook.name).toBeGreaterThan(0);
      expect(hook.signature, hook.name).toMatch(new RegExp(`^def ${hook.name}\\(`));
      expect(hook.signature, hook.name).not.toMatch(/\(self/);
      expect(hook.sourceLocation, hook.name).toMatch(
        /^kbe\/src\/server\/cellapp\/[\w./]+\.cpp:\d+(; kbe\/src\/server\/cellapp\/[\w./]+\.cpp:\d+)*$/
      );
    }
  });

  it('resolves by name and rejects unknown names', () => {
    expect(getEntryHookByName('onSpaceData')?.name).toBe('onSpaceData');
    expect(getEntryHookByName('onEnterSpace')).toBeUndefined();
    expect(getEntryHookByName('notAHook')).toBeUndefined();
  });

  it('scopes entry script detection to kbemain.py', () => {
    expect(isEntryScriptFile('/ws/scripts/cell/kbemain.py')).toBe(true);
    expect(isEntryScriptFile('C:\\ws\\scripts\\cell\\kbemain.py')).toBe(true);
    expect(isEntryScriptFile('/ws/scripts/cell/Avatar.py')).toBe(false);
    expect(isEntryScriptFile('/ws/scripts/cell/kbemain.pyi')).toBe(false);
    expect(isEntryScriptFile('/ws/kbemain.txt')).toBe(false);
  });
});

describe.skipIf(!engineRoot)('entry hooks vs engine source', () => {
  if (!engineRoot) {
    return;
  }

  const spacememoryPath = path.join(engineRoot, 'kbe/src/server/cellapp/spacememory.cpp');

  it('points every sourceLocation at the line that invokes the callback', () => {
    const lines = fs.readFileSync(spacememoryPath, 'utf8').split('\n');
    let verified = 0;

    for (const hook of KBENGINE_ENTRY_HOOKS) {
      for (const ref of hook.sourceLocation.split(';').map(part => part.trim())) {
        const match = /^(.+):(\d+)$/.exec(ref);
        expect(match, `malformed sourceLocation for ${hook.name}: ${ref}`).not.toBeNull();

        const [, file, lineText] = match!;
        expect(file).toBe('kbe/src/server/cellapp/spacememory.cpp');
        const line = lines[Number(lineText) - 1] ?? '';
        expect(
          line.includes(`"${hook.name}"`),
          `${hook.name} expected at ${file}:${lineText}, got: ${line.trim().slice(0, 80)}`
        ).toBe(true);
        verified += 1;
      }
    }

    expect(verified).toBeGreaterThanOrEqual(SPACE_ENTRY_HOOKS.length);
  });
});

describe('entry hook completion in kbemain.py', () => {
  const complete = async (lineText: string, fileName: string): Promise<unknown[]> => {
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument(lineText + '\n', {
      fileName,
      languageId: 'python'
    });
    const position = new Position(0, lineText.length);
    const items = (await provider.provideCompletionItems(document, position)) as {
      label: unknown;
      kind?: number;
    }[];
    return items ?? [];
  };

  it('offers space entry hooks when typing def on prefix', async () => {
    const items = await complete('def on', '/ws/scripts/cell/kbemain.py');
    const labels = items.map(item => String(item.label));
    expect(labels).toContain('onSpaceData');
    expect(labels).toContain('onSpaceGeometryLoaded');
    expect(labels).toContain('onAllSpaceGeometryLoaded');
    expect(items.every(item => item.kind === CompletionItemKind.Method)).toBe(true);
  });

  it('filters entry hooks by typed prefix', async () => {
    const items = await complete('def onSpaceG', '/ws/scripts/cell/kbemain.py');
    const labels = items.map(item => String(item.label));
    expect(labels).toContain('onSpaceGeometryLoaded');
    expect(labels).not.toContain('onSpaceData');
  });

  it('does not offer entry hooks in entity scripts', async () => {
    const items = await complete('def onS', '/ws/scripts/cell/Avatar.py');
    const labels = items.map(item => String(item.label));
    expect(labels).not.toContain('onSpaceData');
    expect(labels).not.toContain('onAllSpaceGeometryLoaded');
  });
});

describe('entry hook hover in kbemain.py', () => {
  const hoverOn = (text: string, fileName: string): string => {
    const provider = new KBEngineHoverProvider();
    const document = makeTextDocument(text, { fileName, languageId: 'python' });
    // 光标落在 onSpaceData 词中部:第 0 行、名字第 4 个字符处
    const position = new Position(0, 4);
    const hover = provider.provideHover(document, position) as Hover | null;
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

  it('documents onSpaceData with signature, timing and source location', () => {
    const doc = hoverOn('onSpaceData\n', '/ws/scripts/cell/kbemain.py');
    expect(doc).toContain('**onSpaceData**');
    expect(doc).toContain('def onSpaceData(');
    expect(doc).toContain('调用时机');
    expect(doc).toContain('spacememory.cpp');
  });

  it('documents onAllSpaceGeometryLoaded', () => {
    const doc = hoverOn('onAllSpaceGeometryLoaded\n', '/ws/scripts/cell/kbemain.py');
    expect(doc).toContain('**onAllSpaceGeometryLoaded**');
    expect(doc).toContain('spacememory.cpp');
  });

  it('does not present entry hooks as entity hooks in entity scripts', () => {
    // 实体脚本里 onSpaceData 不是实体回调——不给入口 SPI 悬停,
    // 避免把 kbemain 模块级语义污染到 Avatar.py。
    const doc = hoverOn('onSpaceData\n', '/ws/scripts/cell/Avatar.py');
    expect(doc).not.toContain('spacememory.cpp');
  });
});
