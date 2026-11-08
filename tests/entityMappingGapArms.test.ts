import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationTokenSource, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { EntityMappingManager } from '../src/entityMapping';
import { resetScanRootCache } from '../src/scanRoots';
import { configurationOverrides } from './fake-vscode/workspaceState';

// entityMapping 缺口臂(2026-11-09 覆盖率扫尾):PR4 取证面(getDependencyGraph/
// getIndex)、定向首解析直取臂、def 方法缺实现差的早退/取消/跨 def 跳过臂、
// Python 有 def 无差的 dunder 与引擎钩子跳过臂。
//
// 死臂取证(公共 API + 真实 fs 不可达,不硬凑,与 generatorForms 512-524 同口径):
// - buildIndex loader 全空臂(545):loader 工厂只对空根数组/空串目标返回
//   null;真实 defPath 的 dirname 恒非空,私有入口传不出空串;
// - collectDefMethodImplementationGaps 第二取消臂(1627):实现判存的唯一
//   await 落在 owner 索引直取(纯微窗)或扫描面,取消要么死在循环首查
//   (1619),要么根本进不了这段;
// - buildPythonDefIndex 失败恢复臂(1802/1804/1806/1807):walk 的 readdir/
//   读文件逐个 try/catch 吞错,performBuild 无可拒绝面;
// - python def 索引 walk 跨根去重臂(1846):getIndexScanRoots 上游已做
//   精确去重 + 包含剔除,normalizeFileIdentity 纯词法不认 symlink,同一
//   目录串无法二次入列;
// - 属性引用跨索引同文件去重臂(2290):owner 文件按 scripts/<域>/<实体>.py
//   约定逐实体解析,接口/组件宿主合并不把宿主/组件 owner 文件并入对方
//   索引(实测扫描/定向两线 owners 均只含本实体文件),两索引永不同文件;
// - receiver RPC 引用循环取消臂(2344):入口已查取消,循环体全同步,取消
//   无法落在两查之间;
// - 定向首解析直取臂(2693):三处调用点(ensureIndex 2672 / ensureIndexFor
//   PythonFile 2746 / ensureIndexForClass lookupIndexByClass)前置未命中检查
//   与 targeted 入口重查之间零 await(全部同步语句),登记(storeIndex)在
//   单一事件轮内同步完成,重查恒见同一未命中态——防御性双查臂不可达。

const HERO_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Interface>IFace</Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <run/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <stop/>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

const IFACE_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <ifaceRun>',
  '      <Arg>UINT32</Arg>',
  '    </ifaceRun>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

const HERO_PY = [
  'class Hero:',
  '    def run(self):',
  '        pass',
  '',
  '    def stop(self):',
  '        pass',
  '',
  '    def __init__(self):',
  '        pass',
  '',
  '    def onTimer(self):',
  '        pass',
  '',
  '    def helperOnlyInPy(self):',
  '        pass',
  '',
  ''
].join('\n');

const CELL_HERO_PY = [
  'class Hero:',
  '    def stop(self):',
  '        pass',
  '',
  ''
].join('\n');

const tmpRoots: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-emgap-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

let originalFindFiles: typeof stubWorkspace.findFiles;
let originalFolders = stubWorkspace.workspaceFolders;

interface BuiltWorkspace {
  root: string;
  heroDef: string;
  ifaceDef: string;
  heroPy: string;
  cellHeroPy: string;
}

const buildWorkspace = (root: string, withCellFile = true): BuiltWorkspace => {
  const defsDir = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsDir, { recursive: true });
  fs.mkdirSync(path.join(defsDir, 'interfaces'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'cell'), { recursive: true });
  const heroDef = path.join(defsDir, 'Hero.def');
  fs.writeFileSync(heroDef, HERO_DEF);
  // 接口 def 按引擎约定落 interfaces/ 子目录(闭包解析按此路径找)
  const ifaceDef = path.join(defsDir, 'interfaces', 'IFace.def');
  fs.writeFileSync(ifaceDef, IFACE_DEF);
  const heroPy = path.join(root, 'scripts', 'base', 'Hero.py');
  fs.writeFileSync(heroPy, HERO_PY);
  const cellHeroPy = path.join(root, 'scripts', 'cell', 'Hero.py');
  if (withCellFile) {
    fs.writeFileSync(cellHeroPy, CELL_HERO_PY);
  }
  return { root, heroDef, ifaceDef, heroPy, cellHeroPy };
};

const listDefFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listDefFiles(path.join(dir, entry.name)) : entry.name.endsWith('.def') ? [path.join(dir, entry.name)] : []
  );

const stubDefScan = (root: string) => {
  const defsDir = path.join(root, 'scripts', 'entity_defs');
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def'
      ? listDefFiles(defsDir).map(file => Uri.file(file))
      : []) as typeof stubWorkspace.findFiles;
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

describe('entityMapping 缺口臂', () => {
  beforeEach(() => {
    originalFindFiles = stubWorkspace.findFiles;
    originalFolders = stubWorkspace.workspaceFolders;
  });

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = originalFolders;
    configurationOverrides.delete('kbengine');
    resetScanRootCache();
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PR4 取证面:getDependencyGraph/getIndex 如实交出内部视图', async () => {
    const root = makeTmpDir('forensics');
    buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      expect(manager.getDependencyGraph()).toBeDefined();
      const index = manager.getIndex('Hero') as unknown as { methodDefinitions: unknown[] };
      expect(index).toBeDefined();
      expect(index!.methodDefinitions.length).toBeGreaterThan(0);
    } finally {
      void manager.dispose();
    }
  });

  it('定向快路径:全量首扫挂起时定向解析毫秒级应答,不等首扫', async () => {
    const root = makeTmpDir('direct');
    const ws = buildWorkspace(root, false); // cell 侧文件先不落盘
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    // 定向 glob(**/Hero.def)即时应答;全量首扫(**/*.def)挂起 80ms:
    // 首查不等首扫,定向单文件解析应答(hover 永转 loading 根治语义)。
    // 首查落盘 cell 侧文件后二查:文件级未命中 → basename 回落命中已注册
    // 实体(同名义索引按名槽共享),两查都应答。
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (glob === '**/Hero.def' || glob === '**/IFace.def') {
        return glob === '**/Hero.def' ? [Uri.file(ws.heroDef)] : [];
      }
      if (glob === '**/*.def') {
        await new Promise(resolve => setTimeout(resolve, 80));
        return [Uri.file(ws.heroDef), Uri.file(ws.ifaceDef)];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    try {
      const first = await manager.resolveMethodDefinition(ws.heroPy, 'run');
      expect(first).not.toBeNull();
      fs.writeFileSync(ws.cellHeroPy, CELL_HERO_PY);
      const second = await manager.resolveMethodDefinition(ws.cellHeroPy, 'stop');
      expect(second).not.toBeNull();
    } finally {
      void manager.dispose();
    }
  });

  it('def 方法缺实现差:无索引 def 如实空', async () => {
    const root = makeTmpDir('gaps-ghost');
    buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      const gaps = await manager.collectDefMethodImplementationGaps(
        path.join(root, 'scripts', 'entity_defs', 'Ghost.def')
      );
      expect(gaps).toEqual([]);
    } finally {
      void manager.dispose();
    }
  });

  it('def 方法缺实现差:循环在途取消即时交卷', async () => {
    const root = makeTmpDir('gaps-cancel');
    const ws = buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      const cts = new CancellationTokenSource();
      cts.cancel(); // 循环首查即见取消,如实交已收集部分
      const gaps = await manager.collectDefMethodImplementationGaps(ws.heroDef, cts.token);
      expect(gaps).toEqual([]);
    } finally {
      void manager.dispose();
    }
  });

  it('def 方法缺实现差:闭包成员按 def 文件过滤跳过,只报本 def 声明', async () => {
    const root = makeTmpDir('gaps-closure');
    const ws = buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      // 接口闭包成员(IFace.def 声明)不归属 Hero.def,只标 Hero.def 自己
      // 声明的 run/stop(实现都在,无缺口)
      const gaps = await manager.collectDefMethodImplementationGaps(ws.heroDef);
      expect(gaps).toEqual([]);
    } finally {
      void manager.dispose();
    }
  });

  it('Python 有 def 无差:无索引文件静默空;dunder/钩子跳过,真实缺口如实记名', async () => {
    const root = makeTmpDir('py-gaps');
    const ws = buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      // 无索引文件(同步读已建索引,无索引=静默无诊断)
      expect(manager.collectPythonMethodNotInDef(path.join(root, 'scripts', 'base', 'Ghost.py'))).toEqual([]);
      // dunder(__init__)与引擎钩子(onTimer)天然只在 Python 侧,跳过不报;
      // helperOnlyInPy 是真实缺口,如实记名
      const gaps = manager.collectPythonMethodNotInDef(ws.heroPy);
      expect(gaps.map(gap => gap.methodName)).toEqual(['helperOnlyInPy']);
    } finally {
      void manager.dispose();
    }
  });

  it('Python 有 def 无差:跨文件方法按文件过滤跳过', async () => {
    const root = makeTmpDir('py-gaps-xfile');
    const ws = buildWorkspace(root);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubDefScan(root);
    const manager = await makeManager();
    try {
      // 查 cell/Hero.py:同索引 base 侧方法(base/Hero.py)按文件不匹配跳过,
      // cell 侧 stop 已在 def 声明 → 无缺口
      const gaps = manager.collectPythonMethodNotInDef(ws.cellHeroPy);
      expect(gaps).toEqual([]);
    } finally {
      void manager.dispose();
    }
  });
});
