import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { IndexScheduler, IndexTaskSpec } from '../src/indexScheduler';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 按需加载截断回归(审核发现 :183):stageRequestFiles 曾把「import 候选 + 同目录
// 兄弟」合并成一个 targets 集合后按插入序截 64——导入较多的文件,靠后的真实
// 依赖被静默跳过,首查 ① 静态 MRO 落空,只能等全量扫描收敛后重查。
// 修复后:import 派生候选全量补载(不截断),兄弟目录候选保留 64 上限(显式口径)。

const MODULE_COUNT = 80;

/** 全部 full-reindex 分块注入失败:断绝「pass2 等全量收敛重查」的救场路径,
 * 让 ① 静态 MRO 必须靠按需补载命中——旧截断行为在此用例下必红。 */
class FailAllChunksScheduler extends IndexScheduler {
  failedChunks = 0;
  override enqueue(spec: IndexTaskSpec) {
    if (spec.kind !== 'full-reindex') {
      return super.enqueue(spec);
    }
    this.failedChunks += 1;
    return super.enqueue({ ...spec, run: async () => { throw new Error('injected chunk failure'); } });
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  stubWorkspace.findFiles = originalFind;
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});
const originalFind = stubWorkspace.findFiles;

describe('stageRequestFiles 按需补载截断(审核发现 :183)', () => {
  it('导入多于 64 项时靠后的真实依赖仍被补载,首查即命中', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-stage-cap-'));
    temporaryDirectories.push(dir);
    const paths: Record<string, string> = {};
    const imports: string[] = [];
    for (let i = 0; i < MODULE_COUNT; i += 1) {
      const name = `mix${i}`;
      const file = path.join(dir, `${name}.py`);
      fs.writeFileSync(file, 'class RunMixin:\n    def tick(self): pass\n', 'utf8');
      paths[name] = file;
      // 0..78 用模块 import 占位(绑定名互不冲突),79 的类才是真实依赖
      if (i < MODULE_COUNT - 1) {
        imports.push(`import mix${i}`);
      } else {
        imports.push(`from ${name} import RunMixin`);
      }
    }
    const avatarFile = path.join(dir, 'avatar.py');
    fs.writeFileSync(avatarFile, [
      ...imports,
      'class Avatar(RunMixin):',
      '    def run(self):',
      '        self.tick()',
      ''
    ].join('\n'), 'utf8');
    const oldFind = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob: string) =>
      glob === '**/*.py'
        ? [Uri.file(avatarFile), ...Object.values(paths).map(p => Uri.file(p))]
        : []) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex(new FailAllChunksScheduler());
      // 全量扫描被注入失败:唯一出路是 stageRequestFiles 按需补载
      const hit = await index.resolveSelfMethod(avatarFile, 82, 'tick');
      expect(hit, '靠后 import(mix79)必须经按需补载进入索引并命中').not.toBeNull();
      expect(hit!.filePath).toBe(paths.mix79);
      expect(hit!.className).toBe('RunMixin');
    } finally {
      stubWorkspace.findFiles = oldFind;
    }
  }, 20000);
});
