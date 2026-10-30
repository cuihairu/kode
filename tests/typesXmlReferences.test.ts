import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import {
  provideTypesXmlReferences,
  resolveTypesXmlSymbolName,
  scanTypeReferencesInXml
} from '../src/typesXmlReferences';
import { KBEngineReferencesProvider } from '../src/languageProviders';

// IDE-NAV-017:types.xml 符号引用查询(Shift+F12)。范围/验收:types.xml 内
// 符号的引用位覆盖 .def 中 <Type>/<Arg>/<of> 值使用处与实体属性类型引用;
// includeDeclaration 语义与 def 面一致(忽略,只回引用位);空结果如实 null。
// prove-red:旧码(非 .def 提前返回 null)types.xml 符号引用用例红。

const TYPES_XML = [
  '<root>',
  '  <Gold>',
  '    <Properties>',
  '      <amount>',
  '        <Type>UINT32</Type>',
  '      </amount>',
  '    </Properties>',
  '  </Gold>',
  '  <Bag>',
  '    <Properties>',
  '      <items>',
  '        <Type>ARRAY of Gold</Type>',
  '      </items>',
  '    </Properties>',
  '  </Bag>',
  '</root>'
].join('\n');

const DEF_WITH_GOLD = [
  '<root>',
  '  <Properties>',
  '    <loot>',
  '      <Type>Gold</Type>',
  '    </loot>',
  '    <stash>',
  '      <Type>ARRAY of Gold</Type>',
  '    </stash>',
  '    <pouch>',
  '      <Type><of>Gold</of></Type>',
  '    </pouch>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <grant>',
  '      <Arg>Gold</Arg>',
  '    </grant>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const tmpRoots: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-typesxml-refs-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

describe('resolveTypesXmlSymbolName(符号识别)', () => {
  it('顶层类型声明名 → 该类型名', () => {
    const offset = TYPES_XML.indexOf('  <Gold>') + '  <Gold>'.indexOf('Gold');
    expect(resolveTypesXmlSymbolName(TYPES_XML, offset + 1)).toBe('Gold');
  });

  it('<Type> 值内类型名引用 → 该名', () => {
    const line = TYPES_XML.indexOf('<Type>ARRAY of Gold</Type>');
    const offset = line + '<Type>ARRAY of '.length + 'Gold'.length - 1;
    expect(resolveTypesXmlSymbolName(TYPES_XML, offset)).toBe('Gold');
  });

  it('容器字面 ARRAY 不是类型符号 → null', () => {
    const line = TYPES_XML.indexOf('<Type>ARRAY of Gold</Type>');
    const offset = line + '<Type>'.length + 'ARRAY'.length - 1;
    expect(resolveTypesXmlSymbolName(TYPES_XML, offset)).toBeNull();
  });

  it('普通属性名位(UINT32 值)是类型上下文,返回该名(是否自定义交给查询面)', () => {
    const line = TYPES_XML.indexOf('<Type>UINT32</Type>');
    const offset = line + '<Type>'.length + 'UINT32'.length - 1;
    expect(resolveTypesXmlSymbolName(TYPES_XML, offset)).toBe('UINT32');
  });

  it('非类型标签(如 <amount> 元素名)不是类型符号 → null', () => {
    const offset = TYPES_XML.indexOf('<amount>') + '<amount>'.indexOf('amount') + 1;
    expect(resolveTypesXmlSymbolName(TYPES_XML, offset)).toBeNull();
  });
});

describe('scanTypeReferencesInXml(引用扫描)', () => {
  it('def:Type 值/ARRAY 内/游离 of 子节点/Arg 值均收录,容器字面不收录', () => {
    const sites = scanTypeReferencesInXml(DEF_WITH_GOLD, '/ws/Avatar.def', 'Gold');
    const lines = sites.map(site => site.line);
    expect(lines).toEqual([3, 6, 9, 14]);
    // 每个落点字符区间覆盖 'Gold'
    for (const site of sites) {
      const lineText = DEF_WITH_GOLD.split('\n')[site.line];
      expect(lineText.slice(site.start, site.end)).toBe('Gold');
    }
  });

  it('目标名不匹配 → 空数组;ARRAY 字面不作为目标', () => {
    expect(scanTypeReferencesInXml(DEF_WITH_GOLD, '/ws/Avatar.def', 'Silver')).toEqual([]);
    expect(scanTypeReferencesInXml(DEF_WITH_GOLD, '/ws/Avatar.def', 'ARRAY')).toEqual([]);
  });

  it('types.xml:引用另一类型的 <Type>/<of> 位收录(不含声明自身)', () => {
    const sites = scanTypeReferencesInXml(TYPES_XML, '/ws/types.xml', 'Gold');
    // 只有 Bag 的 <Type>ARRAY of Gold</Type> 这一处;Gold 声明自身不是引用
    expect(sites.map(site => site.line)).toEqual([11]);
  });

  it('非 XML/坏内容 → 空数组不抛', () => {
    expect(scanTypeReferencesInXml('not xml at all', '/ws/bad.def', 'Gold')).toEqual([]);
  });
});

describe('provideTypesXmlReferences(工作区级引用查询)', () => {
  let wsRoot: string;
  let typesXmlPath: string;
  let avatarDefPath: string;
  const originalFindFiles = stubWorkspace.findFiles;
  const originalFolders = stubWorkspace.workspaceFolders;

  beforeEach(() => {
    wsRoot = makeTmpDir('ws');
    typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    avatarDefPath = path.join(wsRoot, 'scripts', 'entity_defs', 'Avatar.def');
    fs.mkdirSync(path.dirname(typesXmlPath), { recursive: true });
    fs.writeFileSync(typesXmlPath, TYPES_XML);
    fs.writeFileSync(avatarDefPath, DEF_WITH_GOLD);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (typeof glob !== 'string') {
        return [];
      }
      if (glob === '**/*.def') {
        return [Uri.file(avatarDefPath)];
      }
      if (glob === '**/types.xml') {
        return [Uri.file(typesXmlPath)];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
  });

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = originalFolders;
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const typesXmlDoc = () =>
    makeTextDocument(TYPES_XML, { fileName: typesXmlPath, languageId: 'xml' }) as never;
  const positionAt = (content: string, needle: string): Position => {
    const idx = content.indexOf(needle);
    const before = content.slice(0, idx).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length);
  };

  it('光标在 Gold 声明上 → 工作区全部 Gold 引用位(def Type/Arg/of + types.xml 内)', async () => {
    const doc = typesXmlDoc();
    const pos = positionAt(TYPES_XML, 'Gold');
    const result = await provideTypesXmlReferences(doc, pos);
    expect(result).not.toBeNull();
    const fsPaths = result!.map(loc => loc.uri.fsPath);
    // def 四处(Type/ARRAY 内/of/Arg)+ types.xml 内一处(Bag 的 ARRAY of Gold)
    expect(fsPaths.filter(p => p === avatarDefPath)).toHaveLength(4);
    expect(fsPaths.filter(p => p === typesXmlPath)).toHaveLength(1);
    // 每处落点字符区间是 'Gold'
    for (const loc of result!) {
      const content = loc.uri.fsPath === avatarDefPath ? DEF_WITH_GOLD : TYPES_XML;
      const lineText = content.split('\n')[loc.range.start.line];
      const word = lineText.slice(loc.range.start.character, loc.range.start.character + 4);
      expect(word).toBe('Gold');
    }
  });

  it('内建类型 UINT32 非 types.xml 符号 → null(无引用面)', async () => {
    const doc = typesXmlDoc();
    const pos = positionAt(TYPES_XML, 'UINT32');
    expect(await provideTypesXmlReferences(doc, pos)).toBeNull();
  });

  it('容器字面 ARRAY 位 → null', async () => {
    const doc = typesXmlDoc();
    const pos = positionAt(TYPES_XML, 'ARRAY of Gold');
    expect(await provideTypesXmlReferences(doc, pos)).toBeNull();
  });

  it('无引用位(声明但无人用)→ null 不虚构', async () => {
    fs.writeFileSync(typesXmlPath, TYPES_XML + '\n  <Silver>\n    <Properties/>\n  </Silver>\n');
    const doc = makeTextDocument(
      fs.readFileSync(typesXmlPath, 'utf8'),
      { fileName: typesXmlPath, languageId: 'xml' }
    ) as never;
    const pos = positionAt(fs.readFileSync(typesXmlPath, 'utf8'), '<Silver>');
    expect(await provideTypesXmlReferences(doc, pos)).toBeNull();
  });

  it('wiring:KBEngineReferencesProvider 对 types.xml 符号出引用位(NAV-017 装配)', async () => {
    // prove-red:移除 provider 的 types.xml 分支(旧码非 .def 提前 null)即红;
    // 分支在,Shift+F12 路由到本模块,出工作区全部引用位。
    const provider = new KBEngineReferencesProvider({} as never);
    const doc = typesXmlDoc();
    const result = await provider.provideReferences(
      doc,
      positionAt(TYPES_XML, 'Gold'),
      { includeDeclaration: false },
      undefined
    );
    expect(result).not.toBeNull();
    const fsPaths = result!.map(loc => loc.uri.fsPath);
    expect(fsPaths.filter(p => p === avatarDefPath)).toHaveLength(4);
    expect(fsPaths.filter(p => p === typesXmlPath)).toHaveLength(1);
  });
});
