import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { patternGlob } from './helpers/findPattern';

// 负缓存回归(2026-10-16「加载很久」修复):已确认「无 .def 归属」的 .py
// 再次跳转不得触发重扫——修复前每次跳转在 property/method 两处各全量重扫
// 一遍 findFiles('**/*.def') + 逐个解析,是每跳秒级卡顿的第二来源。

const originalFindFiles = stubWorkspace.findFiles;

describe('EntityMappingManager 负缓存(无归属文件不再重扫)', () => {
  it('重复 miss 复用负缓存，新文件定向发现但不重扫全仓', async () => {
    // 扫描根按"目录真实存在"过滤 getIndexScanRoots(2026-11-23 收窄:根下还须
    // 有 scripts/,否则该文件夹不贡献根),占位路径 /ws 在任何平台上都不落盘
    // → 根集合为空、构造期扫描早退,负缓存断言无从谈起。tmpdir 真目录 + 按收
    // 窄根建 scripts/ 子目录,发现走 scoped glob(scripts/**/*.def)。
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-negcache-'));
    fs.mkdirSync(path.join(wsRoot, 'scripts'), { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    let defScans = 0;
    const targeted: string[] = [];
    stubWorkspace.findFiles = (async (raw?: unknown) => {
      const glob = patternGlob(raw);
      if (glob.includes('*.def')) {
        defScans += 1;
      }
      if (glob.endsWith('.def') && !glob.includes('*.def')) targeted.push(glob);
      return [];
    }) as typeof stubWorkspace.findFiles;

    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      // 等构造期的首次扫描落地(计数≥1),避免与后续断言竞争
      for (let i = 0; i < 100 && defScans === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(defScans).toBeGreaterThanOrEqual(1);
      await manager.waitForInitialScan();

      // 第一次:miss → 触发一次重扫 → 记入负缓存
      expect(await manager.resolveMethodDefinition('/nowhere/Foo.py', 'run')).toBeNull();
      expect(await manager.resolvePropertyDefinition('/nowhere/Foo.py', 'hp')).toBeNull();
      const afterFirst = defScans;

      // 同文件再跳(方法/属性多次)→ 负缓存命中,不再重扫
      expect(await manager.resolveMethodDefinition('/nowhere/Foo.py', 'run')).toBeNull();
      expect(await manager.resolvePropertyDefinition('/nowhere/Foo.py', 'hp')).toBeNull();
      expect(defScans, '同文件重复 miss 不得再重扫').toBe(afterFirst);

      // 另一个未见过的文件做定向发现，不重新全仓扫描。
      expect(await manager.resolveMethodDefinition('/nowhere/Other.py', 'run')).toBeNull();
      expect(defScans).toBe(afterFirst);
      // 收窄后定向发现发 scoped glob(scripts/**/Other.def),按实体名尾段匹配
      expect(targeted.some(pattern => pattern.endsWith('/Other.def'))).toBe(true);

      manager.dispose();
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
