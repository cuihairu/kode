import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  KBE_SCHEME,
  KBE_STUB_PATH,
  KBE_SYMBOLS,
  buildKbeStubDocument,
  buildKbeStubUriString,
  engineApiVersionAnnotation,
  filterKbeSymbols,
  getKbeAliases,
  getKbeCompletionContext,
  getKbeFromImportedSymbols,
  getKbeSymbol,
  getPythonClassBaseAtPosition,
  kbeCompletionDocumentation,
  resolveKbeAccessAtPosition,
  summaryForLanguage
} from '../src/kbeModuleIndex';
import { resolveEngineRoot } from './helpers/engineRoot';

// kbe 模块符号索引(批108):别名解析、访问定位、补全语境、桩文档结构与
// URI 组装。符号面以引擎 typings 为唯一事实源——带 KBEngine 检出时逐条
// 回验 sourceFile:sourceLine 确实落在对应 class/def 声明行(与 hooks/
// metadata 的"插件数据 vs 引擎源码"同口径);无检出时该组 skip。

const engineRoot = resolveEngineRoot();

describe('kbe 模块符号索引(批108)', () => {
  it('符号表非空且 KBEntity 别名条目在列', () => {
    expect(KBE_SYMBOLS.length).toBeGreaterThan(0);
    const alias = getKbeSymbol('KBEntity');
    expect(alias?.aliasOf).toBe('Entity');
    expect(alias?.kind).toBe('class');
  });

  it('未知符号返回 null', () => {
    expect(getKbeSymbol('NoSuchSymbol')).toBeNull();
  });

  it('URI 组装为 kbe-stub scheme', () => {
    expect(buildKbeStubUriString()).toBe(`${KBE_SCHEME}:${KBE_STUB_PATH}`);
    expect(KBE_SCHEME).toBe('kbe-stub');
    expect(KBE_STUB_PATH).toBe('/KBEngine.pyi');
  });

  describe('别名解析 getKbeAliases', () => {
    it('import KBEngine / import kbe / as 别名全形态;from-import 不绑定模块别名', () => {
      expect(getKbeAliases('import KBEngine\n')).toEqual(new Set(['KBEngine']));
      expect(getKbeAliases('import kbe\n')).toEqual(new Set(['kbe']));
      expect(getKbeAliases('import KBEngine as kbe\n')).toEqual(new Set(['kbe']));
      // R4-F12:from KBEngine import X 只引入符号 X,不把模块名当绑定别名
      expect(getKbeAliases('from kbe import KBEntity\n')).toEqual(new Set());
      expect(getKbeAliases('from KBEngine import Entity\n')).toEqual(new Set());
    });

    it('无引入语句时为空集', () => {
      expect(getKbeAliases('class GameObject:\n    pass\n').size).toBe(0);
    });

    it('同文档多别名合并;缩进语句(函数内引入)同样识别', () => {
      const text = [
        'import KBEngine',
        'def setup():',
        '    import kbe',
        '    from KBEngine import Entity'
      ].join('\n');
      expect(getKbeAliases(text)).toEqual(new Set(['KBEngine', 'kbe']));
    });

    it('不吞相近模块名(kbek/KBEngineX 不命中)', () => {
      expect(getKbeAliases('import kbengine\nimport KBEngineX\n').size).toBe(0);
    });
  });

  describe('from-import 符号 getKbeFromImportedSymbols', () => {
    it('单名字/多名字/括号字面全形态', () => {
      expect(getKbeFromImportedSymbols('from kbe import KBEntity\n')).toEqual(new Set(['KBEntity']));
      expect(getKbeFromImportedSymbols('from KBEngine import Entity, Proxy\n'))
        .toEqual(new Set(['Entity', 'Proxy']));
      expect(getKbeFromImportedSymbols('from kbe import (KBEntity,\n  Entity)\n'))
        .toEqual(new Set(['KBEntity', 'Entity']));
    });

    it('非 kbe 来源与非法名字不入集', () => {
      expect(getKbeFromImportedSymbols('from os import path\n').size).toBe(0);
      expect(getKbeFromImportedSymbols('from kbe import *\n').size).toBe(0);
      expect(getKbeFromImportedSymbols('from kbe import a.b\n').size).toBe(0);
    });

    it('函数内缩进 from-import 同样识别', () => {
      expect(getKbeFromImportedSymbols('def f():\n    from kbe import KBEntity\n'))
        .toEqual(new Set(['KBEntity']));
    });
  });

  describe('类继承头基类定位 getPythonClassBaseAtPosition', () => {
    const locate = (line: string, needle: string) => line.indexOf(needle);

    it('基类首尾列均命中', () => {
      const line = 'class GameObject(Monster):';
      const start = locate(line, 'Monster');
      expect(getPythonClassBaseAtPosition(line, start)).toBe('Monster');
      expect(getPythonClassBaseAtPosition(line, start + 'Monster'.length)).toBe('Monster');
    });

    it('多基类列表按所在段命中', () => {
      const line = 'class Avatar(Monster, kbe.Space):';
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Monster'))).toBe('Monster');
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Space'))).toBe('Space');
    });

    it('类名与括号外不命中', () => {
      const line = 'class Avatar(Monster):';
      expect(getPythonClassBaseAtPosition(line, locate(line, 'class'))).toBeNull();
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Avatar'))).toBeNull();
      expect(getPythonClassBaseAtPosition(line, line.length)).toBeNull();
    });

    it('非继承头(无括号/普通语句)不命中', () => {
      expect(getPythonClassBaseAtPosition('class Avatar:', 0)).toBeNull();
      expect(getPythonClassBaseAtPosition('x = dict(a=1)', 5)).toBeNull();
    });
  });

  describe('访问定位 resolveKbeAccessAtPosition', () => {
    const aliases = getKbeAliases('import KBEngine as kbe\n');

    it('类继承链样例:kbe.KBEntity 的 KBEntity 段命中', () => {
      const line = 'class GameObject(kbe.KBEntity):';
      const start = line.indexOf('KBEntity');
      const access = resolveKbeAccessAtPosition(line, start + 3, aliases);
      expect(access).toEqual({
        alias: 'kbe',
        symbol: 'KBEntity',
        symbolStart: start,
        symbolEnd: start + 'KBEntity'.length
      });
    });

    it('符号首列(含)与末列(含)均命中', () => {
      const line = 'x = kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)?.symbol).toBe('Entity');
      expect(resolveKbeAccessAtPosition(line, start + 'Entity'.length, aliases)?.symbol).toBe('Entity');
    });

    it('符号区间外(模块名上/行首外)不命中', () => {
      const line = 'x = kbe.Entity';
      const moduleStart = line.indexOf('kbe');
      expect(resolveKbeAccessAtPosition(line, moduleStart, aliases)).toBeNull();
      expect(resolveKbeAccessAtPosition(line, 0, aliases)).toBeNull();
    });

    it('嵌套段(kbe.Entity.id 的 id)不属模块面,返回 null', () => {
      const line = 'kbe.Entity.id';
      const idStart = line.indexOf('id');
      expect(resolveKbeAccessAtPosition(line, idStart, aliases)).toBeNull();
    });

    it('未引入别名时不接管', () => {
      expect(resolveKbeAccessAtPosition('x = kbe.Entity', 8, new Set())).toBeNull();
    });

    it('属性链上的同名前缀(self.kbe.x)不接管', () => {
      const line = 'self.kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)).toBeNull();
    });

    it('调用链结果上的同名前缀(getItems().kbe.x)不接管', () => {
      // 点号前是 ')' 的链段:贪婪匹配在 '()' 处断开,'kbe.Entity' 作为新
      // 匹配段起始且前导字符为 '.',落入前置守卫的 continue 分支
      const line = 'getItems().kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)).toBeNull();
    });

    it('非别名模块(os.path)不命中', () => {
      expect(resolveKbeAccessAtPosition('import os.path', 11, aliases)).toBeNull();
    });
  });

  describe('补全语境 getKbeCompletionContext', () => {
    const aliases = getKbeAliases('import kbe\n');

    it('kbe. 与 kbe.partial 语境命中', () => {
      expect(getKbeCompletionContext('x = kbe.', aliases)).toEqual({ alias: 'kbe', partialSymbol: '' });
      expect(getKbeCompletionContext('x = kbe.cr', aliases)).toEqual({ alias: 'kbe', partialSymbol: 'cr' });
    });

    it('KBEngine 别名同款', () => {
      const kb = getKbeAliases('import KBEngine\n');
      expect(getKbeCompletionContext('KBEngine.create', kb)).toEqual({
        alias: 'KBEngine',
        partialSymbol: 'create'
      });
    });

    it('非模块语境(self. 与裸词)不命中', () => {
      expect(getKbeCompletionContext('self.kbe.', aliases)).toBeNull();
      expect(getKbeCompletionContext('kbe', aliases)).toBeNull();
      expect(getKbeCompletionContext('x = ', aliases)).toBeNull();
    });
  });

  describe('符号过滤 filterKbeSymbols', () => {
    it('空串返回全量', () => {
      expect(filterKbeSymbols('')).toEqual(KBE_SYMBOLS);
    });

    it('前缀大小写不敏感', () => {
      const names = filterKbeSymbols('kb').map(entry => entry.name);
      expect(names).toEqual(['KBEntity']);
    });

    it('createEntity 前缀命中全部创建族函数', () => {
      const names = filterKbeSymbols('createEntity').map(entry => entry.name);
      expect(names).toEqual([
        'createEntity',
        'createEntityLocally',
        'createEntityAnywhere',
        'createEntityRemotely',
        'createEntityFromDBID',
        'createEntityAnywhereFromDBID',
        'createEntityRemotelyFromDBID'
      ]);
    });

    it('无匹配返回空数组', () => {
      expect(filterKbeSymbols('zzz')).toEqual([]);
    });
  });

  describe('桩文档 buildKbeStubDocument', () => {
    const stub = buildKbeStubDocument();

    it('每个符号都有唯一声明行,行内容即签名', () => {
      const seen = new Set<number>();
      for (const entry of KBE_SYMBOLS) {
        const lineNo = stub.symbolLines[entry.name];
        expect(lineNo, `${entry.name} 应有桩文档行`).toBeGreaterThan(0);
        expect(seen.has(lineNo), `${entry.name} 声明行应唯一`).toBe(false);
        seen.add(lineNo);
        const lines = stub.content.split('\n');
        expect(lines[lineNo]).toBe(`${entry.signature}:`);
      }
    });

    it('头部注明 kode 提供与 KBEntity 别名口径', () => {
      const lines = stub.content.split('\n');
      expect(lines[0]).toContain('kode 提供');
      expect(stub.content).toContain('KBEntity 为 kode 内置别名');
    });

    it('KBEntity 条目带别名指向与引擎锚点行', () => {
      const kbLine = stub.symbolLines['KBEntity'];
      const lines = stub.content.split('\n');
      // GEN-DEF-1d:docstring 双语(zh+EN 段)加长,窗口放宽到 14 行
      const body = lines.slice(kbLine, kbLine + 14).join('\n');
      expect(body).toContain('Entity');
      expect(body).toContain('typings/_KBEngine_common.pyi:67');
    });
  });

  describe('KBEngine 运行时容器类型(GEN-DEF-1b)', () => {
    it('桩面定义 FixedArray/FixedDict 完整方法体,签名对齐 fixedarray.h/fixeddict.h', () => {
      const content = buildKbeStubDocument().content;
      // FixedArray:script::Sequence 语义,append/extend/insert/remove 返回 bool,
      // pop 返回被弹出元素(非 Python list 的 None 语义)
      expect(content).toContain('class FixedArray(Generic[T]):');
      expect(content).toContain('def append(self, item: T) -> bool: ...');
      expect(content).toContain('def count(self, item: T) -> int: ...');
      expect(content).toContain('def extend(self, iterable: Iterable[T]) -> bool: ...');
      expect(content).toContain('def index(self, item: T) -> int: ...');
      expect(content).toContain('def insert(self, index: int, item: T) -> bool: ...');
      expect(content).toContain('def pop(self, index: int = -1) -> T: ...');
      expect(content).toContain('def remove(self, item: T) -> bool: ...');
      expect(content).toContain('def clear(self) -> None: ...');
      expect(content).toContain('def __getitem__(self, index: int) -> T: ...');
      expect(content).toContain('def __setitem__(self, index: int, value: T) -> None: ...');
      expect(content).toContain('def __iter__(self) -> Iterator[T]: ...');
      expect(content).toContain('def __contains__(self, item: T) -> bool: ...');
      // FixedDict:script::Map 语义,键集合按 def 固定
      expect(content).toContain('class FixedDict(Mapping[str, Any]):');
      expect(content).toContain('def has_key(self, key: str) -> bool: ...');
      expect(content).toContain('def keys(self) -> KeysView[str]: ...');
      expect(content).toContain('def values(self) -> ValuesView[Any]: ...');
      expect(content).toContain('def items(self) -> ItemsView[str, Any]: ...');
      expect(content).toContain('def get(self, key: str, default: Any = None) -> Any: ...');
      expect(content).toContain('def update(self, *args: Any, **kwargs: Any) -> None: ...');
    });

    it('容器类在 KBE_SYMBOLS 索引,补全/跳转可命中', () => {
      expect(getKbeSymbol('FixedArray')?.kind).toBe('class');
      expect(getKbeSymbol('FixedDict')?.kind).toBe('class');
      const names = filterKbeSymbols('Fixed').map(entry => entry.name);
      expect(names).toContain('FixedArray');
      expect(names).toContain('FixedDict');
    });

    it('桩文档 symbolLines 指向容器类声明行,行内容即签名(跳转不落空)', () => {
      const stub = buildKbeStubDocument();
      const lines = stub.content.split('\n');
      for (const name of ['FixedArray', 'FixedDict']) {
        const entry = getKbeSymbol(name)!;
        const lineNo = stub.symbolLines[name];
        expect(lineNo, `${name} 应有桩文档行`).toBeGreaterThan(0);
        expect(lines[lineNo]).toBe(`${entry.signature}:`);
      }
      // 容器体在桩文档与方法体同源(跳转后可见完整方法面)
      expect(stub.content).toContain('def append(self, item: T) -> bool: ...');
    });
  });

  describe('KBEngine 运行时向量类型(GEN-DEF-1c)', () => {
    it('桩面定义 Vector2/3/4 完整方法体,签名对齐 vector2/3/4.h', () => {
      const content = buildKbeStubDocument().content;
      // Vector2:两个分量,distTo/distSqrTo/cross2D/dot 返回 float,scale 返回
      // 新向量,normalise/set 就地返回 None,tuple()/list() 定长返回。
      expect(content).toContain('class Vector2:');
      expect(content).toContain('    x: float');
      expect(content).toContain('    y: float');
      expect(content).toContain('    length: float');
      expect(content).toContain('    lengthSquared: float');
      expect(content).toContain('def distTo(self, other: Vector2) -> float: ...');
      expect(content).toContain('def scale(self, factor: float) -> Vector2: ...');
      expect(content).toContain('def normalise(self) -> None: ...');
      expect(content).toContain('def set(self, *args: float) -> None: ...');
      expect(content).toContain('def tuple(self) -> Tuple[float, float]: ...');
      expect(content).toContain('def list(self) -> List[float]: ...');
      expect(content).toContain('def __add__(self, other: Vector2) -> Vector2: ...');
      // Vector3 独有:XZ 平面距离 + z 分量
      expect(content).toContain('class Vector3:');
      expect(content).toContain('    z: float');
      expect(content).toContain('def flatDistTo(self, other: Vector3) -> float: ...');
      expect(content).toContain('def tuple(self) -> Tuple[float, float, float]: ...');
      // Vector4 独有:w 分量
      expect(content).toContain('class Vector4:');
      expect(content).toContain('    w: float');
      expect(content).toContain('def tuple(self) -> Tuple[float, float, float, float]: ...');
    });

    it('向量类在 KBE_SYMBOLS 索引,补全/跳转可命中', () => {
      expect(getKbeSymbol('Vector2')?.kind).toBe('class');
      expect(getKbeSymbol('Vector3')?.kind).toBe('class');
      expect(getKbeSymbol('Vector4')?.kind).toBe('class');
      expect(getKbeSymbol('Vector3')?.cppClassName).toBe('ScriptVector3');
      const names = filterKbeSymbols('Vector').map(entry => entry.name);
      expect(names).toEqual(['Vector2', 'Vector3', 'Vector4']);
    });

    it('桩文档 symbolLines 指向向量类声明行,行内容即签名(跳转不落空)', () => {
      const stub = buildKbeStubDocument();
      const lines = stub.content.split('\n');
      for (const name of ['Vector2', 'Vector3', 'Vector4']) {
        const entry = getKbeSymbol(name)!;
        const lineNo = stub.symbolLines[name];
        expect(lineNo, `${name} 应有桩文档行`).toBeGreaterThan(0);
        expect(lines[lineNo]).toBe(`${entry.signature}:`);
      }
      expect(stub.content).toContain('def distSqrTo(self, other: Vector3) -> float: ...');
    });
  });
});

describe.skipIf(!engineRoot)('kbe 符号索引 vs 引擎 typings 源码', () => {
  it('每条符号的 sourceFile:sourceLine 落在引擎 typings 的对应声明行', () => {
    for (const entry of KBE_SYMBOLS) {
      // Vector2/3/4 的 Python 暴露名(Vector3)≠ C++ 类名(ScriptVector3),
      // 锚点行按 C++ 类名匹配 `class ScriptVector3`(cppClassName 字段)。
      const declName = entry.cppClassName ?? entry.aliasOf ?? entry.name;
      const stubPath = path.join(engineRoot!, entry.sourceFile);
      const lines = fs.readFileSync(stubPath, 'utf8').split('\n');
      const declLine = lines[entry.sourceLine - 1];
      expect(
        declLine,
        `${entry.name} 锚点 ${entry.sourceFile}:${entry.sourceLine} 应存在`
      ).toBeDefined();
      const keyword = entry.kind === 'class' ? 'class' : 'def';
      expect(
        declLine.startsWith(`${keyword} ${declName}`),
        `${entry.name} 锚点行应为 "${keyword} ${declName}",实得: ${declLine}`
      ).toBe(true);
    }
  });
});

// GEN-DEF-1d:API 索引条目双语契约——每条 zh(summary)+en(summaryEn) 双字段
// 必填非空(缺一 TS 类型级报错,这里运行时锁非空),summaryForLanguage 按
// IDE 语言选文案(zh 前缀取中文,其余取英文,缺位回落英文)。
describe('KBEngine API 索引条目双语契约(GEN-DEF-1d)', () => {
  it('每条符号 zh+en 双字段必填非空', () => {
    for (const entry of KBE_SYMBOLS) {
      expect(entry.summary.trim(), `${entry.name} zh summary 非空`).not.toBe('');
      expect(entry.summaryEn.trim(), `${entry.name} en summaryEn 非空`).not.toBe('');
    }
  });

  it('summaryForLanguage 按 IDE 语言选择(zh 前缀取中文,其余英文)', () => {
    const entry = KBE_SYMBOLS.find(s => s.name === 'Entity')!;
    expect(summaryForLanguage(entry, 'zh-cn')).toBe(entry.summary);
    expect(summaryForLanguage(entry, 'zh-tw')).toBe(entry.summary);
    expect(summaryForLanguage(entry, 'en')).toBe(entry.summaryEn);
    expect(summaryForLanguage(entry, undefined)).toBe(entry.summaryEn);
    expect(summaryForLanguage(entry, 'fr')).toBe(entry.summaryEn);
  });

  it('桩文档 docstring 双语言并陈(中文段 + EN 段)', () => {
    const stub = buildKbeStubDocument();
    const kbLine = stub.symbolLines['Entity'];
    const lines = stub.content.split('\n');
    const doc = lines.slice(kbLine, kbLine + 12).join('\n');
    expect(doc).toContain('引擎实体基类');
    expect(doc).toContain('EN: Engine entity base class');
  });
});

describe('KB-VER-002 版本分层标注', () => {
  const entity = KBE_SYMBOLS.find(s => s.name === 'Entity')!;
  const memoryStream = KBE_SYMBOLS.find(s => s.name === 'MemoryStream')!;
  const forkEntry = { version: 'fork' as const };

  it('条目版本归属仅三档,MemoryStream 为唯一非基线(待取证)', () => {
    for (const entry of KBE_SYMBOLS) {
      const v = entry.version ?? 'baseline';
      expect(['baseline', 'fork', 'pending']).toContain(v);
    }
    expect(memoryStream.version).toBe('pending');
    // 其余条目均基线(依各 api-*.md deviation 表:35 条目无 fork-3.12 新增符号)
    const nonBaseline = KBE_SYMBOLS.filter(s => (s.version ?? 'baseline') !== 'baseline');
    expect(nonBaseline.map(s => s.name)).toEqual(['MemoryStream']);
  });

  it('engineApiVersionAnnotation:基线条目恒无标注(双语)', () => {
    expect(engineApiVersionAnnotation(entity, '3.7.3', 'zh')).toBeNull();
    expect(engineApiVersionAnnotation(entity, 'fork-3.12', 'en')).toBeNull();
    expect(engineApiVersionAnnotation({}, '3.7.3', 'zh')).toBeNull();
  });

  it('engineApiVersionAnnotation:pending 恒标「待取证」,与引擎版本无关', () => {
    expect(engineApiVersionAnnotation(memoryStream, '3.7.3', 'zh')).toContain('待取证');
    expect(engineApiVersionAnnotation(memoryStream, 'fork-3.12', 'zh')).toContain('待取证');
    expect(engineApiVersionAnnotation(memoryStream, '3.7.3', 'en')).toContain('to be evidenced');
  });

  it('engineApiVersionAnnotation:fork 条目仅在基线引擎下标「需 fork」', () => {
    // 默认/官方基线(3.7.3 / 3.6.3)→ 标注
    expect(engineApiVersionAnnotation(forkEntry, '3.7.3', 'zh')).toContain('需 fork');
    expect(engineApiVersionAnnotation(forkEntry, '3.7.3', 'en')).toContain('requires fork');
    expect(engineApiVersionAnnotation(forkEntry, '3.6.3', 'zh')).toContain('需 fork');
    // fork- 前缀(任意大小写/首尾空白)→ 视为魔改 fork 已含,不标注
    expect(engineApiVersionAnnotation(forkEntry, 'fork-3.12', 'zh')).toBeNull();
    expect(engineApiVersionAnnotation(forkEntry, 'FORK-3.12 ', 'zh')).toBeNull();
    expect(engineApiVersionAnnotation(forkEntry, '  fork', 'zh')).toBeNull();
  });

  it('kbeCompletionDocumentation:基线条目无版本注,待取证条目带注', () => {
    const base = kbeCompletionDocumentation(entity, 'zh', '3.7.3');
    expect(base).toContain(entity.summary);
    expect(base).toContain(`原始声明: \`${entity.sourceFile}:${entity.sourceLine}\``);
    expect(base).not.toContain('待取证');
    expect(base).not.toContain('需 fork');
    const msDoc = kbeCompletionDocumentation(memoryStream, 'zh', '3.7.3');
    expect(msDoc).toContain('待取证');
    expect(msDoc).toContain(`原始声明: \`${memoryStream.sourceFile}:${memoryStream.sourceLine}\``);
  });

  it('桩文档与导出 .pyi 的 MemoryStream docstring 带版本归属注', () => {
    const stub = buildKbeStubDocument();
    const msLine = stub.symbolLines['MemoryStream'];
    const lines = stub.content.split('\n');
    const doc = lines.slice(msLine, msLine + 14).join('\n');
    expect(doc).toContain('待取证');
    expect(stub.content).toContain('版本标注 / version:');
  });
});

// KR-AUD-33:`import os, kbe` 逗号行此前不匹配 `/^\s*import\s+(KBEngine|kbe)\b/`
// (kbe 不紧跟 import),别名集合为空 → 本文件不接管导航/补全。修复:先取
// import 名单再逐名识别,逗号混入其他模块不影响 kbe 别名注册。
describe('KR-AUD-33: 逗号混排 import 的 kbe 别名', () => {
  it('import os, kbe 注册 kbe 别名(整文件接管前提)', async () => {
    const { getKbeAliases } = await import('../src/kbeModuleIndex');
    expect(getKbeAliases('import os, kbe\n')).toEqual(new Set(['kbe']));
    expect(getKbeAliases('import kbe, os\n')).toEqual(new Set(['kbe']));
    expect(getKbeAliases('import os, kbe as kb\n')).toEqual(new Set(['kb']));
    expect(getKbeAliases('import sys, json\n')).toEqual(new Set());
    expect(getKbeAliases('import kbe as kb, os\nimport KBEngine\n')).toEqual(new Set(['kb', 'KBEngine']));
  });
});

// G2 用户令 2026-11-09:生成的 .pyi 曾满篇未绑定名(签名引用 Dict/Callable/
// Union/Address/WatcherValue/Callback/Vector3Like 却既不导入也不定义,
// Pylance/mypy 逐条报 undefined,类型面残缺)。自洽回归闸:签名/别名行上
// 每个大写初始标识符必须被导入或在本文件定义——机器全量扫,新增签名引用
// 新名字时漏定义直接红,不靠人眼盘点。
describe('生成 .pyi 自洽(签名引用名全部已定义或导入)', () => {
  const faces: Array<{ content: string; label: string }> = [
    { content: buildKbeStubDocument().content, label: 'virtual stub doc' }
  ];

  for (const face of faces) {
    it(`${face.label}: 大写初始引用名 ⊆ 导入∪本文件定义(自洽闸)`, () => {
      const lines = face.content.split('\n');
      const defined = new Set<string>();
      for (const ln of lines) {
        const def = /^(?:class|def)\s+(\w+)/.exec(ln) ?? /^(\w+)\s*=/.exec(ln);
        if (def) {
          defined.add(def[1]);
        }
      }
      const importBlock = /from typing import \(([^)]*)\)/.exec(face.content);
      const imported = new Set<string>(
        (importBlock?.[1] ?? '').split(',').map(name => name.trim()).filter(Boolean)
      );
      // 大写初始内建字面量不在扫描面(None/True/False);小写首字母是参数名
      // 与内建类型(str/int/float/bool/bytes),不在本闸扫描面。
      const builtinLiterals = new Set(['None', 'True', 'False']);
      const violations: string[] = [];
      for (const ln of lines) {
        const stripped = ln.trim();
        if (!stripped || stripped.startsWith('#')) {
          continue;
        }
        const isSignatureOrAlias = /^(?:def |class |@)/.test(stripped) || /^\w+\s*=/.test(stripped);
        if (!isSignatureOrAlias) {
          continue;
        }
        for (const match of stripped.matchAll(/\b([A-Z]\w*)\b/g)) {
          const name = match[1];
          if (!defined.has(name) && !imported.has(name) && !builtinLiterals.has(name)) {
            violations.push(`${name}: ${stripped}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('桩面定义引擎域别名且 typing 导入补齐 Callable/Dict/Union', () => {
    const content = buildKbeStubDocument().content;
    expect(content).toContain('Address = int');
    expect(content).toContain('Callback = Callable[..., None]');
    expect(content).toContain('WatcherValue = Any');
    expect(content).toContain('Vector3Like = Union[Vector3, Tuple[float, float, float], List[float]]');
    const importBlock = /from typing import \(([^)]*)\)/.exec(content)?.[1] ?? '';
    expect(importBlock).toContain('Callable');
    expect(importBlock).toContain('Dict');
    expect(importBlock).toContain('Union');
  });

  it('别名置于 Vector3 类定义之后(发射序保定义先于使用)', () => {
    const content = buildKbeStubDocument().content;
    const vectorClass = content.indexOf('class Vector3:');
    const alias = content.indexOf('Vector3Like = Union[');
    expect(vectorClass).toBeGreaterThan(-1);
    expect(alias).toBeGreaterThan(vectorClass);
  });
});
