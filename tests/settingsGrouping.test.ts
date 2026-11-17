/**
 * RUST-228 设置分组对账锁。
 *
 * contributes.configuration 从单块 153 键拆为 8 个带标题分组块
 * (performance/semantic/python/typings/engine/runtime/tools/general),
 * VS Code 设置页按块标题出目录分组,解决 153 键单列表的导航性问题。
 * 本锁钉:块结构/标题 nls 双语/order 递增/键集合不丢不重/分组归属抽检/
 * plugins 不造空组(PLUG 202..217 家族判例:无插件子系统不立分组)。
 * 全部纯 node:fs 直查清单,零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    configuration:
      | { title?: string; order?: number; properties: Record<string, unknown> }
      | Array<{ title?: string; order?: number; properties: Record<string, unknown> }>;
  };
};
const nls = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
const nlsZh = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package.nls.zh-cn.json'), 'utf8')
) as Record<string, string>;

const blocks = Array.isArray(pkg.contributes.configuration)
  ? pkg.contributes.configuration
  : [pkg.contributes.configuration];

/** manifest 里标题是 %key% 占位形态,比对/查 nls 前先去包裹 */
const unwrapNlsKey = (title: string | undefined): string =>
  (title ?? '').replace(/^%([^%]+)%$/, '$1');

const EXPECTED_GROUPS: Array<{ key: string; en: string; zh: string }> = [
  { key: 'kbengine.configuration.performance.title', en: 'Performance', zh: '性能与监控' },
  { key: 'kbengine.configuration.semantic.title', en: 'Semantic Checks', zh: '语义检查' },
  { key: 'kbengine.configuration.python.title', en: 'Python Language Service', zh: 'Python 语言服务' },
  { key: 'kbengine.configuration.typings.title', en: 'Type Stubs', zh: '类型桩' },
  { key: 'kbengine.configuration.engine.title', en: 'Engine & Project Paths', zh: '引擎与项目路径' },
  { key: 'kbengine.configuration.runtime.title', en: 'Runtime & Hot Reload', zh: '运行时与热更' },
  { key: 'kbengine.configuration.tools.title', en: 'Generator & Tools', zh: '生成与工具' },
  { key: 'kbengine.configuration.general.title', en: 'General & Views', zh: '通用与视图' },
  { key: 'kbengine.configuration.ai.title', en: 'AI', zh: 'AI' }
];

describe('RUST-228 设置分组', () => {
  it('configuration 拆为 9 个带标题块,order 递增,标题走 nls 双语(AI-001 起)', () => {
    expect(blocks).toHaveLength(9);
    expect(blocks.map(block => unwrapNlsKey(block.title))).toEqual(
      EXPECTED_GROUPS.map(group => group.key)
    );
    expect(blocks.map(block => block.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const group of EXPECTED_GROUPS) {
      expect(nls[group.key]).toBe(group.en);
      expect(nlsZh[group.key]).toBe(group.zh);
    }
  });

  it('键集合不丢:聚合后规模不小于拆分前(153 键),无跨块重键', () => {
    const seen = new Set<string>();
    for (const block of blocks) {
      for (const key of Object.keys(block.properties)) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(153);
    expect(seen.has('kbengine.assetsRoot')).toBe(true);
    expect(seen.has('kbengine.python.stubExport')).toBe(true);
    expect(seen.has('kbengine.hotReload.enabled')).toBe(true);
    expect(seen.has('kbengine.receiverNoneDiagnostics')).toBe(true);
  });

  it('七类分组各就各位:分组归属抽检', () => {
    const blockOf = (key: string): string | null => {
      for (const block of blocks) {
        if (key in block.properties) {
          return unwrapNlsKey(block.title);
        }
      }
      return null;
    };
    expect(blockOf('kbengine.metrics.fileReadDetail')).toBe('kbengine.configuration.performance.title');
    expect(blockOf('kbengine.receiverNoneDiagnostics')).toBe('kbengine.configuration.semantic.title');
    expect(blockOf('kbengine.hover.apiDocs')).toBe('kbengine.configuration.python.title');
    expect(blockOf('kbengine.python.stubExport')).toBe('kbengine.configuration.typings.title');
    expect(blockOf('kbengine.core.serverPath')).toBe('kbengine.configuration.engine.title');
    expect(blockOf('kbengine.hotReload.enabled')).toBe('kbengine.configuration.runtime.title');
    expect(blockOf('kbengine.generator.generatePython')).toBe('kbengine.configuration.tools.title');
    expect(blockOf('kbengine.webviewLocale')).toBe('kbengine.configuration.general.title');
  });

  it('plugins 不造空组(PLUG 家族判例:无插件子系统不立分组)', () => {
    for (const block of blocks) {
      expect(Object.keys(block.properties).length).toBeGreaterThan(0);
      const resolved = (nls[unwrapNlsKey(block.title)] ?? unwrapNlsKey(block.title)).toLowerCase();
      expect(resolved).not.toContain('plugin');
    }
  });
});
