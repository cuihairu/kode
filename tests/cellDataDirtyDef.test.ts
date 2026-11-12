import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defBufferStampForRoot, findDefinitionTextByCategory } from '../src/definitionWorkspace';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { Position, Range, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { EntityMappingManager } from '../src/entityMapping';

// KSEM-CELL-15:cellData 全链的 def 输入面验收(纯逻辑半边)。
//
// 缺口:六个 cellData 消费面(补全/inlay/hover/写入类型/错键/F12)原先一律
// readFileSync 读盘——未保存的 def 编辑不进入任何一面;且 inlay/hover 的键
// 缓存只按 python 文档版本成键,保存后的 def 编辑也让缓存陈旧。
//
// 本套件钉三面:
// ① findDefinitionTextByCategory 的脏 overlay(打开文档 = 文本事实源);
// ② defBufferStampForRoot 代签名(根隔离 + 版本/脏标敏感);
// ③ inlay 键宇宙缓存的失效面:同 python 文档版本不变,仅打开 def 的未保存
//    编辑(版本前进)即换缓存键并重新取键。
// 真实 Provider 五面联动(含诊断与 F12)在 electron 全链套件
// (src/test/electron/suite/cellDataFullChain.test.ts,--celldata)验收。

type DefSource = { name: string; text: string };

interface CapturingGate extends KodeCoreGate {
  /** 每次 cellDataKeys RPC 收到的 def 宇宙(文本口径取证面)。 */
  seenDefs: DefSource[][];
}

const ORIGINAL_FOLDERS = workspace.workspaceFolders;
const ORIGINAL_DOCS = workspace.textDocuments as unknown[];

const DISK_DEF = [
  '<root>',
  '    <Properties>',
  '        <gold>',
  '            <Type>UINT32</Type>',
  '            <Flags>CELL_PUBLIC</Flags>',
  '        </gold>',
  '    </Properties>',
  '</root>'
].join('\n');

const DIRTY_DEF = [
  '<root>',
  '    <Properties>',
  '        <gold>',
  '            <Type>UINT32</Type>',
  '            <Flags>CELL_PUBLIC</Flags>',
  '        </gold>',
  '        <bonus>',
  '            <Type>UINT8</Type>',
  '        </bonus>',
  '    </Properties>',
  '</root>'
].join('\n');

describe('KSEM-CELL-15 cellData 全链:未保存 def 编辑进键宇宙', () => {
  let root = '';
  let defPath = '';
  let gate: CapturingGate | null = null;

  const installGate = (): CapturingGate => {
    const captured: DefSource[][] = [];
    const fake = {
      serveFromRust: () => false,
      runInRust: async (
        _method: string,
        args: { defs?: unknown }
      ): Promise<{ ok: boolean; result: { keys?: unknown[] } | null }> => {
        // 只记 cellData 键 RPC:其他 Rust 面(属性流/注解/返回注解)不带 defs,
        // 若按调用计数会误把无关 RPC 记进来(见 CELL-15 验收口径)。
        if (!Array.isArray(args.defs)) {
          return { ok: true, result: {} };
        }
        captured.push(args.defs as DefSource[]);
        return {
          ok: true,
          result: {
            keys: [{ key: 'gold', kind: { kind: 'defField' }, typeLabel: 'UINT32', sourceFile: 'ChainEntity.def', sourceLine: 4 }]
          }
        };
      }
    } as unknown as CapturingGate;
    fake.seenDefs = captured;
    gate = fake;
    setKodeCoreShadowGate(fake as unknown as KodeCoreGate);
    return fake;
  };

  const managerOf = (): EntityMappingManager =>
    ({
      resolvePropertyDefinitionInfo: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    }) as unknown as EntityMappingManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cell15-'));
    defPath = path.join(root, 'scripts', 'entity_defs', 'ChainEntity.def');
    fs.mkdirSync(path.dirname(defPath), { recursive: true });
    fs.writeFileSync(defPath, DISK_DEF, 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cell15', index: 0 }];
    workspace.textDocuments = [];
  });

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    workspace.textDocuments = ORIGINAL_DOCS;
    setKodeCoreShadowGate(null);
    gate = null;
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  describe('findDefinitionTextByCategory(脏 overlay)', () => {
    it('未打开时读磁盘', () => {
      expect(findDefinitionTextByCategory('ChainEntity', 'entity', root)).toBe(DISK_DEF);
    });

    it('已打开 def 的未保存内容优先于磁盘(读不到磁盘也照样出)', () => {
      const doc = makeTextDocument(DIRTY_DEF, {
        fileName: defPath,
        languageId: 'kbengine-def',
        version: 2
      });
      workspace.textDocuments = [doc];
      expect(findDefinitionTextByCategory('ChainEntity', 'entity', root)).toBe(DIRTY_DEF);
    });

    it('def 缺席时返回 null(缺席贡献,不猜)', () => {
      expect(findDefinitionTextByCategory('NoSuchEntity', 'entity', root)).toBeNull();
    });
  });

  describe('defBufferStampForRoot(代签名)', () => {
    it('无打开 def → 空签名', () => {
      expect(defBufferStampForRoot(root)).toBe('');
    });

    it('版本前进与脏标翻转都换签名', () => {
      const doc = makeTextDocument(DISK_DEF, { fileName: defPath, languageId: 'kbengine-def', version: 1 });
      workspace.textDocuments = [doc];
      const before = defBufferStampForRoot(root);
      expect(before).toContain('ChainEntity.def#1#0');
      doc.version = 2;
      expect(defBufferStampForRoot(root)).not.toBe(before);
    });

    it('非 .def 与根外 def 不进本根签名(跨根同名 def 互不串扰)', () => {
      const otherRoot = path.join(os.tmpdir(), 'kode-cell15-other-root');
      const otherDefPath = path.join(otherRoot, 'scripts', 'entity_defs', 'ChainEntity.def');
      const docs = [
        makeTextDocument('py', { fileName: path.join(root, 'scripts', 'base', 'ChainEntity.py'), languageId: 'python', version: 1 }),
        makeTextDocument(DISK_DEF, { fileName: otherDefPath, languageId: 'kbengine-def', version: 7 })
      ];
      workspace.textDocuments = docs;
      expect(defBufferStampForRoot(root)).toBe('');
      expect(defBufferStampForRoot(otherRoot)).toContain('entity_defs/ChainEntity.def#7#0');
    });
  });

  describe('inlay 键宇宙缓存随未保存 def 编辑失效', () => {
    it('python 文档未改、仅打开 def 版本前进即重取键', async () => {
      const capture = installGate();
      const scriptPath = path.join(root, 'scripts', 'cell', 'ChainEntity.py');
      const document = makeTextDocument(
        'class ChainEntity:\n    def audit(self):\n        value = self.cellData["gold"]\n',
        { fileName: scriptPath, languageId: 'python', version: 1 }
      );
      const provider = new PythonTypeInlayHintsProvider(managerOf());
      const range = new Range(new Position(0, 0), new Position(4, 0));

      await provider.provideInlayHints(document as never, range);
      expect(capture.seenDefs).toHaveLength(1);
      expect(capture.seenDefs[0].some(def => def.name === 'ChainEntity' && def.text === DISK_DEF)).toBe(true);

      // 未保存编辑同一 def(打开文档=文本事实源):python 文档版本不变
      const defDoc = makeTextDocument(DIRTY_DEF, { fileName: defPath, languageId: 'kbengine-def', version: 1 });
      workspace.textDocuments = [defDoc];
      defDoc.setText(DIRTY_DEF);
      defDoc.version = 2;

      await provider.provideInlayHints(document as never, range);
      expect(capture.seenDefs).toHaveLength(2);
      expect(capture.seenDefs[1].some(def => def.name === 'ChainEntity' && def.text === DIRTY_DEF)).toBe(true);

      // 同版本同代:缓存命中,零重复 RPC
      await provider.provideInlayHints(document as never, range);
      expect(capture.seenDefs).toHaveLength(2);
    });
  });

  describe('hover 生命周期注记缓存同面', () => {
    it('未保存 def 编辑后重取键(键宇宙刷进生命周期注记)', async () => {
      const capture = installGate();
      const scriptPath = path.join(root, 'scripts', 'cell', 'ChainEntity.py');
      const text = 'class ChainEntity:\n    def onTick(self):\n        total = self.cellData["gold"]\n';
      const document = makeTextDocument(text, { fileName: scriptPath, languageId: 'python', version: 1 });
      const provider = new KBEngineHoverProvider();
      const dataStart = text.split('\n')[2].indexOf('cellData') + 1;
      const position = new Position(2, dataStart);

      await provider.provideHover(document as never, position);
      expect(capture.seenDefs).toHaveLength(1);
      expect(capture.seenDefs[0].some(def => def.text === DISK_DEF)).toBe(true);

      const defDoc = makeTextDocument(DIRTY_DEF, { fileName: defPath, languageId: 'kbengine-def', version: 1 });
      workspace.textDocuments = [defDoc];
      defDoc.setText(DIRTY_DEF);
      defDoc.version = 2;

      await provider.provideHover(document as never, position);
      expect(capture.seenDefs).toHaveLength(2);
      expect(capture.seenDefs[1].some(def => def.text === DIRTY_DEF)).toBe(true);
    });
  });
});