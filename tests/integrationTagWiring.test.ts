import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// C-10(V-07·c)集成 tag 接线锁。集成套件依赖真引擎源码树 / 真实 demo 脚本检出,
// 只有有树环境才出真结果。此锁钉死接线本身,防三件事悄悄漂移:
// ① 集成清单里的文件都真实存在且自带树守卫——缺席时出可见 skip 而不红
//   (675e805 的教训:检出缺席不得让流水线变红);
// ② 集成配置的 vscode 替身与主门禁同一份,装配口径不分裂;
// ③ 集成 workflow 不接 push/PR 触发(通用 runner 上只能全量 skip),
//   也不含任何发包 / 发 tag 步骤(版本发布红线:版本号只能由用户手动给出)。

const root = join(__dirname, '..');
const integrationConfig = readFileSync(join(root, 'vitest.integration.config.ts'), 'utf8');
const mainConfig = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
const ciYml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const integrationYml = readFileSync(join(root, '.github', 'workflows', 'engine-integration.yml'), 'utf8');

// 只收 .test.ts——alias 行里也有 'tests/helpers/vscodeStub.ts',不收进来当套件
const includedSuites = [...integrationConfig.matchAll(/'(tests\/[^']+\.test\.ts)'/g)].map(match => match[1]);

const TREE_GUARD = /describeWithEngineTree|describe\.skipIf|\bskipIf\(/;

describe('集成 tag 接线', () => {
  it('集成清单非空,每个文件都存在且自带树守卫', () => {
    expect(includedSuites.length).toBeGreaterThanOrEqual(4);
    const missing = includedSuites.filter(suite => !existsSync(join(root, suite)));
    expect(missing, `集成清单指向不存在的文件: ${missing.join(', ')}`).toEqual([]);
    const unguarded = includedSuites.filter(suite => !TREE_GUARD.test(readFileSync(join(root, suite), 'utf8')));
    expect(unguarded, `无树守卫的套件进不了集成清单(缺席时会红): ${unguarded.join(', ')}`).toEqual([]);
  });

  it('集成配置与主门禁共用同一 vscode 替身,主门禁收全量测试', () => {
    const aliasTarget = "path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')";
    expect(integrationConfig).toContain(aliasTarget);
    expect(mainConfig).toContain(aliasTarget);
    expect(mainConfig).toContain("include: ['tests/**/*.test.ts']");
    // 集成配置必须是显式清单,不得退回主门禁的全量通配(否则失去「集成 tag」意义)
    expect(integrationConfig).not.toContain("'tests/**/*.test.ts'");
    expect(ciYml).not.toContain('vitest.integration.config.ts');
  });

  it('根目录 vitest 配置都在 tsconfig.exclude 内(否则 tsc -p ./ 报 TS6059)', () => {
    // C-10 加 vitest.integration.config.ts 时踩过:该文件在 rootDir(src)之外,
    // 未进 exclude 就让 vscode:prepublish 的 tsc -p ./ 直接失败
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { rootDir: string };
      exclude: string[];
    };
    expect(tsconfig.compilerOptions.rootDir).toBe('src');
    const rootConfigs = readdirSync(root).filter(name => /^vitest.*config\.ts$/.test(name));
    expect(rootConfigs).toEqual(
      expect.arrayContaining(['vitest.config.ts', 'vitest.integration.config.ts'])
    );
    for (const config of rootConfigs) {
      expect(tsconfig.exclude, `${config} 不在 tsconfig.exclude,tsc -p ./ 会报 TS6059`).toContain(config);
    }
  });

  it('集成 workflow 只手动/定时触发,不含发包或发 tag 步骤', () => {
    expect(integrationYml).toContain('workflow_dispatch');
    expect(integrationYml).toContain('vitest.integration.config.ts');
    // 不接 push / pull_request:通用 runner 上没有树,接了只能全量 skip
    expect(integrationYml, '集成 workflow 不得接 push 触发').not.toMatch(/^  push:/m);
    expect(integrationYml, '集成 workflow 不得接 pull_request 触发').not.toMatch(/^  pull_request:/m);
    // 版本发布红线:版本号 / Release / Marketplace 一律不在本 workflow
    for (const forbidden of ['gh release', 'npm publish', 'vsce publish', 'gh workflow run publish']) {
      expect(integrationYml, `集成 workflow 含发布步骤: ${forbidden}`).not.toContain(forbidden);
    }
    expect(integrationYml).toContain('contents: read');
  });
});
