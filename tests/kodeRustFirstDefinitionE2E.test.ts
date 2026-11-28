// P0 def 跳转回归防线(2026-11-18,巡检单 kode-def-jump-regression.md):
// 服务轨道(rust-first)下 def→python 导航的常驻回归测试。
//
// 背景:2026-11-16 1ab8239c 引入的 Rust definition 面曾以属性词落注册行
// (registry_landing)短路 TS 脚本层,该坏面溜过当时 CI——vitest 的 demo
// navigation 全部走 stub TS 链,e2e demo navigation 只在本地跑,没有任何
// 常驻测试穿「真二进制 + RustFirst 分支」的 def→python 落点(1843f4e4
// 修复时 golden 已被同步翻正,无残留)。本测试补这个缺口:demo 真仓 fixture
// + 真.kode-server 二进制 + 真装配 gate + 全量语料镜像(真机
// mirrorCorpusToRust 等价形状),钉死四臂:
//   ①CellMethods 方法词 → cell py 实现
//   ②BaseMethods 方法词 → base py 实现
//   ③ClientMethods 方法词 → client py 实现
//   ④Properties 属性词 → py 类声明层(不落 def 注册行=1ab8239c 坏面形状)
// Rust 臂抢答错落点(非 null)即短路 TS,四臂立刻红——这正是用户实报
// 「def 跳转 python 失效」的根因家族。
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { KodeCoreGate, DEFAULT_CORE_GATE_CONFIG } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import { patternGlob } from './helpers/findPattern';

const DEMO = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');

/** 二进制探测:CI 的 cargo build 产物 → 随包 bin;都缺 = 本地纯 Node 面,skip */
function resolveProbeBinary(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', 'target', 'debug', 'kode-server'),
    path.resolve(__dirname, '..', 'bin', 'kode-server')
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) { return candidate; }
    } catch { /* 缺件换下一处 */ }
  }
  return null;
}

const BIN = resolveProbeBinary();
const originalFindFiles = workspace.findFiles;
const originalFolders = workspace.workspaceFolders;

function walkFiles(): Uri[] {
  const files: Uri[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); } else { files.push(Uri.file(full)); }
    }
  };
  walk(DEMO);
  return files;
}

const wordPosition = (content: string, marker: string, symbol: string): Position => {
  const lines = content.split(/\r?\n/);
  const line = lines.findIndex(row => row.includes(marker));
  expect(line, `missing marker ${marker}`).toBeGreaterThanOrEqual(0);
  const character = lines[line].indexOf(symbol);
  expect(character, `missing symbol ${symbol} beside ${marker}`).toBeGreaterThanOrEqual(0);
  return new Position(line, character + Math.floor(symbol.length / 2));
};

(BIN ? describe : describe.skip)('RustFirst def→python 导航回归(demo 真仓+真二进制)', () => {
  let gate: KodeCoreGate;
  let provider: KBEngineDefinitionProvider;

  beforeAll(async () => {
    workspace.workspaceFolders = [{ uri: Uri.file(DEMO), name: 'kbengine-demo-assets', index: 0 }];
    workspace.findFiles = (async (raw?: unknown) => {
      const glob = patternGlob(raw);
      return walkFiles().filter(uri => {
        const name = path.basename(uri.fsPath);
        return glob.includes('entities.xml') ? name === 'entities.xml'
          : glob.includes('*.def') ? name.endsWith('.def')
            : glob.includes('types.xml') ? name === 'types.xml'
              : name.endsWith('.py');
      });
    }) as never;
    const manager = new EntityMappingManager({ subscriptions: [] });
    provider = new KBEngineDefinitionProvider(manager);
    gate = new KodeCoreGate();
    gate.setInitializeParams({
      processId: process.pid,
      capabilities: {},
      workspaceFolders: [{ uri: Uri.file(DEMO).toString(), name: 'kbengine-demo-assets' }]
    });
    gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, serverPath: BIN! });
    setKodeCoreShadowGate(gate);
    // 全量语料镜像(真机 setupKodeCoreGate→mirrorCorpusToRust 的等价形状):
    // Rust 侧类型环境/注册表只由已镜像文档入库——不镜像则 registry 类臂
    // 全部落空,测不出「抢答错落点」的坏面。
    const corpus = walkFiles().filter(uri =>
      uri.fsPath.endsWith('.def') || uri.fsPath.endsWith('entities.xml') || uri.fsPath.endsWith('types.xml'));
    for (const uri of corpus) {
      const text = fs.readFileSync(uri.fsPath, 'utf8');
      await gate.mirrorDocument(
        uri.fsPath,
        uri.fsPath.endsWith('.def') ? 'kbengine-def' : 'xml',
        1,
        text
      );
    }
  }, 120_000);

  afterAll(() => {
    setKodeCoreShadowGate(null);
    // 换 serverPath 触发 stopClient,回收 Rust 子进程
    gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, serverPath: '' });
    workspace.findFiles = originalFindFiles;
    workspace.workspaceFolders = originalFolders;
  });

  const probeLanding = async (
    sourceFile: string, marker: string, symbol: string,
    targetFile: string, targetNeedle: string
  ): Promise<void> => {
    const filePath = path.join(DEMO, sourceFile);
    const content = fs.readFileSync(filePath, 'utf8');
    const document = makeTextDocument(content, {
      fileName: filePath,
      languageId: filePath.endsWith('.def') ? 'kbengine-def' : 'python'
    });
    const result = await provider.provideDefinition(document, wordPosition(content, marker, symbol)) as
      | { uri: { fsPath: string }; range: { start: { line: number } } }
      | { uri: { fsPath: string }; range: { start: { line: number } } }[]
      | null;
    expect(result, `${symbol}: 跳转落空(Rust 臂与 TS 链都未产出落点)`).not.toBeNull();
    const first = Array.isArray(result) ? result[0] : result;
    const targetContent = fs.readFileSync(path.join(DEMO, targetFile), 'utf8');
    const targetLine = targetContent.split(/\r?\n/).findIndex(row => row.includes(targetNeedle));
    expect(targetLine, `missing target ${targetFile}: ${targetNeedle}`).toBeGreaterThanOrEqual(0);
    expect(first.uri.fsPath, `${symbol} 落点文件`).toBe(path.resolve(DEMO, targetFile));
    expect(first.range.start.line, `${symbol} 落点行`).toBe(targetLine);
  };

  it('① CellMethods 方法词 → cell py 实现(Rust 抢答即红)', async () => {
    await probeLanding(
      'scripts/entity_defs/TrainingAvatar.def', '<CellMethods>', 'reqAttack',
      'scripts/cell/TrainingAvatar.py', 'def reqAttack');
  }, 60_000);

  it('② BaseMethods 方法词 → base py 实现', async () => {
    await probeLanding(
      'scripts/entity_defs/TrainingAvatar.def', '<BaseMethods>', 'reqEnterArena',
      'scripts/base/TrainingAvatar.py', 'def reqEnterArena');
  }, 60_000);

  it('③ ClientMethods 方法词 → client py 实现', async () => {
    await probeLanding(
      'scripts/entity_defs/TrainingAvatar.def', '<ClientMethods>', 'onBattleResult',
      'scripts/client/TrainingAvatar.py', 'def onBattleResult');
  }, 60_000);

  it('④ Properties 属性词 → py 类声明层,不落 def 注册行(1ab8239c 坏面形状)', async () => {
    await probeLanding(
      'scripts/entity_defs/Avatar.def', '<level>', 'level',
      'scripts/base/Avatar.py', 'class Avatar');
  }, 60_000);

  it('⑤ types.xml 声明词 → 语料首个消费站点(RUST-137 批 4 反边,of 值位)', async () => {
    // 2026-11-28 re-anchor: the demo corpus reshuffle moved the first
    // ITEM_ID consumption site to Avatar.def (depot <Arg> position); the
    // Inventory component no longer consumes it at an <of> position.
    await probeLanding(
      'scripts/entity_defs/types.xml', '<ITEM_ID>', 'ITEM_ID',
      'scripts/entity_defs/Avatar.def', '<Arg> ITEM_ID');
  }, 60_000);

  it('⑥ FIXED_DICT 声明词 → 消费站点 of 值位(Inventory.def Arg 位次之不选)', async () => {
    await probeLanding(
      'scripts/entity_defs/types.xml', '<SKILL_SLOT>', 'SKILL_SLOT',
      'scripts/entity_defs/Avatar.def', '<of> SKILL_SLOT');
  }, 60_000);

  it('⑦ 语料无消费的声明词回落声明行(反边回落臂,不再自跳后才回落)', async () => {
    await probeLanding(
      'scripts/entity_defs/types.xml', '<ITEM_DESC>', 'ITEM_DESC',
      'scripts/entity_defs/types.xml', '<ITEM_DESC>');
  }, 60_000);

  it('⑧ implementedBy 值词 → py 符号行(Rust null 不挡 TS 链,RUST-137 ③ py 边)', async () => {
    await probeLanding(
      'scripts/entity_defs/types.xml', '<implementedBy>', 'SKILL_SLOT_DATA',
      'scripts/user_type/SKILL_SLOT_DATA.py', 'weapon_skill_slot_list_inst =');
  }, 60_000);
});
