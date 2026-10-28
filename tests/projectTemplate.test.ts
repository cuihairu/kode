import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  MINIMAL_PROJECT_TEMPLATE,
  buildProjectCreationPreviewItems,
  listMinimalProjectTemplate,
  planProjectCreation
} from '../src/projectTemplate';
import { identifyProjectLayout } from '../src/projectImport';

// IDE-PRJ-007:最小项目创建模板清单。清单明确新增目录和文件(相对路径
// 逐条列出),plan 对目标根做存在性预检——已有目标冲突时如实上报(命令层
// 拒绝),预览项逐条给准确绝对路径。模板与 DISCOVERY_CONVENTIONS 的
// scripts 布局对齐,建出的空项目可被 identifyProjectLayout 识别(008 前置)。

describe('minimal project template manifest (IDE-PRJ-007)', () => {
  it('lists every new directory and file explicitly, no duplicate paths, parents before children', () => {
    const relatives = MINIMAL_PROJECT_TEMPLATE.map(entry => entry.relativePath);
    // 清单明确:每条相对路径唯一,父目录先于子条目出现
    expect(new Set(relatives).size).toBe(relatives.length);
    for (const relative of relatives) {
      const parent = path.posix.dirname(relative);
      if (parent !== '.') {
        expect(relatives.indexOf(parent)).toBeLessThan(relatives.indexOf(relative));
      }
    }
    // 目录与文件分面齐全,文件条目内容非空
    const directories = MINIMAL_PROJECT_TEMPLATE.filter(entry => entry.kind === 'directory');
    const files = MINIMAL_PROJECT_TEMPLATE.filter(entry => entry.kind === 'file');
    expect(directories.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  it('exposes a defensive copy: mutating the listing does not change the manifest', () => {
    const listing = listMinimalProjectTemplate();
    listing.pop();
    expect(listMinimalProjectTemplate().length).toBe(MINIMAL_PROJECT_TEMPLATE.length);
  });
});

describe('project creation plan (IDE-PRJ-007)', () => {
  it('maps every manifest entry to an exact absolute path under the target root; clean target has no conflicts', () => {
    const plan = planProjectCreation('/ws/newproj', { exists: (): boolean => false });

    expect(plan.targetRoot).toBe('/ws/newproj');
    expect(plan.entries).toHaveLength(MINIMAL_PROJECT_TEMPLATE.length);
    for (const { entry, absolutePath } of plan.entries) {
      expect(absolutePath).toBe(path.join('/ws/newproj', entry.relativePath));
    }
    expect(plan.conflicts).toEqual([]);
  });

  it('reports existing targets as conflicts with exact paths (file target and directory target alike)', () => {
    const existing = new Set<string>();
    for (const entry of listMinimalProjectTemplate()) {
      if (entry.kind === 'directory' && entry.relativePath === 'scripts') {
        existing.add(path.join('/ws/occupied', entry.relativePath));
      }
      if (entry.kind === 'file' && entry.relativePath === 'scripts/entities.xml') {
        existing.add(path.join('/ws/occupied', entry.relativePath));
      }
    }
    const plan = planProjectCreation('/ws/occupied', {
      exists: candidate => existing.has(candidate)
    });

    expect(plan.conflicts.map(conflict => conflict.absolutePath).sort()).toEqual(
      [path.join('/ws/occupied', 'scripts'), path.join('/ws/occupied', 'scripts/entities.xml')].sort()
    );
    for (const conflict of plan.conflicts) {
      expect(conflict.reason).toContain('目标已存在');
      expect(conflict.reason).toContain(conflict.absolutePath);
    }
  });

  it('keeps listing all entries even with conflicts — refusal is the caller reading conflicts', () => {
    const plan = planProjectCreation('/ws/occupied', { exists: (): boolean => true });

    // 冲突如实摊开,清单仍完整(拒绝语义=conflicts 非空,命令层 008 接)
    expect(plan.entries).toHaveLength(MINIMAL_PROJECT_TEMPLATE.length);
    expect(plan.conflicts).toHaveLength(MINIMAL_PROJECT_TEMPLATE.length);
  });
});

describe('project creation preview (IDE-PRJ-007)', () => {
  it('builds one preview item per entry with kind label and exact absolute path', () => {
    const plan = planProjectCreation('/ws/newproj', { exists: (): boolean => false });

    const items = buildProjectCreationPreviewItems(plan);
    expect(items).toHaveLength(plan.entries.length);
    for (let index = 0; index < items.length; index += 1) {
      const { entry, absolutePath } = plan.entries[index];
      expect(items[index].description).toBe(absolutePath);
      if (entry.kind === 'directory') {
        expect(items[index].label).toBe(`新增目录 ${entry.relativePath}`);
      } else {
        expect(items[index].label).toBe(`新增文件 ${entry.relativePath}`);
      }
    }
  });
});

describe('template is importable (IDE-PRJ-008 precondition)', () => {
  it('a materialized template skeleton is recognized by identifyProjectLayout on all three asset faces', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-template-'));
    try {
      for (const entry of listMinimalProjectTemplate()) {
        const target = path.join(base, entry.relativePath);
        if (entry.kind === 'directory') {
          fs.mkdirSync(target, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.content, 'utf8');
        }
      }

      const identification = identifyProjectLayout(base);
      expect(identification.entitiesXml).toBe(path.join(base, 'scripts', 'entities.xml'));
      expect(identification.entityDefsRoot).toBe(path.join(base, 'scripts', 'entity_defs'));
      expect(identification.scriptsRoot).toBe(path.join(base, 'scripts'));
      expect(identification.engineRoot).toBeNull();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
