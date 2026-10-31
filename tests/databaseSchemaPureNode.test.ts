import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// R2-F24(IDE-AUD-051):schema 纯推导与输入收集真正隔离——databaseSchemaCore
// 普通 Node 无 vscode 可导入并运行纯推导。两条证明:
// 1. 静态传递闭包走查:从 databaseSchemaCore.ts 起解析全部相对 import 的
//    闭包(不再只查 import 字符串——直接依赖),闭包内任何文件都不得 import
//    'vscode'(此前经 definitionWorkspace/sharedFileSnapshot 传递依赖);
// 2. 运行时:动态导入 databaseSchemaCore,跑 deriveDatabaseTables 纯推导与
//    parseTypeAliases(注入自备 reader,不经 sharedFileSnapshot)。

const SRC = path.resolve(__dirname, '../src');

/** 相对 import 规格解析到 TS 文件(.ts / .tsx / /index.ts);解析不到返回 null */
function resolveTsModule(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** 从闭包 BFS 出全部非相对 import 规格(vscode 等包面)与可达文件集 */
function collectTransitiveImports(entryFile: string): { packageSpecs: Set<string>; files: Set<string> } {
  const packageSpecs = new Set<string>();
  const files = new Set<string>();
  const queue = [path.resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (!fs.existsSync(file)) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        packageSpecs.add(spec);
        continue;
      }
      const resolved = resolveTsModule(path.resolve(path.dirname(file), spec));
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
  return { packageSpecs, files };
}

describe('databaseSchemaCore Node 隔离 (R2-F24)', () => {
  it('传递依赖闭包不含 vscode(不只查 import 字符串)', () => {
    // 走查器判别力自证:适配层 databaseSchema.ts 确实经定义工作区拖 vscode,
    // 走查必须逮到(否则本测试空转假绿)
    const adapter = collectTransitiveImports(path.join(SRC, 'databaseSchema.ts'));
    expect([...adapter.packageSpecs]).toContain('vscode');

    const { packageSpecs, files } = collectTransitiveImports(path.join(SRC, 'databaseSchemaCore.ts'));
    // 闭包确实走起来了(不止入口自身,防走查空转假绿)
    expect(files.size).toBeGreaterThan(1);
    expect([...packageSpecs]).not.toContain('vscode');
  });

  it('普通 Node 动态导入后可运行纯推导与别名解析(注入 reader)', async () => {
    const core = await import('../src/databaseSchemaCore');

    const source = (p: string) => ({
      filePath: '/defs/entity_defs/Gold.def',
      line: 3,
      path: p,
      category: 'entity' as const
    });
    const derived = core.deriveDatabaseTables({
      entityName: 'Gold',
      defFilePath: '/defs/entity_defs/Gold.def',
      properties: [
        {
          name: 'gold',
          typeName: 'UINT32',
          persistent: true,
          identifier: false,
          scopes: ['base'],
          source: source('Gold')
        }
      ],
      hasCellContent: true,
      tablePrefix: 'tbl_'
    });
    const root = derived.tables.find(t => t.name === 'tbl_Gold');
    expect(root).toBeTruthy();
    expect(root?.fields.map(f => f.name)).toContain('sm_gold');

    // parseTypeAliases 走注入 reader,不经 sharedFileSnapshot(vscode 面)
    const aliases = core.parseTypeAliases('/defs/types.xml', undefined, () => ({
      content: '<root><Vec3>VECTOR3</Vec3></root>',
      source: 'disk',
      version: 1
    }));
    expect(aliases.get('Vec3')).toEqual({ kind: 'builtin', target: 'VECTOR3' });
  });
});
