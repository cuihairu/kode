import { describe, expect, it } from 'vitest';
import {
  analyzeRawLegacyModuleEntries,
  buildRequestPreviewRows,
  LEGACY_MODULE_PLACEHOLDER,
  previewDefaultHotfixModule,
  rewriteRawEntryLegacyModule,
  spliceMigratedEntry
} from '../src/backend/hotReloadRequestPreview';
import type { HttpRequestEntry } from '../src/backend/httpRequests';

// HR-MOD-013 纯核钉:预览=只构造不发送(停用条目如实列出带原因,绝不静默
// 丢弃)+三名字并列(双名/legacy 同面);迁移=扫描原始条目 ${module} 分布,
// 建议只在 scriptRoot 已配置时给;改写只动确认条目模板字符串,其余字段与
// 其余条目逐字保留(不静默篡改=纯核零写配置,写入只经装配层显式确认)。

const FILE = '/ws/scripts/entities/fight/FightAI.py';
const probe = (dirs: string[]) => {
  const set = new Set(dirs);
  return (dirPath: string): boolean => set.has(dirPath);
};

const entryOf = (overrides: Partial<HttpRequestEntry> = {}): HttpRequestEntry => ({
  name: '热更新',
  url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'module_name=${module}',
  enabled: true,
  keybinding: '',
  ...overrides
});

describe('buildRequestPreviewRows(只构造不发送)', () => {
  it('条目行=模板替换后的请求形状;停用条目如实列出带原因,不静默丢弃', () => {
    const rows = buildRequestPreviewRows({
      file: FILE,
      entries: [
        entryOf(),
        entryOf({ name: '停用请求', enabled: false, url: 'http://x/${module}' })
      ],
      scriptRoot: '/ws/scripts',
      isPackageDir: probe(['/ws/scripts/entities', '/ws/scripts/entities/fight'])
    });
    expect(rows).toHaveLength(3); // 两条目+默认热更面
    const active = rows[0];
    expect(active.name).toBe('热更新');
    expect(active.skippedReason).toBeUndefined();
    expect(active.url).toBe('http://127.0.0.1:8090/hotfix?module_name=entities.fight.FightAI');
    expect(active.body).toBe('module_name=entities.fight.FightAI');
    // 三名字并列:双名(scriptRoot 配置才可解)+legacy 包边界语义
    expect(active.moduleNames.fullModule).toBe('entities.fight.FightAI');
    expect(active.moduleNames.requestModule).toBe('fight.FightAI');
    expect(active.moduleNames.legacyModule).toBe('entities.fight.FightAI');

    const disabled = rows[1];
    expect(disabled.name).toBe('停用请求');
    expect(disabled.skippedReason).toBe('条目停用(enabled=false),不参与运行');
    expect(disabled.url).toBe('http://x/entities.fight.FightAI'); // 模板形状照常给

    const defaultFace = rows[2];
    expect(defaultFace.name).toBe('零配置默认热更面');
    expect(defaultFace.url).toContain('module_name=entities.fight.FightAI');
  });

  it('无活动文件:空行集(不猜文件);未配 scriptRoot:双名如实空串,legacy 照常', () => {
    expect(buildRequestPreviewRows({ file: '', entries: [entryOf()], scriptRoot: '' })).toEqual([]);
    const rows = buildRequestPreviewRows({ file: FILE, entries: [entryOf()], scriptRoot: '' });
    expect(rows[0].moduleNames.fullModule).toBe('');
    expect(rows[0].moduleNames.requestModule).toBe('');
    // legacy 语义不依赖 scriptRoot;无探针=无包段可收,裸名
    expect(rows[0].moduleNames.legacyModule).toBe('FightAI');
    expect(rows[0].url).toContain('module_name=FightAI');
  });

  it('HR-MOD-008 开关进默认热更面预览:根直下文件键开=裸短名,键关=回落包扫描', () => {
    const base = {
      file: '/ws/scripts/Lone.py',
      entries: [],
      scriptRoot: '/ws/scripts',
      isPackageDir: probe(['/ws/scripts'])
    };
    const off = buildRequestPreviewRows({ ...base, allowRootLevelStem: false });
    expect(off[0].url).toContain('module_name=scripts.Lone');
    const on = buildRequestPreviewRows({ ...base, allowRootLevelStem: true });
    expect(on[0].url).toContain('module_name=Lone');
    expect(previewDefaultHotfixModule('/ws/scripts/Lone.py', {
      scriptRoot: '/ws/scripts',
      isPackageDir: probe(['/ws/scripts']),
      allowRootLevelStem: true
    })).toBe('Lone');
  });
});

describe('analyzeRawLegacyModuleEntries(原始条目扫描)', () => {
  it('url/body/headers 值里的 ${module} 分布如实计数;非数组/非对象条目如实跳过', () => {
    const analysis = analyzeRawLegacyModuleEntries([
      {
        name: '热更新',
        url: `http://x/hotfix?m=${LEGACY_MODULE_PLACEHOLDER}`,
        body: `m=${LEGACY_MODULE_PLACEHOLDER}&n=${LEGACY_MODULE_PLACEHOLDER}`,
        headers: { 'X-M': LEGACY_MODULE_PLACEHOLDER, 'X-Ok': 'clean' }
      },
      'junk-string',
      42,
      { name: '干净条目', url: 'http://x/${fullModule}' }
    ]);
    expect(analysis.canSuggest).toBe(true);
    expect(analysis.usages).toHaveLength(1);
    const usage = analysis.usages[0];
    expect(usage.index).toBe(0);
    expect(usage.name).toBe('热更新');
    expect(usage.total).toBe(4);
    expect(usage.fields).toEqual([
      { field: 'url', count: 1 },
      { field: 'body', count: 2 },
      { field: 'header', key: 'X-M', count: 1 }
    ]);
  });

  it('无占位/未配置:usages 空;建议门=分析面本身可给,写入门=装配层 scriptRoot 检查', () => {
    expect(analyzeRawLegacyModuleEntries(undefined).usages).toEqual([]);
    expect(analyzeRawLegacyModuleEntries('not-array').usages).toEqual([]);
    expect(analyzeRawLegacyModuleEntries([]).usages).toEqual([]);
    expect(analyzeRawLegacyModuleEntries([{ name: 'a', url: 'clean' }]).usages).toEqual([]);
  });
});

describe('rewriteRawEntryLegacyModule + spliceMigratedEntry(只动确认条目)', () => {
  it('改写只换 ${module}→${fullModule};其余字段逐字保留;无占位=原样(changed 空)', () => {
    const raw = {
      name: '热更新',
      url: `http://x/hotfix?m=${LEGACY_MODULE_PLACEHOLDER}`,
      body: `m=${LEGACY_MODULE_PLACEHOLDER}`,
      headers: { 'X-M': LEGACY_MODULE_PLACEHOLDER, 'X-Keep': 'v' },
      enabled: false,
      keybinding: 'ctrl+9',
      customField: { deep: 'intact' }
    };
    const { next, changedFields } = rewriteRawEntryLegacyModule(raw);
    expect(changedFields).toEqual(['url', 'body', 'headers']);
    expect(next.url).toBe('http://x/hotfix?m=${fullModule}');
    expect(next.body).toBe('m=${fullModule}');
    expect(next.headers).toEqual({ 'X-M': '${fullModule}', 'X-Keep': 'v' });
    // 其余字段逐字保留(含解析器不认识的自定义字段)
    expect(next.enabled).toBe(false);
    expect(next.keybinding).toBe('ctrl+9');
    expect(next.customField).toEqual({ deep: 'intact' });
    expect(next.name).toBe('热更新');

    const clean = rewriteRawEntryLegacyModule({ name: 'a', url: 'no-placeholder' });
    expect(clean.changedFields).toEqual([]);
    expect(clean.next).toEqual({ name: 'a', url: 'no-placeholder' });
  });

  it('splice 按索引放回:其余元素同一引用逐字保留;越界如实返回副本', () => {
    const a = { name: 'a' };
    const b = { name: 'b' };
    const migrated = { name: 'b', url: 'new' };
    const out = spliceMigratedEntry([a, b], 1, migrated);
    expect(out[0]).toBe(a); // 同一引用=逐字保留
    expect(out[1]).toBe(migrated);
    expect(spliceMigratedEntry([a], 5, migrated)).toEqual([a]);
    expect(spliceMigratedEntry([a], -1, migrated)).toEqual([a]);
  });
});
