// 扩展宿主内 mocha 运行器(真机层):收集同目录 *.test.js 并执行,
// 失败即非零退出,由 runTest.ts 的 runTests 回传。
import * as path from 'path';
import * as glob from 'glob';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;

  for (const file of glob.sync('**/*.test.js', { cwd: testsRoot })) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} 个真机用例失败`));
        return;
      }

      resolve();
    });
  });
}
