import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { provideAliasXmlCompletionItems, provideAliasXmlDefinition } from '../src/languageProviders/aliasAssist';
import { validateAliasXmlDocument } from '../src/languageProviders/validation';
import { resetSemanticTypeRegistryForTests } from '../src/backend/semanticIndex';
import {
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  Uri,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

/**
 * KODE-SYN-003:alias.xml 直接编辑能力(aliasAssist + validateAliasXmlDocument)。
 * 装载语境=引擎单遍序:内建 → types.xml(盘上/脏缓冲) → 本文件先声明条目;
 * 自引用与后文引用与前向引用同口径不供货(引擎读指引时目标未注册,报错中止)。
 * 未保存编辑双通道:alias.xml 走缓冲文本(测试文档不落盘即真未保存形态);
 * types.xml 注册面经快照 machinery(既有面,IDE-SNP-004,另件已锁)。
 */

// 与 demo/引擎同形的 types.xml(落盘,注册面来源)
const TYPES_XML = [
  '<root>',
  '  <ITEM_ID> UINT16 </ITEM_ID>',
  '  <BASE_REF> STRING </BASE_REF>',
  '</root>'
].join('\n');

// alias.xml 缓冲(不落盘=真未保存形态):
//   A 引 types.xml 名(合法);B 空体=补全位;FWD 以后文 C 为目标(前向引用);
//   C 声明在后文。
const ALIAS_DOC = [
  '<root>',
  '  <A> ITEM_ID </A>',
  '  <B> </B>',
  '  <FWD> C </FWD>',
  '  <C> ITEM_ID </C>',
  '</root>'
].join('\n');

const tmpRoots: string[] = [];

const makeWorkspace = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-alias-assist-'));
  tmpRoots.push(root);
  const typesPath = path.join(root, 'scripts', 'entity_defs', 'types.xml');
  fs.mkdirSync(path.dirname(typesPath), { recursive: true });
  fs.writeFileSync(typesPath, TYPES_XML, 'utf8');
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'alias-assist', index: 0 }];
  return root;
};

const aliasDocFor = (root: string, text: string = ALIAS_DOC): MinimalTextDocument =>
  makeTextDocument(text, {
    fileName: path.join(root, 'scripts', 'entity_defs', 'alias.xml'),
    languageId: 'xml'
  });

afterEach(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tmpRoots.length = 0;
  workspace.workspaceFolders = [];
  workspace.textDocuments = [];
  resetSemanticTypeRegistryForTests();
});

describe('alias.xml 补全(provideAliasXmlCompletionItems)', () => {
  it('目标位供货:关键字+内建+types.xml 注册名+本文件先声明条目', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    // 光标落在 <B> 空体内('</B>' 前)
    const offset = document.getText().indexOf('<B> </B>') + '<B> '.length;
    const items = await provideAliasXmlCompletionItems(document, document.positionAt(offset));
    const labels = items.map(item => item.label);
    // 声明关键字(复合结构入口)
    expect(labels).toContain('ARRAY');
    expect(labels).toContain('FIXED_DICT');
    // 内建类型
    expect(labels).toContain('UINT16');
    // types.xml 注册面
    expect(labels).toContain('ITEM_ID');
    expect(labels).toContain('BASE_REF');
    // 本文件先声明条目(A 声明在光标前)
    expect(labels).toContain('A');
  });

  it('后文条目与前向目标不供货(引擎读指引时未注册)', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    const offset = document.getText().indexOf('<B> </B>') + '<B> '.length;
    const items = await provideAliasXmlCompletionItems(document, document.positionAt(offset));
    const labels = items.map(item => item.label);
    expect(labels).not.toContain('C');
    expect(labels).not.toContain('FWD');
    expect(labels).not.toContain('B'); // 光标所在条目自身(自引用同口径)
  });

  it('非目标位(条目名上)零供货', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    const offset = document.getText().indexOf('<A>') + 1; // '<A' 的 A 上
    const items = await provideAliasXmlCompletionItems(document, document.positionAt(offset));
    expect(items).toEqual([]);
  });

  it('畸形 XML 零供货不抛', async () => {
    makeWorkspace();
    const document = makeTextDocument('not xml at all', {
      fileName: '/tmp/ws/alias.xml',
      languageId: 'xml'
    });
    const items = await provideAliasXmlCompletionItems(document, new Position(0, 4));
    expect(items).toEqual([]);
  });
});

describe('alias.xml 跳转(provideAliasXmlDefinition)', () => {
  it('本文件先声明条目:落同文档条目区间', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    // FWD 行改成引用 A(A 声明在前,合法链)
    const text = ['<root>', '  <A> ITEM_ID </A>', '  <B> A </B>', '</root>'].join('\n');
    const doc = aliasDocFor(root, text);
    const offset = text.indexOf('<B> A </B>') + '<B> '.length + 'A'.length - 1;
    const locations = await provideAliasXmlDefinition(doc, doc.positionAt(offset));
    expect(locations).toHaveLength(1);
    expect(locations![0].uri.fsPath).toBe(doc.uri.fsPath);
    const start = doc.offsetAt(locations![0].range.start);
    const end = doc.offsetAt(locations![0].range.end);
    expect(text.slice(start, end)).toContain('<A>');
  });

  it('types.xml 注册名:落 types.xml 文件声明行', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    const offset = document.getText().indexOf('<A> ITEM_ID </A>') + '<A> '.length + 'ITEM_ID'.length - 1;
    const locations = await provideAliasXmlDefinition(document, document.positionAt(offset));
    expect(locations).toHaveLength(1);
    expect(locations![0].uri.fsPath).toBe(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
  });

  it('内建名无声明落点(引擎内建表非文档实体)', async () => {
    const root = makeWorkspace();
    const text = ['<root>', '  <X> UINT16 </X>', '</root>'].join('\n');
    const document = aliasDocFor(root, text);
    const offset = text.indexOf('<X> UINT16 </X>') + '<X> '.length + 'UINT16'.length - 1;
    const locations = await provideAliasXmlDefinition(document, document.positionAt(offset));
    expect(locations).toEqual([]);
  });

  it('前向引用名与自引用:空(引擎读指引时目标未注册)', async () => {
    const root = makeWorkspace();
    // FWD 目标 C 声明在后文 → 空
    const offsetFwd = ALIAS_DOC.indexOf('<FWD> C </FWD>') + '<FWD> '.length + 'C'.length - 1;
    const fwdDoc = aliasDocFor(root);
    expect(await provideAliasXmlDefinition(fwdDoc, fwdDoc.positionAt(offsetFwd))).toEqual([]);
    // 自引用:B 内引用 B → 空
    const selfText = ['<root>', '  <B> B </B>', '</root>'].join('\n');
    const selfDoc = aliasDocFor(root, selfText);
    const offsetSelf = selfText.indexOf('<B> B </B>') + '<B> '.length + 'B'.length - 1;
    expect(await provideAliasXmlDefinition(selfDoc, selfDoc.positionAt(offsetSelf))).toEqual([]);
  });

  it('条目名位非目标位 → null(不属本 provider 供货域)', async () => {
    const root = makeWorkspace();
    const document = aliasDocFor(root);
    const offset = document.getText().indexOf('<A>') + 1;
    expect(await provideAliasXmlDefinition(document, document.positionAt(offset))).toBeNull();
  });
});

describe('alias.xml 结构诊断(validateAliasXmlDocument,预载 types.xml)', () => {
  it('合法链零发现;前向引用落诊断(区间在目标词上)', () => {
    const root = makeWorkspace();
    const collection = new DiagnosticCollection();
    const document = aliasDocFor(root);
    validateAliasXmlDocument(document, collection);
    const items = collection.get(document.uri);
    // 只有 FWD→C(后文)一处;A→ITEM_ID(types.xml)与本文件其余链合法
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe('kbengine.types.forwardRef');
    expect(items[0].severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText().slice(
      document.offsetAt(items[0].range.start),
      document.offsetAt(items[0].range.end)
    )).toBe(' C ');
  });

  it('多根同名:各根注册面独立,同名诊断互不串(双根同形 alias 均各报各的)', () => {
    const rootA = makeWorkspace();
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-alias-assist-b-'));
    tmpRoots.push(rootB);
    const typesB = path.join(rootB, 'scripts', 'entity_defs', 'types.xml');
    fs.mkdirSync(path.dirname(typesB), { recursive: true });
    // 根 B 的 types.xml 只有 STRING 链,无 ITEM_ID
    fs.writeFileSync(typesB, ['<root>', '  <BASE_REF> STRING </BASE_REF>', '</root>'].join('\n'), 'utf8');
    // 双根同时在册:各文档按自身路径归根(getWorkspaceRootForDocument 前缀匹配)
    workspace.workspaceFolders = [
      { uri: Uri.file(rootA), name: 'alias-a', index: 0 },
      { uri: Uri.file(rootB), name: 'alias-b', index: 1 }
    ];
    const docA = aliasDocFor(rootA);
    const docB = makeTextDocument(ALIAS_DOC, {
      fileName: path.join(rootB, 'scripts', 'entity_defs', 'alias.xml'),
      languageId: 'xml'
    });
    const collection = new DiagnosticCollection();
    validateAliasXmlDocument(docA, collection);
    validateAliasXmlDocument(docB, collection);
    // 根 A:ITEM_ID 可解,只 FWD 一处;根 B:ITEM_ID 不在注册面 →
    // A/FWD/C 三处全报(A、C 的目标与 FWD 的前向目标)
    expect(collection.get(docA.uri)).toHaveLength(1);
    expect(collection.get(docB.uri)).toHaveLength(3);
  });
});
