import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-008 遗漏图派生候选范围表锁:docs/review/2026-10-29-graph-derivation-scope-table.md
// 验收口径:分别记录 defReferenceGraph、entityDependency、compositionRoots、
// entityFlowGraph 的输入与交互入口。

const root = join(__dirname, '..');
const doc = readFileSync(
  join(root, 'docs/review/2026-10-29-graph-derivation-scope-table.md'),
  'utf8'
);

describe('图派生候选范围表(IDE-RST-008)', () => {
  it('五节齐备(四候选+汇总)', () => {
    for (const section of [
      '# 图派生候选范围表',
      '## 1. defReferenceGraph',
      '## 2. entityDependency',
      '## 3. compositionRoots',
      '## 4. entityFlowGraph',
      '## 5. 汇总',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
    expect(doc).toContain('r2-index-inventory');
  });

  it('defReferenceGraph:输入与交互入口在档', () => {
    expect(doc).toContain('kbengine.project.doctor');
    expect(doc).toContain('kbengine.symbolReferences.show');
    expect(doc).toMatch(/findEntityDefsRootFromFile|entities\.xml/);
    expect(doc).toMatch(/defRenamer|F2|重命名/);
    expect(doc).toMatch(/无缓存|不缓存|每次.*重扫/);
  });

  it('entityDependency:输入与交互入口在档(含正则解析事实)', () => {
    expect(doc).toContain('kbengine.dependency.show');
    expect(doc).toMatch(/正则/);
    expect(doc).toMatch(/findFilesAcrossRoots|assetsRoot/);
    expect(doc).toMatch(/maxDepth/);
  });

  it('compositionRoots:输入与交互入口在档(Python 交叉归属+配置闸)', () => {
    expect(doc).toMatch(/kbengine\.python\.enableMroJump|Go-to-Definition|定义跳转/);
    expect(doc).toMatch(/PythonClassIndex/);
    expect(doc).toMatch(/instanceAssignments|实例赋值/);
    expect(doc).toMatch(/rootsEpoch|纪元|single-flight/);
  });

  it('entityFlowGraph:输入与交互入口在档(纯数据层+装配层拆分)', () => {
    expect(doc).toContain('kbengine.flow.show');
    expect(doc).toMatch(/hasCell/);
    expect(doc).toMatch(/PROPERTY_FLAG_BITS|ED_FLAG_BITS|旗标/);
    expect(doc).toMatch(/getDefinitionWorkspaceLayout|definitionWorkspace/);
  });

  it('每件候选都给出 R2 现成/缺口小结', () => {
    expect(doc).toMatch(/缺口/);
    // 四件交互入口均为低频命令/webview/定义跳转,无 hover 热路径(除 Python 定义跳转带缓存)
    expect(doc).toMatch(/低频|命令/);
  });
});
