// PR5 去全仓阻塞专项:
// ③ 组合根构建缓存(mtime 内容缓存,同批 XML/def 只读一次,指标断言);
// ④ 显式版本轴 + PR4 依赖图裁断失效(类/基类/方法/MRO/组合根);
// ⑤ 删除/重命名/基类变更后旧索引项移除(跳转不到已不存在位置);
// ① 首扫接管面:发现任务经 IndexScheduler keyed 单例,分块后台解析。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  COMPOSITION_ROOTS_NODE,
  PythonClassIndex
} from '../src/pythonClassIndex';
import { IndexScheduler } from '../src/indexScheduler';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { makeTextDocument } from './helpers/vscodeStub';

const makeRoot = (files: Record<string, string>): { dir: string; paths: Record<string, string>; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pr5-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    paths[name] = full;
  }
  return { dir, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const pointWorkspaceAt = (dir: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
};

const stubFindFiles = (routing: (pattern: string) => string[]): void => {
  stubWorkspace.findFiles = (async (pattern?: string) =>
    routing(String(pattern ?? '')).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
};

const ASSET_FILES = {
  'entities.xml': '<?xml version="1.0"?><entities><Avatar/></entities>',
  'types.xml': '<types><VECTOR3>FLOAT32</VECTOR3></types>',
  'Avatar.def': '<root><Properties><name><Type>VECTOR3</Type></name></Properties></root>',
  'Avatar.py': 'class Avatar:\n\tdef onTimer(self):\n\t\treturn 0\n',
  'bridge.py': 'avatar_instance = Avatar()\n'
};

const MIXIN_FILES = {
  'a.py': 'class Alpha:\n\tdef meth(self):\n\t\tpass\n',
  'b.py': 'class Beta(Alpha):\n\tdef run(self):\n\t\tself.meth()\n'
};

describe('PR5 ③ 组合根构建缓存(同批 XML/def 只读一次 + 指标断言)', () => {
  it('重派生命中 mtime 内容缓存,不再重读未变更 XML/def', async () => {
    const { dir, paths, cleanup } = makeRoot(ASSET_FILES);
    pointWorkspaceAt(dir);
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob === 'entities.xml') { return [paths['entities.xml']]; }
      if (glob === 'types.xml') { return [paths['types.xml']]; }
      if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
      if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
      return [];
    });
    const realRead = fs.promises.readFile.bind(fs.promises);
    const xmlDefReads: string[] = [];
    fs.promises.readFile = (async (file: Parameters<typeof realRead>[0], ...rest: unknown[]) => {
      const target = String(file);
      if (/\.(xml|def)$/.test(target)) {
        xmlDefReads.push(target);
      }
      return (realRead as (f: Parameters<typeof realRead>[0], ...r: unknown[]) => Promise<string>)(file, ...rest);
    }) as typeof fs.promises.readFile;

    try {
      resetLanguageServiceMetrics();
      const index = new PythonClassIndex();
      // 预热全量:后台首扫完成后组合根派生不再被分块解析的赋值签名变化打断
      await index.findClassesByName('Avatar');
      // 首次派生:三个元数据文件各读一次
      expect(await index.rootsContaining('Avatar')).toContain('Avatar');
      const firstBuildReads = xmlDefReads.length;
      expect(firstBuildReads).toBe(3);

      // .def 记录在依赖图 → 定向失效 → 重派生:未变更文件全部走缓存,零重读
      index.invalidate(paths['Avatar.def'], 'change');
      expect(await index.rootsContaining('Avatar')).toContain('Avatar');
      expect(xmlDefReads.length, '重派生不得重读未变更 XML/def').toBe(firstBuildReads);
      const summary = getOperationSummary('python-composition-roots');
      expect(summary, '组合根派生指标已采集').not.toBeNull();
      expect(summary!.cacheHits, '指标断言:缓存命中计数 > 0').toBeGreaterThan(0);
      // 缓存内容正确性:改盘后 mtime 变化,必须真重读
      fs.writeFileSync(paths['entities.xml'], '<?xml version="1.0"?><entities><Avatar/><Monster/></entities>', 'utf8');
      index.invalidate(paths['entities.xml'], 'change');
      expect(await index.rootsContaining('Monster')).toContain('Monster');
      expect(xmlDefReads.length).toBeGreaterThan(firstBuildReads);
    } finally {
      fs.promises.readFile = realRead;
      stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [];
      cleanup();
    }
  });
});

describe('PR5 ④ 显式版本轴 + PR4 依赖图裁断失效', () => {
  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
  });

  it('方法/基类/类集变更只递增对应版本轴', async () => {
    const { dir, cleanup } = makeRoot({
      'thing.py': 'class Thing:\n\tdef alpha(self):\n\t\tpass\n'
    });
    pointWorkspaceAt(dir);
    try {
      const index = new PythonClassIndex();
      const doc = (text: string) =>
        makeTextDocument(text, {
          fileName: paths0(dir, 'thing.py'),
          languageId: 'python',
          uri: Uri.file(paths0(dir, 'thing.py'))
        }) as never;
      await index.onDocumentChanged(doc('class Thing:\n\tdef alpha(self):\n\t\tpass\n'));
      const afterCreate = index.getIndexVersions();
      expect(afterCreate.classes).toBeGreaterThan(0);
      expect(afterCreate.bases).toBeGreaterThan(0);
      expect(afterCreate.methods).toBeGreaterThan(0);
      expect(afterCreate.mro).toBe(0); // 首次解析无前版对比,MRO 未动

      // 只加方法:methods/mro 动,classes/bases 不动
      await index.onDocumentChanged(doc('class Thing:\n\tdef alpha(self):\n\t\tpass\n\tdef beta(self):\n\t\tpass\n'));
      const afterMethod = index.getIndexVersions();
      expect(afterMethod.methods).toBe(afterCreate.methods + 1);
      expect(afterMethod.mro).toBe(afterCreate.mro + 1);
      expect(afterMethod.classes).toBe(afterCreate.classes);
      expect(afterMethod.bases).toBe(afterCreate.bases);

      // 改基类(标识符基类;object 被解析器排除不算):bases/mro 动,classes/methods 不动
      await index.onDocumentChanged(doc('class Thing(Base):\n\tdef alpha(self):\n\t\tpass\n\tdef beta(self):\n\t\tpass\n'));
      const afterBase = index.getIndexVersions();
      expect(afterBase.bases).toBe(afterMethod.bases + 1);
      expect(afterBase.mro).toBe(afterMethod.mro + 1);
      expect(afterBase.classes).toBe(afterMethod.classes);
      expect(afterBase.methods).toBe(afterMethod.methods);
    } finally {
      cleanup();
    }
  });

  it('组合根失效按依赖图裁断:记录在案的 .def 才作废,无关文件不波及;fullRebuild 恒 false', async () => {
    const { dir, paths, cleanup } = makeRoot(ASSET_FILES);
    pointWorkspaceAt(dir);
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob === 'entities.xml') { return [paths['entities.xml']]; }
      if (glob === 'types.xml') { return [paths['types.xml']]; }
      if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
      if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
      return [];
    });
    try {
      const index = new PythonClassIndex();
      // 预热全量,避免后台分块解析与组合根派生竞争(见 ③ 用例注释)
      await index.findClassesByName('Avatar');
      await index.rootsContaining('Avatar'); // 建组合根 + 记录依赖边
      const before = index.getIndexVersions();

      // 依赖图:组合根派生物 dependsOn entities.xml/.def/types.xml(±赋值桥 py)
      const graph = index.getDependencyGraph();
      const plan = graph.planInvalidation(paths['Avatar.def'], 'change');
      expect(plan.invalidateFiles).toContain(COMPOSITION_ROOTS_NODE);
      expect(plan.fullRebuild).toBe(false);

      index.invalidate(paths['Avatar.def'], 'change');
      expect(index.getIndexVersion('compositionRoots')).toBeGreaterThan(before.compositionRoots);

      // 无关文件(未记录依赖):不动组合根,也不动类索引
      const afterDef = index.getIndexVersions();
      index.invalidate(path.join(dir, 'unrelated.xml'), 'change');
      expect(index.getIndexVersion('compositionRoots')).toBe(afterDef.compositionRoots);
      expect(index.getIndexVersion('classes')).toBe(afterDef.classes);

      // 无实例赋值的普通 py 删除:类集变化,但组合根不因它重建(赋值桥未变)
      index.invalidate(paths['Avatar.py'], 'delete');
      expect(index.getIndexVersion('classes')).toBeGreaterThan(afterDef.classes);
    } finally {
      stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
      cleanup();
    }
  });
});

const routePy = (paths: string[]) => stubFindFiles(pattern => {
  if (String(pattern).includes('*.py')) { return paths; }
  return [];
});

describe('PR5 ⑤ 删除/重命名/基类变更后旧索引项移除', () => {

  afterEach(() => {
    stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [];
  });

  it('重命名文件:旧路径类移除,跳转只落新路径', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const index = new PythonClassIndex();
      await index.findClassesByName('Beta'); // 全量扫描后台化后的全量口径入口
      expect((await index.findClassesByName('Alpha')).map(cls => cls.filePath)).toEqual([paths['a.py']]);

      // rename = 旧路径 delete + 新路径入发现面
      fs.renameSync(paths['a.py'], path.join(dir, 'a2.py'));
      routePy([path.join(dir, 'a2.py'), paths['b.py']]);
      index.invalidate(paths['a.py'], 'delete');
      const alpha = await index.findClassesByName('Alpha');
      expect(alpha.map(cls => cls.filePath)).toEqual([path.join(dir, 'a2.py')]);
      // 跳转不得落在已不存在的旧位置
      const loc = await index.resolveSelfMethod(paths['b.py'], 2, 'meth');
      expect(loc, '重命名后仍应解析到 Alpha.meth').not.toBeNull();
      expect(loc!.filePath).toBe(path.join(dir, 'a2.py'));
      expect(loc!.filePath).not.toBe(paths['a.py']);
    } finally {
      cleanup();
    }
  });

  it('删除文件:旧索引项移除,不再命中;基类变更后 MRO 随新基类走', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const index = new PythonClassIndex();
      await index.findClassesByName('Beta');
      expect(await index.computeMRO('Beta')).toEqual(['Beta', 'Alpha']);

      // ① 删除 Alpha 定义文件 → 类移除、MRO 收缩、跳转落空
      fs.rmSync(paths['a.py'], { force: true });
      routePy([paths['b.py']]);
      index.invalidate(paths['a.py'], 'delete');
      expect(await index.findClassesByName('Alpha')).toEqual([]);
      expect(await index.computeMRO('Beta')).toEqual(['Beta']);
      expect(await index.resolveSelfMethod(paths['b.py'], 2, 'meth')).toBeNull();

      // ② 基类变更 Beta(Alpha) → Beta(Gamma):新 MRO 生效,跳到新基类实现
      fs.writeFileSync(paths['b.py'], 'class Beta(Gamma):\n\tdef run(self):\n\t\tself.meth()\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'g.py'), 'class Gamma:\n\tdef meth(self):\n\t\treturn 1\n', 'utf8');
      routePy([paths['b.py'], path.join(dir, 'g.py')]);
      // 新文件落盘走 create 失效(真实 watcher onDidCreate 同路径):换代后全量
      // 口径 API 重新发现;onFileChanged 只重读被编辑的 b.py 本身
      index.invalidate(path.join(dir, 'g.py'), 'create');
      await index.onFileChanged(paths['b.py']);
      expect((await index.computeMRO('Beta'))).toContain('Gamma');
      expect((await index.computeMRO('Beta'))).not.toContain('Alpha');
      const loc = await index.resolveSelfMethod(paths['b.py'], 2, 'meth');
      expect(loc, '基类变更后应跳到 Gamma.meth').not.toBeNull();
      expect(loc!.filePath).toBe(path.join(dir, 'g.py'));
      expect(loc!.className).toBe('Gamma');
    } finally {
      cleanup();
    }
  });
});

describe('PR5 ① 首扫接管面(调度器 keyed 发现 + 分块后台解析)', () => {
  it('注入共享调度器:发现任务 keyed 完成,分块任务计入 completed', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const scheduler = new IndexScheduler();
      const index = new PythonClassIndex(scheduler);
      await index.findClassesByName('Beta'); // 等全量扫描完成(全量口径 API)
      const status = scheduler.getStatus();
      expect(status.keyedTasks['python-file-discovery#0'], '发现任务经调度器 keyed 单例完成')
        .toBe('completed');
      expect(status.completed, '分块解析任务计入调度器完成数').toBeGreaterThan(0);
      expect(status.failed).toBe(0);
    } finally {
      cleanup();
    }
  });
});

function paths0(dir: string, name: string): string {
  return path.join(dir, name);
}
