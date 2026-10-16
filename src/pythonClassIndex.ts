import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Python 类层级索引(mixin/跨类跳转根因修复)。
 *
 * 既有跳转把方法归属交给 `.def` 派生索引(entityMapping.ts:573 对非 `.def`
 * 映射文件直接 return null;有 `.def` 也只按文件名 basename 当 owner 去 `.def`
 * 声明里查),导致「由基类/mixin 提供、不在任何 .def 里的方法」完全解析不到。
 * 本模块补上真正缺失的一层:**读 Python 类定义与基类、按 C3 MRO 解析
 * `self.<method>` 的真实实现位置**。跳转与 CodeLens 共用本索引。
 */

/** 一个类的定义(含它自己的 `def` 方法) */
export interface PythonClassDef {
  name: string;
  /** 基类名(去点取末段:KBEngine.Entity → Entity;空串表示 object/内置) */
  bases: string[];
  filePath: string;
  /** 0-based 起始行(class 语句行) */
  startLine: number;
  /** 0-based 结束行(不含) */
  endLine: number;
  /** 方法名 → 定义位置(0-based 行/列) */
  methods: Map<string, { line: number; character: number }>;
}

/** 解析结果:类按文件聚合 + 全局 className → 定义 多映射(同名类可能多处) */
export interface ParsedPythonFile {
  filePath: string;
  classes: PythonClassDef[];
}

const CLASS_RE = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)[ \t]*:/;
const CLASS_RE_NOBASE = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*:/;
const DEF_RE = /^([ \t]+)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/;

/** 解析一个 .py 文件里的类与方法(纯函数,便于测试) */
export function parsePythonFile(content: string, filePath: string): ParsedPythonFile {
  const lines = content.split(/\r?\n/);
  const classes: PythonClassDef[] = [];
  const stack: { indent: number; cls: PythonClassDef }[] = [];

  const closeTo = (indent: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      const top = stack.pop()!;
      top.cls.endLine = lines.length;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) {
      continue;
    }
    const indent = raw.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;

    const classMatch = CLASS_RE.exec(raw) ?? CLASS_RE_NOBASE.exec(raw);
    if (classMatch) {
      // 先闭合缩进不小于当前的既有类
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        const top = stack.pop()!;
        top.cls.endLine = i;
      }
      const basesRaw = classMatch[3] ?? '';
      const bases = basesRaw
        .split(',')
        .map(part => part.split(':')[0].trim())
        .map(part => (part.includes('.') ? part.split('.').pop()! : part))
        .map(part => part.replace(/[()[\]{}'"]/g, ''))
        .filter(part => part.length > 0 && part !== 'object' && part !== 'enum');
      const cls: PythonClassDef = {
        name: classMatch[2],
        bases,
        filePath,
        startLine: i,
        endLine: lines.length,
        methods: new Map()
      };
      classes.push(cls);
      stack.push({ indent, cls });
      continue;
    }

    const defMatch = DEF_RE.exec(raw);
    if (defMatch) {
      // 方法只归属缩进更小的最近类;def 自身缩进必须大于类缩进
      const defIndent = defMatch[1].replace(/\t/g, '    ').length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= defIndent) {
        const top = stack.pop()!;
        top.cls.endLine = i;
      }
      if (stack.length > 0) {
        const owner = stack[stack.length - 1].cls;
        const methodName = defMatch[2];
        if (!owner.methods.has(methodName)) {
          owner.methods.set(methodName, {
            line: i,
            character: raw.indexOf(methodName)
          });
        }
      }
    }
  }
  closeTo(0);
  return { filePath, classes };
}

/** C3 线性化(Python3 真实 MRO):l(X) = X + merge(l(B1), l(B2), …, [B1,B2,…]) */
export function linearizeC3(name: string, resolve: (base: string) => PythonClassDef[]): string[] {
  const c3merge = (lists: string[][]): string[] => {
    const out: string[] = [];
    const work = lists.filter(list => list.length > 0).map(list => list.slice());
    let guard = 0;
    while (work.some(list => list.length > 0) && guard < 5000) {
      guard += 1;
      let chosen: string | null = null;
      for (const list of work) {
        const candidate = list[0];
        // 候选不得出现在任何列表的尾部(除首个位置)
        const inTail = work.some(other => other.indexOf(candidate) > 0);
        if (!inTail) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === null) {
        // 不可线性化(非法继承图):平铺剩余去重,不丢类
        for (const list of work) {
          for (const n of list) {
            if (!out.includes(n)) {
              out.push(n);
            }
          }
        }
        return out;
      }
      out.push(chosen);
      for (let i = 0; i < work.length; i += 1) {
        const idx = work[i].indexOf(chosen);
        if (idx >= 0) {
          work[i].splice(idx, 1);
        }
      }
    }
    return out;
  };

  const memo = new Map<string, string[]>();
  const inProgress = new Set<string>();
  const lin = (n: string): string[] => {
    const cached = memo.get(n);
    if (cached) {
      return cached;
    }
    if (inProgress.has(n)) {
      return [n]; // 循环继承护栏:退化为含自身,不无限递归
    }
    inProgress.add(n);
    const defs = resolve(n);
    const bases = defs.length > 0 ? defs[0].bases : [];
    const seqs = bases.map(b => lin(b));
    if (bases.length > 0) {
      seqs.push(bases.slice());
    }
    const result = [n, ...c3merge(seqs)];
    inProgress.delete(n);
    memo.set(n, result);
    return result;
  };

  return lin(name);
}

export interface PythonMethodLocation {
  filePath: string;
  line: number;
  character: number;
  /** 提供该方法的类名(MRO 中首个命中) */
  className: string;
  /** MRO 序(用于 CodeLens/多实现呈现) */
  mro: string[];
}

/**
 * 工作区 Python 类索引:按需扫描 *.py 建 className → 定义列表,
 * 变更时按文件失效。所有查询走缓存,不在热点路径重复解析。
 */
export class PythonClassIndex {
  private fileCache = new Map<string, { version: number; parsed: ParsedPythonFile }>();
  private byName = new Map<string, PythonClassDef[]>();
  private scanPromise: Promise<void> | null = null;

  /** 首次查询时全量扫描(幂等,失败不抛) */
  private async ensureScanned(): Promise<void> {
    if (this.scanPromise) {
      return this.scanPromise;
    }
    this.scanPromise = (async () => {
      try {
        const files = await vscode.workspace.findFiles('**/*.py', '**/{node_modules,third_party,.git}/**');
        for (const uri of files) {
          await this.loadFile(uri.fsPath, -1);
        }
      } catch {
        // 扫描失败不阻断跳转:降级为按需单文件解析
      }
    })();
    return this.scanPromise;
  }

  private async loadFile(filePath: string, version: number): Promise<void> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    const parsed = parsePythonFile(content, filePath);
    this.fileCache.set(filePath, { version, parsed });
    // 重建 name 映射时剔除该文件旧条目
    for (const cls of parsed.classes) {
      const list = this.byName.get(cls.name) ?? [];
      const filtered = list.filter(item => item.filePath !== filePath);
      filtered.push(cls);
      this.byName.set(cls.name, filtered);
    }
  }

  /** 文档变更:只重解析该文件(增量,避免大仓输入卡顿) */
  async onDocumentChanged(document: vscode.TextDocument): Promise<void> {
    if (!document.fileName.toLowerCase().endsWith('.py')) {
      return;
    }
    await this.loadFile(document.fileName, document.version);
  }

  /** 类名 → 定义列表(可能同名多处) */
  async findClassesByName(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    return this.byName.get(name) ?? [];
  }

  /** 按文件行找内层类定义(用于定位调用点所在类) */
  async findEnclosingClass(filePath: string, line: number): Promise<PythonClassDef | null> {
    await this.ensureScanned();
    let cached = this.fileCache.get(filePath);
    if (!cached) {
      await this.loadFile(filePath, -1);
      cached = this.fileCache.get(filePath);
    }
    if (!cached) {
      return null;
    }
    // 内层优先(endLine 相同取 startLine 更大者)
    const hits = cached.parsed.classes.filter(cls => line >= cls.startLine && line < cls.endLine);
    if (hits.length === 0) {
      return null;
    }
    return hits.reduce((a, b) => (b.startLine > a.startLine ? b : a));
  }

  /** 计算某类的 MRO(含自身),跨文件基类解析 */
  async computeMRO(className: string): Promise<string[]> {
    await this.ensureScanned();
    const resolve = (name: string): PythonClassDef[] => {
      const found = this.byName.get(name);
      return found ?? [];
    };
    return linearizeC3(className, resolve);
  }

  /**
   * 解析 `filePath:line` 处 `self.<methodName>` 的真实实现:定位所在类 → MRO →
   * 首个定义 `methodName` 的类。找不到返回 null。
   */
  async resolveSelfMethod(
    filePath: string,
    line: number,
    methodName: string
  ): Promise<PythonMethodLocation | null> {
    await this.ensureScanned();
    const enclosing = await this.findEnclosingClass(filePath, line);
    if (!enclosing) {
      return null;
    }
    const mro = await this.computeMRO(enclosing.name);
    // MRO 顺序即运行时查找序:首个命中即 Python 实际会调用的实现
    for (const clsName of mro) {
      const defs = this.byName.get(clsName);
      if (!defs || defs.length === 0) {
        continue;
      }
      for (const def of defs) {
        const loc = def.methods.get(methodName);
        if (loc) {
          return {
            filePath: def.filePath,
            line: loc.line,
            character: loc.character,
            className: clsName,
            mro
          };
        }
      }
    }
    return null;
  }

  /** 某类「由哪些基类/mixin 提供」(CodeLens 用):MRO 去掉自身 */
  async mixinsProvidingTo(className: string): Promise<string[]> {
    const mro = await this.computeMRO(className);
    return mro.filter(name => name !== className);
  }

  /** 某方法名在 MRO 中由哪些类提供(CodeLens/多实现用) */
  async providersOfMethod(className: string, methodName: string): Promise<PythonMethodLocation[]> {
    const mro = await this.computeMRO(className);
    const out: PythonMethodLocation[] = [];
    for (const clsName of mro) {
      const defs = this.byName.get(clsName);
      if (!defs) {
        continue;
      }
      for (const def of defs) {
        const loc = def.methods.get(methodName);
        if (loc) {
          out.push({
            filePath: def.filePath,
            line: loc.line,
            character: loc.character,
            className: clsName,
            mro
          });
        }
      }
    }
    return out;
  }
}

/** 工作区根下相对化显示(测试与日志用) */
export function displayPath(filePath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder && filePath.startsWith(folder)) {
    return path.relative(folder, filePath).replace(/\\/g, '/');
  }
  return filePath;
}
