// EntityFlowWebView UI 重设计(UI-06):统一 token、mermaid dark 主题、
// blocked 方法红边警示卡独立于普通边卡、全部文案走字符串表(zh/en)。
import { beforeEach, describe, expect, it } from 'vitest';
import { EntityFlowWebView } from '../src/entityFlowWebView';
import { configurationOverrides, envState } from './helpers/vscodeStub';
import type { EntityFlowGraph } from '../src/entityFlowGraph';

const graph: EntityFlowGraph = {
  entityName: 'Hero',
  actors: ['client', 'base', 'cell'],
  stats: {
    properties: 18,
    methods: 24,
    exposedCalls: 9,
    clientCallbacks: 11,
    persistentProperties: 6,
    blockedCalls: 1
  },
  edges: [
    {
      from: 'client',
      to: 'cell',
      semantic: '客户端通过 Exposed 方法请求 cell 面动作',
      flags: ['CELL_CALL'],
      citations: [{ file: 'kbengine/entity_entity_component.cpp', line: 218, note: '非 Exposed 直接丢弃' }],
      members: [
        {
          kind: 'method',
          name: 'requestMove',
          exposed: true,
          flags: '',
          persistent: false,
          source: 'Exposed · cell',
          filePath: '/ws/scripts/cell/Avatar.py',
          line: 88
        }
      ]
    }
  ],
  blocked: [
    {
      method: 'base_onAccountBind',
      section: 'BaseMethods',
      reason: '客户端只能调 Exposed 方法,该接口未标记 Exposed',
      citation: { file: 'kbengine/entity_entity_component.cpp', line: 218 }
    }
  ]
} as unknown as EntityFlowGraph;

const render = (): string => {
  const panel = new EntityFlowWebView({} as unknown as import('vscode').ExtensionContext);
  return (panel as unknown as { getWebviewContent: (g: EntityFlowGraph) => string }).getWebviewContent(graph);
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('EntityFlowWebView 设计系统', () => {
  it('token 进面板', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('--kode-err:#f14c4c');
  });

  it('mermaid 主题钉 dark(亮色 default 退场)', () => {
    const html = render();
    expect(html).toContain("theme: 'dark'");
    expect(html).not.toContain("theme: 'default'");
  });

  it('blocked 方法红边警示卡独立于普通边卡', () => {
    const html = render();
    expect(html).toContain('edge edge--blocked');
    expect(html).toContain('客户端调不到的方法');
  });
});

describe('EntityFlowWebView i18n', () => {
  it('zh:统计与按钮沿用现有中文文案', () => {
    const html = render();
    expect(html).toContain('客户端可调');
    expect(html).toContain('客户端调不到');
    expect(html).toContain('导出 Markdown');
    expect(html).toContain('引擎出处');
    expect(html).toContain('声明位置');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Client-callable');
    expect(html).toContain('Export Markdown');
    expect(html).toContain('Engine citation');
    expect(html).toContain('Methods unreachable from clients');
    expect(html).not.toContain('客户端可调');
  });
});
