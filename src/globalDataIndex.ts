import * as vscode from 'vscode';
import { findFilesAcrossRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE } from './pythonScanRules';
import { getKbeAliases } from './kbeModuleIndex';

// GLOBDATA-001(2026-10-30 用户令):KBEngine.globalData / baseAppData /
// cellAppData 三个跨进程数据字典的键访问索引。引擎侧事实(源码核验,
// /home/cui/workspaces/kbengine):三者为 GlobalDataClient(Dict[str, Any])
// 模块属性,key/value 经 script::Pickler(pickle.dumps)序列化→dbmgr
// GlobalDataServer 广播→接收侧 Pickler::unpickle 还原同一 Python 对象
// (globaldata_client.cpp:98-104、entity_app.h:1261-1308)——一侧设置的
// 类型在另一侧可恢复,故写点值类型可在读点推导。拓扑:globalData→全部
// 进程、baseAppData→仅 baseapp、cellAppData→仅 cellapp(globaldata_
// server.cpp:60-110)。
//
// 键粒度(用户定口径):字符串字面量按键值、标识符按键名文本;计算键
// `"SERVER_" + str(id)` / f"SERVER_{id}" 归一化为「字面量骨架 + `*` 通配」
// 签名(如 SERVER_*),同签名即同键族互链;全动态(a + b,无字面量锚点)
// 不索引。写点 `[K] = RHS`(增强赋值算写但无值类型)、读点 `[K]` 与
// `.get(K[, default])`。纯逻辑扫描面不依赖 vscode,索引类仿 WorkspaceIndex
// (cache/revisions/building + findFilesAcrossRoots + watcher + noteSaved)。

/** KBEngine 模块级跨进程数据字典名(接收者必须是已引入的 kbe 别名) */
export const KBENGINE_DATA_DICTS = ['globalData', 'baseAppData', 'cellAppData'] as const;
export type KbeDataDictName = (typeof KBENGINE_DATA_DICTS)[number];

/** 一处字典键访问(单行口径;跨行/括号不闭合不取) */
export interface KbeDataDictAccess {
  dict: KbeDataDictName;
  /** 归一化键签名:字面量→原值、标识符→名字、计算键→字面量骨架+`*` */
  keySignature: string;
  /** 行号(0 起) */
  line: number;
  /** 键表达式起始列(0 起,行内) */
  keyStart: number;
  /** 键表达式尾后一列 */
  keyEnd: number;
  kind: 'write' | 'read';
  /** 写点 RHS 直文本(增强赋值/无值时 null) */
  valueText: string | null;
}

/** 索引查询命中的一个访问点(带文件) */
export interface KbeDataDictSite extends KbeDataDictAccess {
  file: string;
}

const DATA_DICT_PATTERN = new RegExp(`(\\w+)\\.(${KBENGINE_DATA_DICTS.join('|')})\\b`, 'g');

/** 增强赋值符(算写点,但值类型不可推);长符在前防前缀截断 */
const AUGMENTED_ASSIGN_OPS = [
  '**=', '//=', '<<=', '>>=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='
].sort((a, b) => b.length - a.length);

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * 归一化键签名。精确形态(字符串字面量解引/标识符/数字字面量)→原文;
 * f-string 与顶层 `+` 拼接(至少一个字面量段)→字面量骨架+`*` 通配
 * (f"SERVER_{id}" → SERVER_*,"A"+str(x)+"B" → A*B);全动态/复杂表达式
 * → null(不索引,不硬猜)。
 */
export function normalizeKeySignature(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const literal = matchStringLiteral(trimmed);
  if (literal !== null) {
    return literal;
  }
  if (/^[A-Za-z_]\w*$/.test(trimmed) || NUMERIC_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const fstring = matchFStringSignature(trimmed);
  if (fstring !== null) {
    return fstring;
  }
  return matchConcatSignature(trimmed);
}

/** 单段字符串字面量 → 解引内容;非字面量/含未转义同引号 → null */
function matchStringLiteral(text: string): string | null {
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text.length < 2 || text[text.length - 1] !== quote) {
    return null;
  }
  let inner = '';
  for (let index = 1; index < text.length - 1; index += 1) {
    const ch = text[index];
    if (ch === '\\') {
      inner += text[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (ch === quote) {
      return null;
    }
    inner += ch;
  }
  return inner;
}

/** f-string → 字面量骨架,每个 {插值} 折叠为 `*`;非 f-string → null */
function matchFStringSignature(text: string): string | null {
  if (!/^[fF]['"]/.test(text) || text.length < 3 || text[text.length - 1] !== text[1]) {
    return null;
  }
  const inner = text.slice(2, -1);
  let skeleton = '';
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index];
    if (ch === '{' && inner[index + 1] === '{') {
      skeleton += '{';
      index += 2;
      continue;
    }
    if (ch === '}' && inner[index + 1] === '}') {
      skeleton += '}';
      index += 2;
      continue;
    }
    if (ch === '{') {
      let depth = 1;
      let scan = index + 1;
      while (scan < inner.length && depth > 0) {
        if (inner[scan] === '{') {
          depth += 1;
        } else if (inner[scan] === '}') {
          depth -= 1;
        }
        scan += 1;
      }
      skeleton += '*';
      index = scan;
      continue;
    }
    skeleton += ch;
    index += 1;
  }
  return skeleton;
}

/**
 * 顶层 `+` 拼接 → 逐段签名:字面量/f-string 段出内容,其余段(标识符/
 * str(...) 等)折为 `*`;至少一个字面量段才有效(全动态无法可靠关联)。
 */
function matchConcatSignature(text: string): string | null {
  const parts = splitTopLevelPlus(text);
  if (parts.length < 2) {
    return null;
  }
  const emitted: string[] = [];
  let literalSegments = 0;
  for (const part of parts) {
    const piece = part.trim();
    const literal = matchStringLiteral(piece);
    if (literal !== null) {
      emitted.push(literal);
      literalSegments += 1;
      continue;
    }
    const fstring = matchFStringSignature(piece);
    if (fstring !== null) {
      emitted.push(fstring);
      literalSegments += 1;
      continue;
    }
    if (NUMERIC_PATTERN.test(piece)) {
      emitted.push(piece);
      literalSegments += 1;
      continue;
    }
    emitted.push('*');
  }
  if (literalSegments === 0) {
    return null;
  }
  return emitted.join('');
}

/** 顶层(深度 0、字符串外)`+` 切分;段保留原文 */
function splitTopLevelPlus(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      current += ch;
      if (ch === '\\') {
        index += 1;
        if (index < text.length) {
          current += text[index];
        }
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === '+' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

interface KeySpan {
  keyRaw: string;
  keyStart: number;
  keyEnd: number;
}

interface SubscriptParse extends KeySpan {
  kind: 'write' | 'read';
  valueText: string | null;
}

/** 跳过行内空白后取列 */
function skipWhitespace(lineText: string, from: number): number {
  let index = from;
  while (index < lineText.length && /[ \t]/.test(lineText[index])) {
    index += 1;
  }
  return index;
}

/**
 * `[KEY]` 下标访问:闭合 `]` 须同行(深度计,字符串内不计);`]` 后是
 * `=`(非 `==`)为写点(RHS 为同行余文),增强赋值算写但无值文本,
 * 其余为读点。
 */
function parseSubscriptAccess(lineText: string, openBracket: number): SubscriptParse | null {
  let depth = 0;
  let inString: string | null = null;
  let close = -1;
  for (let index = openBracket; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (inString) {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
      if (depth === 0 && ch === ']') {
        close = index;
        break;
      }
    }
  }
  if (close === -1) {
    return null;
  }
  const span = trimSpan(lineText, openBracket + 1, close);
  if (!span) {
    return null;
  }
  const after = skipWhitespace(lineText, close + 1);
  const nextChar = lineText[after];
  if (nextChar === '=' && lineText[after + 1] !== '=') {
    return {
      ...span,
      kind: 'write',
      valueText: lineText.slice(after + 1).trim() || null
    };
  }
  if (AUGMENTED_ASSIGN_OPS.some(op => lineText.startsWith(op, after))) {
    return { ...span, kind: 'write', valueText: null };
  }
  return { ...span, kind: 'read', valueText: null };
}

/** `.get(KEY[, default])` 读点:只取首个实参,括号不闭合(跨行)不取 */
function parseGetAccess(lineText: string, from: number): KeySpan | null {
  const head = /^\.get[ \t]*\(/.exec(lineText.slice(from));
  if (!head) {
    return null;
  }
  const openParen = from + head[0].length - 1;
  let depth = 0;
  let inString: string | null = null;
  let argStart = -1;
  for (let index = openParen + 1; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (inString) {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      if (depth === 0 && argStart === -1) {
        argStart = index;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1 && argStart === -1) {
        argStart = index;
      }
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        return argStart === -1 ? null : trimSpan(lineText, argStart, index);
      }
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ',') {
      return argStart === -1 ? null : trimSpan(lineText, argStart, index);
    }
    if (depth === 0 && argStart === -1 && !/\s/.test(ch)) {
      argStart = index;
    }
  }
  return null;
}

/** 区间去首尾空白;空区间 → null */
function trimSpan(lineText: string, start: number, end: number): KeySpan | null {
  let lo = start;
  let hi = end;
  while (lo < hi && /\s/.test(lineText[lo])) {
    lo += 1;
  }
  while (hi > lo && /\s/.test(lineText[hi - 1])) {
    hi -= 1;
  }
  if (lo >= hi) {
    return null;
  }
  return { keyRaw: lineText.slice(lo, hi), keyStart: lo, keyEnd: hi };
}

/**
 * 全文扫描字典键访问:接收者须为已引入的 kbe 别名(非 `alias.dict` 不
 * 认);别名前若是 `.`(如 x.KBEngine.globalData)视为属性链不接管,与
 * resolveKbeAccessAtPosition 同款守卫。键签名归一失败(全动态/复杂
 * 表达式)的访问跳过。
 */
export function findKbeDataDictAccesses(
  text: string,
  aliases: Set<string>
): KbeDataDictAccess[] {
  if (aliases.size === 0) {
    return [];
  }
  const accesses: KbeDataDictAccess[] = [];
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    DATA_DICT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATA_DICT_PATTERN.exec(lineText)) !== null) {
      if (!aliases.has(match[1])) {
        continue;
      }
      // 别名前是 '.'(x.KBEngine.globalData / self.kbe)→ 属性访问非模块访问
      if (match.index > 0 && lineText[match.index - 1] === '.') {
        continue;
      }
      const dict = match[2] as KbeDataDictName;
      const after = skipWhitespace(lineText, match.index + match[0].length);
      const push = (span: KeySpan, kind: 'write' | 'read', valueText: string | null): void => {
        const keySignature = normalizeKeySignature(span.keyRaw);
        if (keySignature === null) {
          return;
        }
        accesses.push({
          dict,
          keySignature,
          line,
          keyStart: span.keyStart,
          keyEnd: span.keyEnd,
          kind,
          valueText
        });
      };
      if (lineText[after] === '[') {
        const subscript = parseSubscriptAccess(lineText, after);
        if (subscript) {
          push(subscript, subscript.kind, subscript.valueText);
        }
        continue;
      }
      const getCall = parseGetAccess(lineText, after);
      if (getCall) {
        push(getCall, 'read', null);
      }
    }
  }
  return accesses;
}

/** 落点命中某访问的键表达式区间(含首尾)时返回该访问;provider 定位用 */
export function getKbeDataDictAccessAtPosition(
  lineText: string,
  character: number,
  aliases: Set<string>
): KbeDataDictAccess | null {
  for (const access of findKbeDataDictAccesses(lineText, aliases)) {
    if (character >= access.keyStart && character <= access.keyEnd) {
      return access;
    }
  }
  return null;
}

const siteKey = (dict: string, keySignature: string): string => `${dict}\u0000${keySignature}`;

const INITIAL_SCAN_CONCURRENCY = 8;

/**
 * 跨文件字典键索引(仿 WorkspaceIndex):首次查询建全量索引 +
 * watcher 增量失效,`noteSaved` 走编辑器路径免读盘;查询走内存
 * `(dict, 键签名) → 访问点[]`,不每次重扫。单实例由 extension 装配,
 * references/definition 共用。
 */
export class GlobalDataDictIndex {
  private readonly cache = new Map<string, { accesses: KbeDataDictAccess[] }>();
  private readonly building = new Map<string, Promise<{ accesses: KbeDataDictAccess[] } | null>>();
  private readonly byKey = new Map<string, KbeDataDictSite[]>();
  private readonly revisions = new Map<string, number>();
  private watchers: vscode.Disposable[] = [];
  private documentListener?: vscode.Disposable;
  private renameListener?: vscode.Disposable;
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时建全量索引并挂 watcher(幂等)。 */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disposed) {
      return;
    }
    const starting = this.starting ??= this.startIndex();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) {
        this.starting = undefined;
      }
      throw error;
    }
  }

  private async startIndex(): Promise<void> {
    this.documentListener ??= vscode.workspace.onDidChangeTextDocument(event => {
      this.noteSaved(event.document);
    });
    this.renameListener ??= vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        this.revisions.set(oldUri.fsPath, (this.revisions.get(oldUri.fsPath) ?? 0) + 1);
        this.revisions.set(newUri.fsPath, (this.revisions.get(newUri.fsPath) ?? 0) + 1);
        const entry = this.cache.get(oldUri.fsPath);
        this.replaceFileSites(oldUri.fsPath, entry?.accesses ?? [], []);
        this.cache.delete(oldUri.fsPath);
        if (newUri.fsPath.endsWith('.py')) {
          if (entry) {
            this.cache.set(newUri.fsPath, entry);
            this.replaceFileSites(newUri.fsPath, [], entry.accesses);
          } else {
            void this.indexFile(newUri);
          }
        }
      }
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) {
        this.noteSaved(document);
      }
    }
    const initialRevisions = new Map(this.revisions);
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed) {
      return;
    }
    let nextFile = 0;
    const scanWorker = async (): Promise<void> => {
      while (!this.disposed && nextFile < files.length) {
        const uri = files[nextFile++];
        if ((this.revisions.get(uri.fsPath) ?? 0) !== (initialRevisions.get(uri.fsPath) ?? 0)) {
          continue;
        }
        await this.indexFile(uri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(INITIAL_SCAN_CONCURRENCY, files.length) }, scanWorker));
    if (this.disposed) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(this.pyGlob);
    watcher.onDidCreate(uri => {
      void this.indexFile(uri);
    });
    watcher.onDidChange(uri => {
      void this.indexFile(uri);
    });
    watcher.onDidDelete(uri => {
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      const entry = this.cache.get(uri.fsPath);
      this.replaceFileSites(uri.fsPath, entry?.accesses ?? [], []);
      this.cache.delete(uri.fsPath);
    });
    this.watchers.push(watcher);
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
    this.documentListener?.dispose();
    this.documentListener = undefined;
    this.renameListener?.dispose();
    this.renameListener = undefined;
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.cache.clear();
    this.byKey.clear();
    this.revisions.clear();
  }

  /** 单文件建/重建索引;并发去重(同文件不重复读)。 */
  private indexFile(uri: vscode.Uri): Promise<{ accesses: KbeDataDictAccess[] } | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const inflight = this.building.get(uri.fsPath);
    if (inflight) {
      return inflight;
    }
    const revision = this.revisions.get(uri.fsPath) ?? 0;
    const task = (async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed) {
          return null;
        }
        if ((this.revisions.get(uri.fsPath) ?? 0) !== revision) {
          return this.cache.get(uri.fsPath) ?? null;
        }
        const dirty = vscode.workspace.textDocuments.find(
          document => document.uri.fsPath === uri.fsPath && document.isDirty
        );
        if (dirty) {
          this.noteSaved(dirty);
          return this.cache.get(uri.fsPath) ?? null;
        }
        const text = Buffer.from(bytes).toString('utf8');
        // 冷扫让出宿主:正则扫描轻,逐文件一个宏任务节拍即可
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.disposed || (this.revisions.get(uri.fsPath) ?? 0) !== revision) {
          return this.cache.get(uri.fsPath) ?? null;
        }
        this.commitFile(uri.fsPath, text);
        return this.cache.get(uri.fsPath) ?? null;
      } catch {
        if ((this.revisions.get(uri.fsPath) ?? 0) === revision) {
          const entry = this.cache.get(uri.fsPath);
          this.replaceFileSites(uri.fsPath, entry?.accesses ?? [], []);
          this.cache.delete(uri.fsPath);
        }
        return null;
      } finally {
        this.building.delete(uri.fsPath);
      }
    })();
    this.building.set(uri.fsPath, task);
    return task;
  }

  /** 重扫文件文本并同步倒排(byKey) */
  private commitFile(fsPath: string, text: string): void {
    const aliases = getKbeAliases(text);
    const accesses = aliases.size > 0 ? findKbeDataDictAccesses(text, aliases) : [];
    const previous = this.cache.get(fsPath)?.accesses ?? [];
    this.cache.set(fsPath, { accesses });
    this.replaceFileSites(fsPath, previous, accesses);
  }

  /** 保存时由编辑器路径直接刷新(免读盘)。 */
  noteSaved(document: vscode.TextDocument): void {
    if (this.disposed) {
      return;
    }
    if (!document.uri.fsPath.endsWith('.py')) {
      return;
    }
    this.revisions.set(document.uri.fsPath, (this.revisions.get(document.uri.fsPath) ?? 0) + 1);
    this.commitFile(document.uri.fsPath, document.getText());
  }

  /** (字典, 键签名) 的全部写+读点(走内存索引,不重扫)。 */
  query(dict: string, keySignature: string): KbeDataDictSite[] {
    return this.byKey.get(siteKey(dict, keySignature)) ?? [];
  }

  /** 文件重扫后替换其贡献的倒排项(先撤旧再进新)。 */
  private replaceFileSites(
    fsPath: string,
    previous: KbeDataDictAccess[],
    next: KbeDataDictAccess[]
  ): void {
    for (const access of previous) {
      const key = siteKey(access.dict, access.keySignature);
      const sites = this.byKey.get(key);
      if (!sites) {
        continue;
      }
      const kept = sites.filter(site => site.file !== fsPath);
      if (kept.length === 0) {
        this.byKey.delete(key);
      } else {
        this.byKey.set(key, kept);
      }
    }
    for (const access of next) {
      const key = siteKey(access.dict, access.keySignature);
      const sites = this.byKey.get(key) ?? [];
      sites.push({ ...access, file: fsPath });
      this.byKey.set(key, sites);
    }
  }
}
