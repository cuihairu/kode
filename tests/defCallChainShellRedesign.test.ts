// CallChainController UI 重设计(UI-07):唯一零 CSS 壳面板补上统一系统——
// token 化样式壳、样式化页签、渲染失败 notice 条(语义 warn)、
// Cell/Base/Client 三色图例;页签文案走字符串表(zh/en)。
import { beforeEach, describe, expect, it } from 'vitest';
import { CallChainController } from '../src/defCallChainProvider';
import { buildDefCallChain } from '../src/defCallChain';
import { configurationOverrides, envState } from './helpers/vscodeStub';

// buildDefCallChain 需要真实索引;这里用最小 DefCallChain 形状直测 html 壳。
const chain = {
  root: { id: 'root', signature: 'Avatar.castSkill(skillID, targetID)' },
  nodes: [
    { id: 'root', signature: 'Avatar.castSkill(skillID, targetID)' },
    { id: 'n1', signature: 'Avatar.giveExp(amount)' }
  ],
  edges: [{ from: 'root', to: 'n1', receiver: 'self' }]
} as unknown as ReturnType<typeof buildDefCallChain>;

const htmlOf = (): string => {
  const controller = new CallChainController({} as never, {});
  return (controller as unknown as { html: (c: typeof chain, m: string) => string }).html(
    chain,
    'flowchart TD\n  root --> n1'
  );
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('CallChainController 设计系统壳', () => {
  it('token 进面板(tablist/notice/legend 样式化)', () => {
    const html = htmlOf();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('.call-chain-tabs');
    expect(html).toContain('call-chain-notice');
    expect(html).toContain('call-chain-legend');
  });

  it('图例三色与 def 三节段对齐(Cell/Base/Client)', () => {
    const html = htmlOf();
    expect(html).toContain('#1d3a2a');
    expect(html).toContain('#173a5e');
    expect(html).toContain('#3a2d10');
    expect(html).toContain('CellMethods');
    expect(html).toContain('BaseMethods');
    expect(html).toContain('ClientMethods');
  });

  it('notice 条为 warn 语义(不再裸 div)', () => {
    const html = htmlOf();
    expect(html).toContain('class="call-chain-notice kode-notice warn"');
  });
});

describe('CallChainController i18n', () => {
  it('zh:页签为 图/文本', () => {
    const html = htmlOf();
    expect(html).toContain('>图</button>');
    expect(html).toContain('>文本</button>');
    expect(html).not.toContain('>Graph</button>');
  });

  it('en:kbengine.webviewLocale=en 页签 Graph/Text', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = htmlOf();
    expect(html).toContain('>Graph</button>');
    expect(html).toContain('>Text</button>');
  });
});
