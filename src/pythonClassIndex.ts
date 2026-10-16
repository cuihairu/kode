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

/**
 * 扫描排除面:官方三件套之外再排引擎构建/依赖/临时树。
 * 依据(2026-10-16 本机实测,D:\workspaces\kbengine):只排 node_modules/
 * third_party/.git 时命中 14,245 个 .py(vcpkg 10,108 + build 3,614 + …),
 * 平均 10.13ms/文件的顺序读 ≈ 144 秒——即用户实测的「跳转前加载很久」;
 * 收窄后同仓 117 个文件 ≈ 1.2 秒。业务脚本(scripts/tools 等)不受影响。
 */
export const PY_SCAN_EXCLUDE =
  '**/{node_modules,third_party,.git,vcpkg,build,dist,out,.tmp,perf,.venv,venv,site-packages,__pycache__}/**';

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
      let chosen = '';
      let found = false;
      for (const list of work) {
        if (list.length === 0) {
          continue; // 被 splice 清空的列表必须跳过:list[0] 为 undefined
        }
        const candidate = list[0];
        // 候选不得出现在任何列表的尾部(除首个位置)
        const inTail = work.some(other => other.length > 0 && other.indexOf(candidate) > 0);
        if (!inTail) {
          chosen = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
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
  /** 解析所锚定的类:祖先解到 = 静态类自身;反向解到 = 继承静态类的类(主形态) */
  anchorClass?: string;
}

/**
 * 工作区 Python 类索引:按需扫描 *.py 建 className → 定义列表,
 * 变更时按文件失效。所有查询走缓存,不在热点路径重复解析。
 */
export class PythonClassIndex {
  private fileCache = new Map<string, { version: number; parsed: ParsedPythonFile }>();
  private byName = new Map<string, PythonClassDef[]>();
  /** 直接子类:基类名 → 继承它的类(增量维护;主形态反向解析用) */
  private directSubclasses = new Map<string, PythonClassDef[]>();
  private scanPromise: Promise<void> | null = null;

  private indexClass(cls: PythonClassDef): void {
    const list = this.byName.get(cls.name) ?? [];
    list.push(cls);
    this.byName.set(cls.name, list);
    for (const base of cls.bases) {
      const subs = this.directSubclasses.get(base) ?? [];
      subs.push(cls);
      this.directSubclasses.set(base, subs);
    }
  }

  private unindexFile(filePath: string): void {
    for (const [name, list] of [...this.byName.entries()]) {
      const filtered = list.filter(item => item.filePath !== filePath);
      if (filtered.length === list.length) {
        continue;
      }
      if (filtered.length === 0) {
        this.byName.delete(name);
      } else {
        this.byName.set(name, filtered);
      }
    }
    for (const [base, subs] of [...this.directSubclasses.entries()]) {
      const filtered = subs.filter(item => item.filePath !== filePath);
      if (filtered.length === subs.length) {
        continue;
      }
      if (filtered.length === 0) {
        this.directSubclasses.delete(base);
      } else {
        this.directSubclasses.set(base, filtered);
      }
    }
  }

  /** 首次查询时全量扫描(幂等,失败不抛) */
  private async ensureScanned(): Promise<void> {
    if (this.scanPromise) {
      return this.scanPromise;
    }
    this.scanPromise = (async () => {
      try {
        const files = await vscode.workspace.findFiles('**/*.py', PY_SCAN_EXCLUDE);
        // 分块并行读:顺序同步读在大仓是「跳转前加载很久」的主来源
        // (排除式漏扫 vcpkg/build 时实测 14,245 文件 × 10.13ms ≈ 144s)
        const CONCURRENCY = 16;
        for (let offset = 0; offset < files.length; offset += CONCURRENCY) {
          await Promise.all(
            files.slice(offset, offset + CONCURRENCY).map(uri => this.loadFile(uri.fsPath, -1))
          );
        }
      } catch {
        // 扫描失败不阻断跳转,但必须清掉缓存的失败结果——否则 scanPromise
        // 永久停在「已扫描」态、跨文件类永远补不进来,每次跳转都落 null
        // (与「加载很久后 No definition found」同根)。下次跳转重试;
        // 已解析部分保留在 fileCache/byName 继续可用。
        this.scanPromise = null;
      }
    })();
    return this.scanPromise;
  }

  private async loadFile(filePath: string, version: number): Promise<void> {
    let content: string;
    try {
      // 异步读:同步读会在扫描/变更时阻塞扩展宿主线程
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const parsed = parsePythonFile(content, filePath);
    // 增量:先摘除该文件旧索引条目再重挂,避免重复/陈旧基类关系
    this.unindexFile(filePath);
    this.fileCache.set(filePath, { version, parsed });
    for (const cls of parsed.classes) {
      this.indexClass(cls);
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

  /** 类 name 的全部后代(直接子类传递闭包,含环护栏) */
  async descendantsOf(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    const out: PythonClassDef[] = [];
    const seen = new Set<string>([name]);
    const queue: string[] = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const sub of this.directSubclasses.get(current) ?? []) {
        const key = `${sub.filePath}::${sub.name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(sub);
        queue.push(sub.name);
      }
    }
    return out;
  }

  /** 在某类的 MRO 中找 methodName 的提供者(首个命中即运行时调用序) */
  private lookupInMRO(className: string, methodName: string): PythonMethodLocation | null {
    const mro = linearizeC3(className, n => this.byName.get(n) ?? []);
    for (const clsName of mro) {
      const defs = this.byName.get(clsName);
      if (!defs) {
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
            mro,
            anchorClass: className
          };
        }
      }
    }
    return null;
  }

  /**
   * 主形态解析:从 `self` 的**静态类**出发解 C3 MRO,跨文件命中 mixin 定义。
   * ① 静态类自身 MRO(祖先)—— 覆盖「子类调基类」;
   * ② 静态类 MRO 无果 → 反向找**继承静态类的类**(兄弟 mixin 经共同子类,
   *    如 MixinB.self.x() 需经 Avatar = (MixinA, MixinB) 的 MRO 才落到 MixinA)。
   * 去重后按 祖先优先 → 后代声明序 返回全部候选(供 Location[] 列表选择)。
   */
  async resolveSelfMethodCandidates(
    filePath: string,
    line: number,
    methodName: string
  ): Promise<PythonMethodLocation[]> {
    await this.ensureScanned();
    const enclosing = await this.findEnclosingClass(filePath, line);
    if (!enclosing) {
      return [];
    }
    const seen = new Set<string>();
    const push = (loc: PythonMethodLocation | null, out: PythonMethodLocation[]): void => {
      if (!loc) {
        return;
      }
      const key = `${loc.filePath}::${loc.line}::${loc.character}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(loc);
    };

    const out: PythonMethodLocation[] = [];
    // ① 祖先 MRO(静态类自身可解即最直接)
    push(this.lookupInMRO(enclosing.name, methodName), out);
    if (out.length > 0) {
      return out;
    }

    // ② 主形态:静态类自身解不到 → 反向经继承它的类解(兄弟 mixin 跨文件)
    const descendants = await this.descendantsOf(enclosing.name);
    for (const sub of descendants) {
      push(this.lookupInMRO(sub.name, methodName), out);
    }
    return out;
  }

  /** 兼容入口:首个候选(唯一实现场景即唯一解) */
  async resolveSelfMethod(
    filePath: string,
    line: number,
    methodName: string
  ): Promise<PythonMethodLocation | null> {
    const candidates = await this.resolveSelfMethodCandidates(filePath, line, methodName);
    return candidates.length > 0 ? candidates[0] : null;
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
