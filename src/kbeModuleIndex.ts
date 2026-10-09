// kbe 模块符号索引(批108,kbe.KBEntity 导航缺失修复):
// 用户项目以 `class GameObject(kbe.KBEntity)` 的形态继承内置基类,但 kbe
// 模块符号此前无任何来源——kode 无内置索引,python 扩展只认真实 import
// 路径,go-to-definition/completion 全部落空。本模块提供 kode 内置的
// kbe/KBEngine 模块符号索引(桩文档跳转源 + 补全表):
// - 符号面以 KBEngine 引擎源码 typings 包为唯一事实源(各条目带
//   sourceFile:sourceLine,tests/kbeModuleIndex.test.ts 的引擎源码条件
//   用例逐条回验;引擎检出缺席时该组用例 skip,与 hooks/metadata 同口径);
// - KBEntity 是 kode 提供的别名条目(对齐项目侧 `kbe.KBEntity` 基类习惯,
//   实体指向引擎 Entity 基类),桩文档里如实标注,不伪装成引擎原生符号;
// - 纯模块,不 import vscode;跳转目标以 { scheme, path, line } 交给
//   languageProviders 装配成 vscode.Location,桩内容由 extension.ts 的
//   TextDocumentContentProvider 按 scheme 提供。

export const KBE_SCHEME = 'kbe-stub';
export const KBE_STUB_PATH = '/KBEngine.pyi';

export type KbeSymbolKind = 'class' | 'function';

export interface KbeSymbolEntry {
  name: string;
  kind: KbeSymbolKind;
  /** 桩文档与补全详情里展示的签名 */
  signature: string;
  /** 一句话说明(桩文档 docstring 与补全 documentation 复用) */
  summary: string;
  /** 引擎 typings 内的锚点文件(相对引擎仓库根) */
  sourceFile: string;
  /** 引擎 typings 内 class/def 声明行(1 起) */
  sourceLine: number;
  /** kode 别名条目指向的正式符号名(KBEntity → Entity) */
  aliasOf?: string;
}

const COMMON_STUB = 'typings/_KBEngine_common.pyi';
const BASEAPP_STUB = 'typings/_KBEngine_baseapp.pyi';

export const KBE_SYMBOLS: KbeSymbolEntry[] = [
  {
    name: 'KBEntity',
    kind: 'class',
    signature: 'class KBEntity(Entity)',
    summary:
      'kode 内置别名:对齐项目侧 `kbe.KBEntity` 基类习惯,实体指向引擎 Entity 基类(非引擎原生符号)。' +
      '实体脚本继承它即可获得 id/className/cell/base 等实体属性与生命周期钩子。',
    sourceFile: COMMON_STUB,
    sourceLine: 52,
    aliasOf: 'Entity'
  },
  {
    name: 'Entity',
    kind: 'class',
    signature: 'class Entity',
    summary:
      '引擎实体基类(baseapp/cellapp 侧实体脚本基类):id/className/client/cell/base/databaseID 属性与 ' +
      'addTimer/destroy 等实体方法,以及 onDestroy 等生命周期钩子。',
    sourceFile: COMMON_STUB,
    sourceLine: 52
  },
  {
    name: 'Proxy',
    kind: 'class',
    signature: 'class Proxy(Entity)',
    summary: '账号代理实体基类,携带 __ACCOUNT_NAME__/__ACCOUNT_PASSWORD__ 协议字段。',
    sourceFile: COMMON_STUB,
    sourceLine: 119
  },
  {
    name: 'Space',
    kind: 'class',
    signature: 'class Space(Entity)',
    summary: '空间实体基类。',
    sourceFile: COMMON_STUB,
    sourceLine: 139
  },
  {
    name: 'EntityComponent',
    kind: 'class',
    signature: 'class EntityComponent',
    summary: '实体组件基类:client/cell/base EntityCall 引用与实体生命周期钩子。',
    sourceFile: COMMON_STUB,
    sourceLine: 142
  },
  {
    name: 'Entities',
    kind: 'class',
    signature: 'class Entities(Dict[int, Entity])',
    summary: '实体表:entityID → Entity 映射。',
    sourceFile: COMMON_STUB,
    sourceLine: 155
  },
  {
    name: 'EntityCall',
    kind: 'class',
    signature: 'class EntityCall',
    summary: '实体远程调用句柄基类:getComponent 取组件 EntityCall。',
    sourceFile: COMMON_STUB,
    sourceLine: 27
  },
  {
    name: 'BaseEntityCall',
    kind: 'class',
    signature: 'class BaseEntityCall(EntityCall)',
    summary: 'baseapp 侧实体远程调用句柄。',
    sourceFile: COMMON_STUB,
    sourceLine: 38
  },
  {
    name: 'CellEntityCall',
    kind: 'class',
    signature: 'class CellEntityCall(EntityCall)',
    summary: 'cellapp 侧实体远程调用句柄。',
    sourceFile: COMMON_STUB,
    sourceLine: 39
  },
  {
    name: 'ClientEntityCall',
    kind: 'class',
    signature: 'class ClientEntityCall(EntityCall)',
    summary: '客户端实体远程调用句柄。',
    sourceFile: COMMON_STUB,
    sourceLine: 40
  },
  {
    name: 'EntityComponentCall',
    kind: 'class',
    signature: 'class EntityComponentCall(EntityCall)',
    summary: '实体组件远程调用句柄。',
    sourceFile: COMMON_STUB,
    sourceLine: 41
  },
  {
    name: 'MemoryStream',
    kind: 'class',
    signature: 'class MemoryStream',
    summary: '二进制流:append/pop 按 dataType 读写,常用于自定义协议打包。',
    sourceFile: COMMON_STUB,
    sourceLine: 43
  },
  {
    name: 'address',
    kind: 'function',
    signature: 'def address() -> Address',
    summary: '当前组件进程的监听地址。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 18
  },
  {
    name: 'time',
    kind: 'function',
    signature: 'def time() -> int',
    summary: '引擎游戏时间(秒,游戏节拍)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 19
  },
  {
    name: 'isShuttingDown',
    kind: 'function',
    signature: 'def isShuttingDown() -> bool',
    summary: '进程是否正在关闭。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 20
  },
  {
    name: 'getWatcher',
    kind: 'function',
    signature: 'def getWatcher(path: str) -> WatcherValue',
    summary: '读取 watcher 指标值(监控面板数据源同款)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 21
  },
  {
    name: 'getWatcherDir',
    kind: 'function',
    signature: 'def getWatcherDir(path: str) -> Tuple[str, ...]',
    summary: '列出 watcher 目录下的组件/路径。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 22
  },
  {
    name: 'addWatcher',
    kind: 'function',
    signature: 'def addWatcher(path: str, dataType: str, getFunction: Callable[[], WatcherValue]) -> None',
    summary: '注册自定义 watcher 指标。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 23
  },
  {
    name: 'delWatcher',
    kind: 'function',
    signature: 'def delWatcher(path: str) -> None',
    summary: '注销自定义 watcher 指标。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 28
  },
  {
    name: 'setAppFlags',
    kind: 'function',
    signature: 'def setAppFlags(flags: int) -> None',
    summary: '设置进程 flags 位。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 29
  },
  {
    name: 'getAppFlags',
    kind: 'function',
    signature: 'def getAppFlags() -> int',
    summary: '读取进程 flags 位。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 30
  },
  {
    name: 'reloadScript',
    kind: 'function',
    signature: 'def reloadScript(fullReload: bool = False) -> None',
    summary: '热更脚本(与 kode 热更新支持面板同一入口)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 31
  },
  {
    name: 'quantumPassedPercent',
    kind: 'function',
    signature: 'def quantumPassedPercent() -> int',
    summary: '当前时间片推进百分比。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 32
  },
  {
    name: 'createEntity',
    kind: 'function',
    signature: 'def createEntity(entityType: str, params: Union[Dict[str, Any], None] = None) -> Union[Entity, None]',
    summary: '本地创建实体(同步返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 33
  },
  {
    name: 'createEntityLocally',
    kind: 'function',
    signature: 'def createEntityLocally(entityType: str, params: Union[Dict[str, Any], None] = None) -> Union[Entity, None]',
    summary: '在本进程创建实体(同步返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 37
  },
  {
    name: 'createEntityAnywhere',
    kind: 'function',
    signature: 'def createEntityAnywhere(entityType: str, params: Union[Dict[str, Any], None] = None, callback: Union[Callback, None] = None) -> None',
    summary: '在任意合适进程创建实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 41
  },
  {
    name: 'createEntityRemotely',
    kind: 'function',
    signature: 'def createEntityRemotely(entityType: str, baseMB: BaseEntityCall, params: Union[Dict[str, Any], None] = None, callback: Union[Callback, None] = None) -> None',
    summary: '在指定 base 实体所在进程创建实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 46
  },
  {
    name: 'createEntityFromDBID',
    kind: 'function',
    signature: 'def createEntityFromDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 创建实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 52
  },
  {
    name: 'createEntityAnywhereFromDBID',
    kind: 'function',
    signature: 'def createEntityAnywhereFromDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 在任意进程创建实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 58
  },
  {
    name: 'createEntityRemotelyFromDBID',
    kind: 'function',
    signature: 'def createEntityRemotelyFromDBID(entityType: str, dbID: int, baseMB: BaseEntityCall, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 在指定 base 实体所在进程创建实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 64
  },
  {
    name: 'charge',
    kind: 'function',
    signature: 'def charge(ordersID: str, dbID: int, byteDatas: bytes, pycallback: Union[Callback, None] = None) -> None',
    summary: '提交计费订单(回调返回计费结果)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 71
  },
  {
    name: 'deleteEntityByDBID',
    kind: 'function',
    signature: 'def deleteEntityByDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 删除实体(回调返回)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 77
  },
  {
    name: 'lookUpEntityByDBID',
    kind: 'function',
    signature: 'def lookUpEntityByDBID(entityType: str, dbID: int, callback: Callback, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 查找已存在实体(回调返回 EntityCall)。',
    sourceFile: BASEAPP_STUB,
    sourceLine: 83
  }
];

const KBE_SYMBOL_BY_NAME = new Map(KBE_SYMBOLS.map(entry => [entry.name, entry]));

export function getKbeSymbol(name: string): KbeSymbolEntry | null {
  return KBE_SYMBOL_BY_NAME.get(name) ?? null;
}

/**
 * 识别本文档引入的 kbe/KBEngine 模块别名(import X / import X as Y /
 * from X import ...),返回别名集合。无任何引入时返回空集——此时不接管
 * 导航/补全,交回 python 扩展,避免误吞普通标识符。
 */
export function getKbeAliases(documentText: string): Set<string> {
  const aliases = new Set<string>();
  const importPattern = /^\s*(?:import|from)\s+(KBEngine|kbe)\b(?:\s+as\s+(\w+))?/gm;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(documentText)) !== null) {
    aliases.add(match[2] ?? match[1]);
  }
  return aliases;
}

/**
 * 识别 from-import 引入的 kbe/KBEngine 符号名(from kbe import KBEntity,
 * 支持逗号多名字与括号跨名字面),供类继承头裸名(`class X(KBEntity)`)
 * 的桩定位使用。引擎类名注册口径要求实体类继承 KBEngine 基类子孙
 * (entitydef.cpp:2317-2325,见 docs/source-analysis.md),故继承头里的
 * kbe 裸名按模块符号解析。
 */
export function getKbeFromImportedSymbols(documentText: string): Set<string> {
  const symbols = new Set<string>();
  const collect = (raw: string): void => {
    for (const rawName of raw.replace(/[()\\]/g, '').split(',')) {
      const name = rawName.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) {
        symbols.add(name);
      }
    }
  };

  // 括号字面(可跨行):from kbe import (A,\n  B)
  const parenPattern = /^\s*from\s+(?:KBEngine|kbe)\s+import\s*\(([^)]*)\)/gm;
  let match: RegExpExecArray | null;
  while ((match = parenPattern.exec(documentText)) !== null) {
    collect(match[1]);
  }

  // 单行形态:from kbe import A, B
  const linePattern = /^\s*from\s+(?:KBEngine|kbe)\s+import\s+(.+)$/gm;
  while ((match = linePattern.exec(documentText)) !== null) {
    collect(match[1]);
  }

  return symbols;
}

/**
 * 类继承头基类定位:class X(A, B) 行,position 落在基类标识符(含首尾列)
 * 上时返回该基类名;落在类名上或括号外返回 null。单行口径——多行继承表
 * 不在本行,交回 python 扩展。
 */
export function getPythonClassBaseAtPosition(
  lineText: string,
  character: number
): string | null {
  const header = /^\s*class\s+[A-Za-z_]\w*\s*\(([^()]*)\)/.exec(lineText);
  if (!header) {
    return null;
  }

  const basesStart = header.index + header[0].length - header[1].length - 1;
  const identPattern = /[A-Za-z_]\w*/g;
  let ident: RegExpExecArray | null;
  while ((ident = identPattern.exec(header[1])) !== null) {
    const start = basesStart + ident.index;
    const end = start + ident[0].length;
    if (character >= start && character <= end) {
      return ident[0];
    }
  }
  return null;
}

export interface KbeAccess {
  alias: string;
  symbol: string;
  /** 符号在行内的 0 起始列区间(用于位置命中判断与悬停范围) */
  symbolStart: number;
  symbolEnd: number;
}

/**
 * 解析行内 `alias.Symbol` 访问:alias 必须在已引入集合内,且 position 落在
 * 符号首段上(kbe.KBEntity 的 KBEntity)。嵌套段(kbe.Entity.id 的 id)不属
 * 模块面,返回 null 交回常规链路。
 */
export function resolveKbeAccessAtPosition(
  lineText: string,
  character: number,
  aliases: Set<string>
): KbeAccess | null {
  if (aliases.size === 0) {
    return null;
  }
  const accessPattern = /\b(\w+)\.(\w+(?:\.\w+)*)/g;
  let match: RegExpExecArray | null;
  while ((match = accessPattern.exec(lineText)) !== null) {
    const alias = match[1];
    if (!aliases.has(alias)) {
      continue;
    }
    // 别名前若是 '.',说明是 self.kbe 这类属性访问而非模块访问,不接管
    if (match.index > 0 && lineText[match.index - 1] === '.') {
      continue;
    }
    const symbol = match[2].split('.')[0];
    const symbolStart = match.index + alias.length + 1;
    const symbolEnd = symbolStart + symbol.length;
    if (character >= symbolStart && character <= symbolEnd) {
      return { alias, symbol, symbolStart, symbolEnd };
    }
  }
  return null;
}

/**
 * 补全语境:行前缀以已引入别名加 '.'(可带未完成符号段)结尾时命中,
 * 返回待过滤的部分符号;否则 null。
 */
export function getKbeCompletionContext(
  linePrefix: string,
  aliases: Set<string>
): { alias: string; partialSymbol: string } | null {
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${alias}\\.(\\w*)$`);
    const match = pattern.exec(linePrefix);
    // 别名前若是 '.',说明是 self.kbe 这类属性访问而非模块访问,不接管
    // (\b 在 '.' 与首字母之间仍成立,与 resolveKbeAccessAtPosition 同款守卫)
    if (match && !(match.index > 0 && linePrefix[match.index - 1] === '.')) {
      return { alias, partialSymbol: match[1] };
    }
  }
  return null;
}

/** 按部分符号过滤索引(前缀匹配,大小写不敏感;空串返回全量) */
export function filterKbeSymbols(partialSymbol: string): KbeSymbolEntry[] {
  const partialLower = partialSymbol.toLowerCase();
  if (!partialLower) {
    return KBE_SYMBOLS;
  }
  return KBE_SYMBOLS.filter(entry => entry.name.toLowerCase().startsWith(partialLower));
}

export interface KbeStubDocument {
  content: string;
  /** 符号名 → 桩文档内 class/def 声明行(0 起) */
  symbolLines: Record<string, number>;
}

/** 生成只读桩文档:逐符号 class/def + docstring + 引擎 typings 锚点 */
export function buildKbeStubDocument(): KbeStubDocument {
  const lines: string[] = [
    '# KBEngine Python API 内置桩(kode 提供,只读)',
    '#',
    '# 跳转目标为本桩文档;各符号下方标注引擎源码 typings 锚点',
    '# (sourceFile:sourceLine,逐条可回验)。',
    '# KBEntity 为 kode 内置别名(= Entity),对齐项目侧 kbe.KBEntity 基类习惯。',
    ''
  ];
  const symbolLines: Record<string, number> = {};
  let lastKind: KbeSymbolKind | null = null;
  for (const entry of KBE_SYMBOLS) {
    if (lastKind !== entry.kind) {
      lines.push('');
      lastKind = entry.kind;
    }
    symbolLines[entry.name] = lines.length;
    lines.push(`${entry.signature}:`);
    for (const docLine of wrapSummary(entry.summary)) {
      lines.push(`    """${docLine}"""`);
    }
    if (entry.aliasOf) {
      lines.push(`    # kode 别名:实体指向 ${entry.aliasOf}`);
    }
    lines.push(`    # 源码: ${entry.sourceFile}:${entry.sourceLine}`);
  }
  return { content: lines.join('\n'), symbolLines };
}

/** 摘要按固定宽度折行,保持桩文档在常规窗口宽度可读 */
function wrapSummary(summary: string, width = 72): string[] {
  const words = summary.split(' ');
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      wrapped.push(current);
      current = word;
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  // 不可达(批109 定性):summary 全部来自 KBE_SYMBOLS 字面量且均非空,
  // split(' ') 至少产出一个词,循环结束时 current 恒非空,假臂无触发
  // 路径(唯一调用方 buildKbeStubDocument,无外部入参来源)。
  /* istanbul ignore start */
  if (current) {
    wrapped.push(current);
  }
  /* istanbul ignore stop */
  return wrapped;
}

/** 跳转目标的 URI 字符串(装配侧 vscode.Uri.parse 成 Location) */
export function buildKbeStubUriString(): string {
  return `${KBE_SCHEME}:${KBE_STUB_PATH}`;
}
