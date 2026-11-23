// MRO-CHAIN 验收(用户令 2026-11-18「mixin 遍历调用的执行顺序推导,先在
// demo 实现,再补全验证」):
// ①核心对拍=python3 真跑:demo fixture(training mixin 族 onCrossDay 钩子)
//   以 for cls in type(self).__mro__ 遍历调度的真实执行序,与
//   pythonClassIndex.resolveMroMethodChains 静态推导序逐项相等;
// ②demo 真值:TrainingAvatar 根链 4 定义者、同名双 DamageMixin
//   (critical.py 覆写 vs damage.py 基类)的 compute_damage 链按 MRO 序;
// ③单定义者不出镜(无顺序可言);④mixin 文件视角=多根两链(反向后代);
// ⑤kbengine.codeLens.mroChain 关掉不出镜;⑥纯核格式化。
import { execFile } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { MroChainCodeLensProvider } from '../src/languageProviders';
import {
  chainPickShapes,
  formatMroChainTitle,
  hasMroChainToPresent
} from '../src/backend/mroChainLens';
import { workspace, configurationOverrides } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri } from './fake-vscode/core';

const DEMO_SCRIPTS = path.resolve(__dirname, 'fixtures/kbengine-demo-assets/scripts');
const execFileAsync = promisify(execFile);

const originalFind = workspace.findFiles;
afterEach(() => {
  workspace.findFiles = originalFind;
  workspace.textDocuments = [];
  configurationOverrides.clear();
  vi.restoreAllMocks();
});

/** 把 demo fixture 的 scripts 树挂进 findFiles 桩(只 .py) */
const stubDemoScripts = (): void => {
  const pyFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); } else if (entry.name.endsWith('.py')) { pyFiles.push(full); }
    }
  };
  walk(DEMO_SCRIPTS);
  workspace.findFiles = (async (glob: string) =>
    glob.endsWith('.py') ? pyFiles.map(file => Uri.file(file)) : []) as typeof workspace.findFiles;
};

const lineOf = (file: string, needle: string): number => {
  const text = fs.readFileSync(file, 'utf8');
  const index = text.indexOf(needle);
  expect(index, `${needle} 不在 ${file}`).toBeGreaterThanOrEqual(0);
  return text.slice(0, index).split('\n').length - 1;
};

const baseName = (file: string): string => path.basename(file);

describe('MRO-CHAIN 纯核格式化', () => {
  const chain = (root: string, names: string[]) => ({
    rootClassName: root,
    entries: names.map(className => ({
      className, filePath: `/${className}.py`, line: 0, character: 0
    }))
  });

  it('hasMroChainToPresent:任一链 ≥2 定义者才出镜,单定义者/空不出', () => {
    expect(hasMroChainToPresent([chain('R', ['A', 'B'])])).toBe(true);
    expect(hasMroChainToPresent([chain('R', ['A']), chain('S', ['B'])])).toBe(false);
    expect(hasMroChainToPresent([])).toBe(false);
  });

  it('formatMroChainTitle:链长+执行序箭头;多根附根数;超 6 项折叠', () => {
    expect(formatMroChainTitle([chain('R', ['A', 'B', 'C'])])).toBe('链 3: A → B → C');
    expect(formatMroChainTitle([chain('R', ['A', 'B']), chain('S', ['A', 'C'])])).toBe('链 2: A → B(+1 根)');
    expect(formatMroChainTitle([chain('R', ['A', 'B', 'C', 'D', 'E', 'F', 'G'])]))
      .toBe('链 7: A → B → C → D → E → … (+2)');
  });

  it('chainPickShapes:序号=执行位次,首项标根,全部链展开', () => {
    const items = chainPickShapes([chain('R', ['A', 'B']), chain('S', ['C'])]);
    expect(items.map(item => item.label)).toEqual(['1. A', '2. B', '1. C']);
    expect(items[0].description).toBe('根 R');
    expect(items[1].description).toBe('');
    expect(items[0].detail).toBe('/A.py:1');
  });
});

describe('MRO-CHAIN demo 真值(training mixin 族 onCrossDay)', () => {
  it('TrainingAvatar 根链:4 定义者按 MRO 序,根入口在最前', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const avatar = path.join(DEMO_SCRIPTS, 'cell/TrainingAvatar.py');
    const defLine = lineOf(avatar, 'def onCrossDay');
    const doc = makeTextDocument(fs.readFileSync(avatar, 'utf8'), { fileName: avatar, languageId: 'python' });
    const chains = await index.resolveMroMethodChains(avatar, defLine, 'onCrossDay', doc);
    expect(chains.length).toBeGreaterThanOrEqual(1);
    const avatarChain = chains.find(chain => chain.rootClassName === 'TrainingAvatar');
    expect(avatarChain, '有 TrainingAvatar 根链').toBeTruthy();
    expect(avatarChain!.entries.map(entry => entry.className))
      .toEqual(['TrainingAvatar', 'HealthMixin', 'HistoryMixin', 'InventoryMixin']);
    // 落点对到文件:mixin 三件各归各文件
    expect(avatarChain!.entries.slice(1).map(entry => baseName(entry.filePath)))
      .toEqual(['health.py', 'history.py', 'inventory.py']);
  });

  it('python3 真跑对拍:遍历 __mro__ 调度 onCrossDay 的真实执行序 == 静态推导序', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const avatar = path.join(DEMO_SCRIPTS, 'cell/TrainingAvatar.py');
    const doc = makeTextDocument(fs.readFileSync(avatar, 'utf8'), { fileName: avatar, languageId: 'python' });
    const chains = await index.resolveMroMethodChains(
      avatar, lineOf(avatar, 'def onCrossDay'), 'onCrossDay', doc
    );
    const derived = chains
      .find(chain => chain.rootClassName === 'TrainingAvatar')!
      .entries.map(entry => entry.className)
      .filter(name => name !== 'TrainingAvatar'); // python3 桩根不含 Avatar 本尊(入口)
    // 真跑:同一批 mixin 文件,动态拼根,与 TrainingAvatar 相同的遍历调度体
    const script = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(DEMO_SCRIPTS, 'common'))})`,
      'from training.mixins.health import HealthMixin',
      'from training.mixins.history import HistoryMixin',
      'from training.mixins.inventory import InventoryMixin',
      'order = []',
      'for cls in (HealthMixin, HistoryMixin, InventoryMixin):',
      "    orig = cls.__dict__['onCrossDay']",
      "    cls.onCrossDay = lambda self, o=orig, n=cls.__name__: (order.append(n), o(self))[1]",
      'Root = type("Root", (HealthMixin, HistoryMixin, InventoryMixin), {})',
      'root = Root()',
      'root.hp, root.maxHp, root.coins, root.battleLog = 50, 100, 0, [1, 2]',
      'for cls in type(root).__mro__[1:]:',
      "    handler = cls.__dict__.get('onCrossDay')",
      '    if handler is not None:',
      '        handler(root)',
      'print(",".join(order))'
    ].join('\n');
    const { stdout } = await execFileAsync('python3', ['-c', script]);
    const runtimeOrder = stdout.trim().split(',');
    expect(runtimeOrder).toEqual(['HealthMixin', 'HistoryMixin', 'InventoryMixin']);
    expect(derived, '静态推导序 == python3 运行时执行序').toEqual(runtimeOrder);
  });

  it('同名双 DamageMixin:compute_damage 链 critical 覆写在前、damage 基类在后', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const avatar = path.join(DEMO_SCRIPTS, 'cell/TrainingAvatar.py');
    const doc = makeTextDocument(fs.readFileSync(avatar, 'utf8'), { fileName: avatar, languageId: 'python' });
    const chains = await index.resolveMroMethodChains(
      avatar, lineOf(avatar, 'def reqAttack'), 'compute_damage', doc
    );
    const chain = chains.find(item => item.rootClassName === 'TrainingAvatar');
    expect(chain, 'compute_damage 有链').toBeTruthy();
    expect(chain!.entries).toHaveLength(2);
    // MRO 序:critical.DamageMixin(基类表第 1 位 Critical 的本尊)先于
    // damage.DamageMixin(CombatMixin 的基类)——同名类靠文件区分
    expect(chain!.entries.map(entry => baseName(entry.filePath))).toEqual(['critical.py', 'damage.py']);
  });

  it('mixin 文件视角:health.py 的 onCrossDay 出多根两链(Avatar+Monster 反向后代)', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const health = path.join(DEMO_SCRIPTS, 'common/training/mixins/health.py');
    const doc = makeTextDocument(fs.readFileSync(health, 'utf8'), { fileName: health, languageId: 'python' });
    const chains = await index.resolveMroMethodChains(
      health, lineOf(health, 'def onCrossDay'), 'onCrossDay', doc
    );
    const rootNames = chains.map(chain => chain.rootClassName);
    expect(rootNames).toContain('HealthMixin'); // 静态自身(1 定义者,如实保留)
    expect(rootNames).toContain('TrainingAvatar');
    expect(rootNames).toContain('TrainingMonster');
    for (const chain of chains.filter(item => item.rootClassName.startsWith('Training'))) {
      expect(chain.entries.map(entry => entry.className))
        .toEqual([chain.rootClassName, 'HealthMixin', 'HistoryMixin', 'InventoryMixin']);
    }
  });

  it('单定义者方法无顺序可言:take_damage 只有链长 1,不出镜', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const health = path.join(DEMO_SCRIPTS, 'common/training/mixins/health.py');
    const doc = makeTextDocument(fs.readFileSync(health, 'utf8'), { fileName: health, languageId: 'python' });
    const chains = await index.resolveMroMethodChains(
      health, lineOf(health, 'def take_damage'), 'take_damage', doc
    );
    expect(hasMroChainToPresent(chains)).toBe(false);
    expect(chains.every(chain => chain.entries.length === 1)).toBe(true);
  });
});

// MRO-CHAIN 组合根视角(②)的收口面:resolveMroMethodChains 只在
// rootsByScope 对查询文件有匹配作用域时才走这一臂。demo fixture 只有一份
// entities.xml(单作用域),故这里用 mkdtemp 真盘搭两棵嵌套作用域:
// 外层 ws/entities.xml + 内层 ws/sub/entities.xml(demo 的 scripts 树搬进
// ws/sub/scripts)。查询文件落在内层 → 两个作用域都前缀命中,最长作用域
// 胜出(排序比较器真实执行),内层组合根(实体 + def 声明的接口/组件)逐个
// 过 Python MRO 包含判定与 def mixin 链。
describe('MRO-CHAIN 组合根视角(嵌套作用域 + def mixin 面)', () => {
  const buildNestedWorkspace = (): { root: string; avatar: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mro-nested-'));
    fs.cpSync(path.join(DEMO_SCRIPTS, '..'), path.join(root, 'sub'), {
      recursive: true,
      filter: (item: string) => !item.endsWith('__pycache__')
    });
    // 外层作用域:仅一份 entities.xml(内层才是查询所在作用域)
    fs.cpSync(path.join(DEMO_SCRIPTS, 'entities.xml'), path.join(root, 'entities.xml'));
    const avatar = path.join(root, 'sub', 'scripts', 'cell', 'TrainingAvatar.py');
    return { root, avatar };
  };

  const stubNestedMetadata = (root: string): void => {
    const matches = (pattern: string, name: string): boolean =>
      pattern.includes('entities.xml') ? name === 'entities.xml'
        : pattern.includes('*.def') ? name.endsWith('.def')
          : pattern.includes('types.xml') ? name === 'types.xml'
            : name.endsWith('.py');
    workspace.findFiles = (async (glob: string) => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '__pycache__') { return; }
            walk(full);
          } else if (matches(String(glob), entry.name)) {
            out.push(full);
          }
        }
      };
      walk(root);
      return out.map(file => Uri.file(file));
    }) as typeof workspace.findFiles;
  };

  it('嵌套作用域内查询:最长作用域胜出,组合根视角给出根链与 def mixin 链', async () => {
    const { root, avatar } = buildNestedWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'nested', index: 0 }];
    stubNestedMetadata(root);
    try {
      const index = new PythonClassIndex();
      // 组合根派生按「首次查询」口径预热(真机=跳转/CodeLens 早已触发过派生,
      // rootsMap 已落地);否则 resolveMroMethodChains 的交互预算内派生会被
      // raceWithBudget 判超时,组合根视角整臂跳过,本测试就退化成静态自身链。
      await index.rootsContaining('TrainingAvatar');
      const text = fs.readFileSync(avatar, 'utf8');
      const doc = makeTextDocument(text, { fileName: avatar, languageId: 'python' });
      const chains = await index.resolveMroMethodChains(
        avatar, lineOf(avatar, 'def onCrossDay'), 'onCrossDay', doc
      );
      const rootNames = chains.map(chain => chain.rootClassName);
      // 组合根视角产出实体根链:本尊(静态自身)与实体根 TrainingMonster
      // (其 MRO 含 TrainingAvatar 本尊,组合根视角才看得见)
      expect(rootNames).toContain('TrainingAvatar');
      expect(rootNames).toContain('TrainingMonster');
      const monsterChain = chains.find(chain => chain.rootClassName === 'TrainingMonster')!;
      expect(monsterChain.entries.map(entry => entry.className))
        .toEqual(['TrainingMonster', 'HealthMixin', 'HistoryMixin', 'InventoryMixin']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('MRO-CHAIN provider 面与开关', () => {
  it('TrainingAvatar 的 onCrossDay def 行出「链 4」镜;关掉 kbengine.codeLens.mroChain 不出', async () => {
    stubDemoScripts();
    const index = new PythonClassIndex();
    const provider = new MroChainCodeLensProvider(index);
    const avatar = path.join(DEMO_SCRIPTS, 'cell/TrainingAvatar.py');
    const text = fs.readFileSync(avatar, 'utf8');
    const doc = makeTextDocument(text, { fileName: avatar, languageId: 'python' });
    workspace.textDocuments = [doc as never];

    const lenses = await provider.provideCodeLenses(doc as never);
    const onCrossDayLens = lenses.find(lens =>
      lens.range.start.line === lineOf(avatar, 'def onCrossDay'));
    expect(onCrossDayLens, 'onCrossDay def 行出镜').toBeTruthy();
    expect(onCrossDayLens!.command?.title).toContain('链 4');
    // drink_potion 只有 TrainingAvatar 自己定义(无 mixin 定义者),不出镜
    expect(lenses.find(lens => lens.range.start.line === lineOf(avatar, 'def drink_potion'))).toBeUndefined();

    configurationOverrides.set('kbengine', { 'codeLens.mroChain': false });
    expect(await provider.provideCodeLenses(doc as never)).toEqual([]);
  });
});
