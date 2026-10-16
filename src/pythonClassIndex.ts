import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { deriveCompositionRoots, type CompositionRootMap } from './compositionRoots';

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
  /** 模块级实例赋值 `NAME = CLASS(...)`(types.xml implementedBy 指向实现对象,经此解析 实例→类) */
  instanceAssignments: Array<{ variable: string; className: string; line: number }>;
}

const CLASS_RE = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)[ \t]*:/;
const CLASS_RE_NOBASE = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*:/;
const DEF_RE = /^([ \t]+)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/;
const MODULE_ASSIGN_RE = /^([A-Za-z_]\w*)[ \t]*=[ \t]*([A-Za-z_]\w*)[ \t]*\(/;

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
  const instanceAssignments: ParsedPythonFile['instanceAssignments'] = [];
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

    const assignMatch = MODULE_ASSIGN_RE.exec(raw);
    if (assignMatch && indent === 0) {
      // 模块级实例赋值:先闭合缩进不小于 0 的既有类(类体到此结束)
      while (stack.length > 0) {
        const top = stack.pop()!;
        top.cls.endLine = i;
      }
      instanceAssignments.push({ variable: assignMatch[1], className: assignMatch[2], line: i });
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
  return { filePath, classes, instanceAssignments };
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
  /** 命中的组合根(entities.xml × .def × Python 继承交叉派生;①祖先直解可缺省) */
  compositionRoot?: string;
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
  /** 组合根派生结果(懒建;实体注册/类型/实体定义变化时置空重派) */
  private rootsMap: CompositionRootMap | null = null;
  private rootsPromise: Promise<void> | null = null;

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
  /**
   * 组合根派生(懒):entities.xml 全部实体 + 各实体 .def(父/接口/组件/字段类型)
   * + types.xml(implementedBy 字段对象类)。失败清缓存可重试(与扫描同口径)。
   */
  private async ensureCompositionRoots(): Promise<void> {
    if (this.rootsMap) {
      return;
    }
    if (this.rootsPromise) {
      return this.rootsPromise;
    }
    this.rootsPromise = (async () => {
      // 先完成 .py 扫描:根名「实现对象 → 类」的桥接要用到文件里的实例赋值表
      await this.ensureScanned();
      try {
        const [entityXmlFiles, defFiles, typeXmlFiles] = await Promise.all([
          vscode.workspace.findFiles('**/entities.xml', PY_SCAN_EXCLUDE),
          vscode.workspace.findFiles('**/*.def', PY_SCAN_EXCLUDE),
          vscode.workspace.findFiles('**/types.xml', PY_SCAN_EXCLUDE)
        ]);
        const readAll = async (files: vscode.Uri[]): Promise<string[]> => {
          const contents: string[] = [];
          for (const uri of files) {
            try {
              contents.push(await fs.promises.readFile(uri.fsPath, 'utf8'));
            } catch {
              // 单文件读不到跳过,不拖垮派生
            }
          }
          return contents;
        };
        const entitiesXmlContents = await readAll(entityXmlFiles);
        const typesXmlContents = await readAll(typeXmlFiles);
        const entityDefs: Array<{ entity: string; content: string }> = [];
        for (const uri of defFiles) {
          const normalized = uri.fsPath.replace(/\\/g, '/').toLowerCase();
          // 与 entityMapping 同口径:components/、interfaces/ 下的 def 不是实体注册
          if (normalized.includes('/components/') || normalized.includes('/interfaces/')) {
            continue;
          }
          const base = uri.fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
          const entity = base.replace(/\.def$/i, '');
          try {
            entityDefs.push({ entity, content: await fs.promises.readFile(uri.fsPath, 'utf8') });
          } catch {
            // 同上
          }
        }
        const derived = deriveCompositionRoots({ entitiesXmlContents, entityDefs, typesXmlContents });
        // 实现对象符号 → 类:types.xml 的 implementedBy 指向实例
        // (如 weapon_skill_slot_list_inst = weapon_skill_slot_list()),组合根
        // 记类名才能与 Python 类继承表交叉(收录查询/MRO 查找都按类名)。
        const assignmentClass = new Map<string, string>();
        for (const { parsed } of this.fileCache.values()) {
          for (const item of parsed.instanceAssignments) {
            if (!assignmentClass.has(item.variable)) {
              assignmentClass.set(item.variable, item.className);
            }
          }
        }
        const resolvedRoots: string[] = [];
        for (const root of derived.roots) {
          const resolved = this.byName.has(root) ? root : assignmentClass.get(root) ?? root;
          if (!resolvedRoots.includes(resolved)) {
            resolvedRoots.push(resolved);
          }
        }
        this.rootsMap = { roots: resolvedRoots, defMixins: derived.defMixins };
      } catch {
        // 派生失败:不当成功缓存,下次跳转重试;已建索引不受影响
        this.rootsMap = null;
        this.rootsPromise = null;
      }
    })();
    return this.rootsPromise;
  }

  /**
   * 「类 X 被哪些组合根收录」——三输入交叉:根自身的 Python MRO(含同名多文件)
   * 或根 .def 声明的 mixin(Parent/接口/组件)名单命中 X。
   * 按组合根派生序返回(entities.xml 实体序在前)。
   */
  async rootsContaining(className: string): Promise<string[]> {
    await this.ensureCompositionRoots();
    const map = this.rootsMap;
    if (!map) {
      return [];
    }
    const hits: string[] = [];
    for (const root of map.roots) {
      if (root === className) {
        hits.push(root);
        continue;
      }
      if (this.byName.has(root)) {
        const names = linearizeC3(root, name => this.byName.get(name) ?? []);
        if (names.includes(className)) {
          hits.push(root);
          continue;
        }
      }
      if ((map.defMixins.get(root) ?? []).includes(className)) {
        hits.push(root);
      }
    }
    return hits;
  }

  /** 按 def 声明的 mixin 类名名单查方法提供者(Parent → 接口 → 组件 序) */
  private lookupInMixinNames(names: string[], methodName: string): PythonMethodLocation | null {
    for (const mixinName of names) {
      const defs = this.byName.get(mixinName);
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
            className: mixinName,
            mro: linearizeC3(mixinName, name => this.byName.get(name) ?? []),
            anchorClass: mixinName
          };
        }
      }
    }
    return null;
  }

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
    const lower = document.fileName.toLowerCase();
    if (lower.endsWith('.def') || lower.endsWith('.xml')) {
      // 实体注册/实体定义/类型定义变化 → 组合根派生失效,下次跳转重派
      this.rootsMap = null;
      this.rootsPromise = null;
      return;
    }
    if (!lower.endsWith('.py')) {
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

    // ② 组合根(用户 2026-10-16:实体清单里每个实体、其字段对象、组件都是组合根,
    // 不止单一入口类):静态类被哪些组合根收录 → 在每一个组合根的 MRO 里找。
    // 每根先走 Python 继承(同名多文件合并),再走该根 .def 声明的 mixin
    // (Parent → Interfaces → Components);多根/多处命中全部保留(上面 push 去重),
    // 由 provider 出 Location[] 列表,不替用户跳第一个。
    const rootNames = await this.rootsContaining(enclosing.name);
    if (rootNames.length > 0 && this.rootsMap) {
      for (const root of rootNames) {
        const fromPython = this.lookupInMRO(root, methodName);
        if (fromPython) {
          push({ ...fromPython, compositionRoot: root }, out);
        }
        for (const mixinName of this.rootsMap.defMixins.get(root) ?? []) {
          const fromMixin = this.lookupInMixinNames([mixinName], methodName);
          if (fromMixin) {
            push({ ...fromMixin, compositionRoot: root }, out);
          }
        }
      }
      if (out.length > 0) {
        return out;
      }
    }

    // ③ 兜底:静态类与组合根都解不到 → 反向经继承它的类解(非实体代码路径,
    // 兄弟 mixin/工具类形态;保留既有行为,不因组合根缺失而直接失败)
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
