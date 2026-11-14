/**
 * KSEM-CFG-01 配置读取路径登记册(纯核心)。
 *
 * 面分组:lane 全量表锁死 / 状态真值表 / 状态不变量自洽 / 层锚点齐备 /
 * 仓库锚点 fs 存在性(杜绝虚构读取器)/ 引擎锚点策展串 / serialization
 * 与 client 诚实面 / 设置声明计数对账。全部纯函数直查+node:fs 校验,
 * 零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_READ_PATH_ENTRIES,
  configReadPathByLane,
  configReadPathStatusSummary,
  repoPathFromAnchor,
} from '../src/backend/configReadPaths';

describe('KSEM-CFG-01 config read path registry', () => {
  it('lane table is locked (7 lanes, fixed order)', () => {
    expect(CONFIG_READ_PATH_ENTRIES.map((e) => e.lane)).toEqual([
      'server-config',
      'fixed-messages',
      'client-config',
      'project-defs',
      'extension-settings',
      'serialization-schema',
      'python-resource-io',
    ]);
  });

  it('status truth table is locked per lane', () => {
    const expected: Record<string, string> = {
      'server-config': 'schema-covered',
      'fixed-messages': 'schema-covered',
      'client-config': 'not-covered',
      'project-defs': 'schema-covered',
      'extension-settings': 'schema-covered',
      'serialization-schema': 'parser-core-only',
      'python-resource-io': 'not-covered',
    };
    for (const entry of CONFIG_READ_PATH_ENTRIES) {
      expect(entry.status, `lane ${entry.lane}`).toBe(expected[entry.lane]);
    }
    expect(configReadPathStatusSummary()).toEqual({
      covered: 4,
      parserCoreOnly: 1,
      docsOnly: 0,
      notCovered: 2,
    });
  });

  it('status invariants are self-consistent for every entry', () => {
    for (const entry of CONFIG_READ_PATH_ENTRIES) {
      const codeReaders = entry.readers.filter(
        (r) => r.role === 'rustCore' || r.role === 'tsCore',
      );
      switch (entry.status) {
        case 'schema-covered':
          expect(codeReaders.length, `lane ${entry.lane} needs a code reader`).toBeGreaterThan(0);
          expect(entry.schemaFaces.length, `lane ${entry.lane} needs schemaFaces`).toBeGreaterThan(0);
          expect(entry.docsOnlyFaces.length, `lane ${entry.lane} must not claim docs-only`).toBe(0);
          break;
        case 'parser-core-only':
          expect(codeReaders.length, `lane ${entry.lane} needs its parser core`).toBeGreaterThan(0);
          expect(entry.schemaFaces.length, `lane ${entry.lane} must not claim wired schema`).toBe(0);
          expect(entry.docsOnlyFaces.length, `lane ${entry.lane} needs docs-only evidence`).toBeGreaterThan(0);
          break;
        case 'docs-only':
          expect(codeReaders.length, `lane ${entry.lane} must have no code reader`).toBe(0);
          expect(entry.docsOnlyFaces.length).toBeGreaterThan(0);
          break;
        case 'not-covered':
          expect(codeReaders.length, `lane ${entry.lane} must not claim a code reader`).toBe(0);
          expect(entry.schemaFaces.length).toBe(0);
          break;
      }
    }
  });

  it('every layer carries a load anchor and logical file', () => {
    for (const entry of CONFIG_READ_PATH_ENTRIES) {
      expect(entry.layers.length, `lane ${entry.lane}`).toBeGreaterThan(0);
      for (const layer of entry.layers) {
        expect(layer.name.length).toBeGreaterThan(0);
        expect(layer.file.length).toBeGreaterThan(0);
        expect(layer.loadAnchor.length, `lane ${entry.lane}/${layer.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('defaults→custom overlay shape is registered on engine lanes', () => {
    expect(configReadPathByLane('server-config')!.layers.map((l) => l.name)).toEqual([
      'defaults',
      'custom',
    ]);
    expect(configReadPathByLane('fixed-messages')!.layers.map((l) => l.name)).toEqual([
      'defaults',
      'custom',
    ]);
    const server = configReadPathByLane('server-config')!;
    expect(server.overlays!.some((o) => o.includes('ConfigResolveOverrides'))).toBe(true);
    expect(server.overlays!.some((o) => o.includes('Final Config'))).toBe(true);
  });

  it('repo reader anchors point at files that exist on disk (no invented readers)', () => {
    const repoRoot = path.resolve(__dirname, '..');
    for (const entry of CONFIG_READ_PATH_ENTRIES) {
      for (const reader of entry.readers) {
        const repoPath = repoPathFromAnchor(reader.anchor);
        if (repoPath === null) {
          continue;
        }
        expect(
          existsSync(path.join(repoRoot, repoPath)),
          `${entry.lane}: repo anchor file missing: ${repoPath}`,
        ).toBe(true);
      }
    }
  });

  it('engine anchors carry the curated verified strings', () => {
    const all = JSON.stringify(CONFIG_READ_PATH_ENTRIES);
    for (const curated of [
      'kbemain.h:71',
      'kbemain.h:74',
      'docs/knowledge/startup-flow-and-stack.md:54',
      'serverconfig.cpp:104',
      'fixed_messages.cpp:29-74',
      'client_lib/kbemain.h:57-102',
      'client_lib/config.cpp:50',
      'api-core-concepts.md:56',
    ]) {
      expect(all.includes(curated), `missing curated engine anchor: ${curated}`).toBe(true);
    }
  });

  it('serialization lane is honest: parser core only, wiring is docs-only', () => {
    const entry = configReadPathByLane('serialization-schema')!;
    expect(entry.status).toBe('parser-core-only');
    expect(entry.readers.some((r) => r.anchor.includes('jsonChainPropagation.ts:78'))).toBe(true);
    expect(
      entry.readers.some((r) => r.anchor.includes('无文件发现/读取接线')),
    ).toBe(true);
    expect(entry.docsOnlyFaces.some((f) => f.includes('ksem-ser-08-project-schema-design.md'))).toBe(
      true,
    );
    expect(entry.notes!.some((n) => n.includes('勿称已有读取器'))).toBe(true);
  });

  it('client lane is honest: engine reads it, extension has no reader', () => {
    const entry = configReadPathByLane('client-config')!;
    expect(entry.status).toBe('not-covered');
    expect(entry.readers.every((r) => r.role === 'engine')).toBe(true);
    expect(entry.notes!.some((n) => n.includes('无 TS/Rust 读取面'))).toBe(true);
  });

  it('python lane names resource IO primitives, no dedicated config API claimed', () => {
    const entry = configReadPathByLane('python-resource-io')!;
    expect(entry.status).toBe('not-covered');
    expect(
      entry.layers[0].loadAnchor.includes('getResFullPath'),
    ).toBe(true);
    expect(entry.notes!.some((n) => n.includes('无专门配置对象 API'))).toBe(true);
  });

  it('settings declaration count matches package.json (drift gate)', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    expect(Object.keys(props).length).toBeGreaterThanOrEqual(140);
    expect(props['kbengine.assetsRoot']).toBeDefined();
    expect(props['kbengine.entityDefsPath']).toBeDefined();
    const entry = configReadPathByLane('extension-settings')!;
    expect(entry.layers[0].loadAnchor.includes('getConfiguration("kbengine")')).toBe(true);
  });

  it('repoPathFromAnchor extraction faces', () => {
    expect(repoPathFromAnchor('src/a.ts:12 do thing')).toBe('src/a.ts');
    expect(repoPathFromAnchor('crates/kode-parser/src/config.rs:131 parse_config')).toBe(
      'crates/kode-parser/src/config.rs',
    );
    expect(repoPathFromAnchor('package.json:195 contributes')).toBe('package.json');
    expect(repoPathFromAnchor('kbemain.h:71 loadConfig')).toBeNull();
    expect(repoPathFromAnchor('kbe/src/lib/server/kbemain.h:66-75 docs')).toBeNull();
    expect(repoPathFromAnchor('client_lib/config.cpp:50 Config::loadConfig')).toBeNull();
    expect(repoPathFromAnchor('docs/knowledge/api-core-concepts.md:56 primitives')).toBeNull();
    expect(repoPathFromAnchor('KBEngine.open/hasRes primitives')).toBeNull();
    expect(repoPathFromAnchor('serverconfig.cpp:104 entry')).toBeNull();
  });
});
