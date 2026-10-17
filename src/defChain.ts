import * as fs from 'fs';
import * as path from 'path';
import {
  findEntityDefsRootFromFile,
  parseDefFileSemantics
} from './defRenamer';

// def 链合并呈现(source-analysis 设计 D5 剩余段):把一个 def 的继承闭包
// 整理成「Parent 链(递归)+ interfaces/ 平铺 + components/ 挂接」三面,
// 与引擎归并口径一致(entitydef.cpp:890-924、551-639、642-771):
// - 实体 Parent 平铺在定义根,组件 def 的 Parent 在 components/ 内解析;
// - 接口固定解析到 interfaces/,且接口 def 装载时不读 Parent(loadInterfaces
//   不走 loadParentClass),链不穿过接口;
// - 各级 def 的 <Interfaces> 均平铺进闭包,同名去重首见保序;
// - 组件挂接取 <Components> 槽的 <Type> 值(组件 def 名)。
// 引擎 loadParentClass 未见防环,kode 必须带 visited 截断(D5 明文),
// 截断发生时如实标记,不静默。

export interface DefChainNode {
  name: string;
  /** def 文件绝对路径;缺文件(纯脚本父类等)为 null,不虚构 */
  defPath: string | null;
}

export interface DefChainInfo {
  /** 紧邻父起逐层向上 */
  parentChain: DefChainNode[];
  /** 闭包内各级接口平铺,同名去重首见保序 */
  interfaces: DefChainNode[];
  /** 闭包内各级组件槽挂接,同名去重首见保序 */
  components: DefChainNode[];
  /** Parent 递归发生环并被 visited 截断时为 true */
  cycleTruncated: boolean;
}

const readFileOrNull = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

type DefChainCategory = 'entity' | 'interface' | 'component';

const categoryOf = (defsRoot: string, filePath: string): DefChainCategory => {
  const relative = path.relative(defsRoot, filePath).split(path.sep);
  if (relative.includes('interfaces')) {
    return 'interface';
  }
  if (relative.includes('components')) {
    return 'component';
  }
  return 'entity';
};

export function buildDefChain(
  entryPath: string,
  readText: (filePath: string) => string | null = readFileOrNull
): DefChainInfo {
  const defsRoot = findEntityDefsRootFromFile(entryPath);
  if (!defsRoot) {
    return { parentChain: [], interfaces: [], components: [], cycleTruncated: false };
  }

  const parentChain: DefChainNode[] = [];
  const interfaces: DefChainNode[] = [];
  const components: DefChainNode[] = [];
  const seenInterfaceNames = new Set<string>();
  const seenComponentNames = new Set<string>();
  let cycleTruncated = false;

  const collectFlatDecls = (filePath: string, content: string): void => {
    const semantics = parseDefFileSemantics(content);
    if (!semantics) {
      return;
    }
    for (const name of semantics.interfaceNames) {
      if (seenInterfaceNames.has(name)) {
        continue;
      }
      seenInterfaceNames.add(name);
      const defPath = path.join(defsRoot, 'interfaces', `${name}.def`);
      interfaces.push({ name, defPath: fs.existsSync(defPath) ? defPath : null });
    }
    for (const name of semantics.componentTypeNames) {
      if (seenComponentNames.has(name)) {
        continue;
      }
      seenComponentNames.add(name);
      const defPath = path.join(defsRoot, 'components', `${name}.def`);
      components.push({ name, defPath: fs.existsSync(defPath) ? defPath : null });
    }
  };

  const entryResolved = path.resolve(entryPath);
  const seenFiles = new Set<string>([entryResolved]);
  const entryContent = readText(entryResolved);
  if (entryContent !== null) {
    collectFlatDecls(entryResolved, entryContent);
    let current: { path: string; content: string } | null =
      { path: entryResolved, content: entryContent };
    while (current) {
      const semantics = parseDefFileSemantics(current.content);
      const category = categoryOf(defsRoot, current.path);
      // 接口 def 不跟随 Parent(引擎 loadInterfaces 口径,resolveLinkPaths 同注)
      const parentName = semantics?.parentName && category !== 'interface'
        ? semantics.parentName
        : null;
      if (!parentName) {
        break;
      }
      const parentDir = category === 'component'
        ? path.join(defsRoot, 'components')
        : defsRoot;
      const parentPath = path.resolve(path.join(parentDir, `${parentName}.def`));
      parentChain.push({ name: parentName, defPath: fs.existsSync(parentPath) ? parentPath : null });
      if (seenFiles.has(parentPath)) {
        cycleTruncated = true;
        break;
      }
      seenFiles.add(parentPath);
      const parentContent = readText(parentPath);
      if (parentContent === null) {
        break;
      }
      collectFlatDecls(parentPath, parentContent);
      current = { path: parentPath, content: parentContent };
    }
  }

  return { parentChain, interfaces, components, cycleTruncated };
}
