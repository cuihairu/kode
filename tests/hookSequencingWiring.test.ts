import { describe, it, expect } from 'vitest';
import { KBENGINE_HOOKS } from '../src/hooks';
import { KBENGINE_ENTRY_HOOKS } from '../src/backend/entryHooks';
import { createHookHover, createEntryHookHover } from '../src/languageProviders/hoverBuilders';

/** hover.contents 取纯文本(vscodeStub Hover 的 MarkdownString.value)。 */
function hoverText(hover: { contents: unknown }): string {
  const c = hover.contents as { value?: string } | string;
  return typeof c === 'string' ? c : String(c?.value ?? '');
}

// HOOK-TIMING-001 hover 接线面:36 条钩子与 3 条入口 SPI 的 hover 都带
// 时序段(阶段/箭头链)。数据核契约见 hookSequencing.test.ts。
describe('hookSequencing hover 接线(HOOK-TIMING-001)', () => {
  it('createHookHover 接线:全部 36 条钩子 hover 都带时序段', () => {
    for (const hook of KBENGINE_HOOKS) {
      const text = hoverText(createHookHover(hook));
      expect(text, `${hook.name} hover 须含时序段`).toContain('**时序**');
      expect(text, `${hook.name} hover 须含阶段`).toContain('阶段:');
    }
  });

  it('createEntryHookHover 接线:3 条入口 SPI hover 都带时序段', () => {
    for (const hook of KBENGINE_ENTRY_HOOKS) {
      const text = hoverText(createEntryHookHover(hook));
      expect(text, `${hook.name} 入口 SPI hover 须含时序段`).toContain('**时序**');
    }
  });
});
