// KODE-CFG-016 ②强类型 hover(薄 provider 层)单测:配置绑定/类名 hover 出
// 直读类型文本;非配置名与词界外不出。provider 零自有 IO,schema 缓存注入。
import { describe, expect, it } from 'vitest';
import { ConfigSchemaHoverProvider } from '../src/configSchemaHover';
import { collectConfigSchema, CONFIG_DATA_SETTINGS_DEFAULT, type ConfigDataSettings, type ConfigSourceInput } from '../src/configDataMutation';
import { makeTextDocument } from './fake-vscode/core';
import type * as vscode from 'vscode';

const settings = (overrides: Partial<ConfigDataSettings> = {}): ConfigDataSettings => ({
  ...CONFIG_DATA_SETTINGS_DEFAULT,
  ...overrides
});

describe('ConfigSchemaHoverProvider(②配置 schema hover)', () => {
  const itemsPy = `ITEMS = {
    1: {'name': 'sword', 'hp': 10},
}

class ItemsConfig:
    maxHp: int = 100
`;
  const schema = collectConfigSchema([src('scripts/data/config/items.py', itemsPy)], settings());
  const provider = new ConfigSchemaHoverProvider(() => schema);

  const hoverOn = (source: string, line: number, character: number): string | undefined => {
    const doc = makeTextDocument(source, { fileName: '/proj/scripts/avatar.py', languageId: 'python' }) as unknown as vscode.TextDocument;
    const hover = provider.provideHover(doc, { line, character } as vscode.Position);
    if (!hover) {
      return undefined;
    }
    const raw = hover.contents;
    const parts = Array.isArray(raw) ? raw : [raw];
    return parts.map(p => typeof p === 'string' ? p : p.value).join('\n');
  };

  function src(file: string, text: string): ConfigSourceInput {
    return { file, text };
  }

  it('配置绑定名 hover 出直读类型文本与定义位置', () => {
    const text = hoverOn('def onTick(timerID):\n    hp = ITEMS[1]["hp"]\n', 1, 9);
    expect(text).toContain('ITEMS');
    expect(text).toContain('dict[int, dict[str, str | int]]');
    expect(text).toContain('scripts/data/config/items.py');
  });

  it('配置类名 hover 出类条目;非配置名与 schema 空时不出', () => {
    const text = hoverOn('cfg = ItemsConfig()\n', 0, 6);
    expect(text).toContain('ItemsConfig');
    expect(text).toContain('maxHp: int');

    expect(hoverOn('def onTick(timerID):\n    log(hp)\n', 1, 9)).toBeUndefined();
    expect(hoverOn('x = ITEMS[1]\n', 0, 0)).toBeUndefined();
  });
});
