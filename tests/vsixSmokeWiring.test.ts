import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// IDE-REL-006 安装后烟测的接线守卫:vsixSmoke.test.ts 的真机烟测不在
// 每次推送的门禁里(需要真打包 + 真 VS Code 宿主),本文件用源级锁保证
// 这条链路不会被无声拆掉——脚本入口、--vsix 装配(打包→解包安装布局→
// 以解包产物为扩展根)、套件过滤、大文件阈值四处任一处被删/被改小,
// 这里先红。行为面的命中断言由 src/test/electron/suite/vsixSmoke.test.ts
// 在 `pnpm run test:smoke:vsix` 里承担。

const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('vsix 烟测接线守卫(IDE-REL-006)', () => {
  it('package.json 暴露 test:smoke:vsix 且指向 runTest --vsix', () => {
    const scripts = JSON.parse(readRepoFile('package.json')).scripts as Record<string, string>;
    const smoke = scripts['test:smoke:vsix'];
    expect(smoke).toBeTruthy();
    expect(smoke).toContain('out/test/electron/runTest.js --vsix');
  });

  it('runTest --vsix:打包→解包安装布局→以解包 extension/ 为扩展根', () => {
    const source = readRepoFile('src/test/electron/runTest.ts');
    expect(source).toContain("process.argv.includes('--vsix')");
    expect(source).toContain("'vsce', 'package', '--no-dependencies'");
    expect(source).toContain("'unzip'");
    expect(source).toContain("path.join(unpackRoot, 'extension')");
    expect(source).toContain("process.env.KODE_VSIX_EXT_DIR = devPath");
    expect(source).toContain("process.env.KODE_VSIX_WORKSPACE = workspacePath");
    expect(source).toContain("process.env.KODE_ELECTRON_SUITE = 'vsix'");
  });

  it('runTest --vsix 生成的大文件保持在 worker 派发阈值(256 KiB)之上', () => {
    const source = readRepoFile('src/test/electron/runTest.ts');
    expect(source).toContain('const SMOKE_PY_MIN_BYTES = 300 * 1024');
    // PYTHON_WORKER_PARSE_THRESHOLD 若被抬高,300 KiB 余量耗尽即需同步调整:
    // 守卫读生产常量原文,阈值改小/改大都会在这里暴露不一致。
    const host = readRepoFile('src/pythonParserWorkerHost.ts');
    expect(host).toContain('export const PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024');
  });

  it('electron 套件过滤把 vsix 模式收到 vsixSmoke.test.js', () => {
    const source = readRepoFile('src/test/electron/suite/index.ts');
    expect(source).toContain("suite === 'vsix'");
    expect(source).toContain("file === 'vsixSmoke.test.js'");
    expect(fs.existsSync(path.join(repoRoot, 'src/test/electron/suite/vsixSmoke.test.ts'))).toBe(true);
  });
});
