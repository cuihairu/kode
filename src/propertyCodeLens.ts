/**
 * 属性访问标记(批135 用户令:「从 types.xml 可以跳转到具体的代码,但从代码上
 * 没有类似的 type 的标记反向跳转」)。Python 脚本里没有类型名可写,可行等价是
 * self.<属性> 访问处出一行 CodeLens,标题标 def 声明的类型与可见域,点击回
 * def 声明行。
 *
 * 纯逻辑层,不 import vscode:扫 self.<属性路径> 访问 + 按外部解析器回包出
 * 行标题;provider 层(languageProviders)把解析回包装配成 vscode.CodeLens。
 * 解析回包走 EntityMappingManager.resolvePropertyDefinitionInfo——与属性 F12
 * 反向跳转同一索引同一口径,本层不自己读 def 文件。
 *
 * 已知边界:只认 self.<属性路径> 形态(与属性 F12 的 getPythonSelfAccessAtPosition
 * 同口径);引擎那套 self.get('属性')/self.set('属性', 值) API 形态不在识别范围。
 */

import type { PropertyFlagDomain } from './defAnalyzer';

/** Python 脚本里一处 self.<属性> 访问(位置口径与声明行解析器同源) */
export interface PythonSelfPropertyAccess {
  /** 文档行(0 起) */
  line: number;
  /** 根段(属性名)在访问行内的起始列(0 起) */
  character: number;
  /** self.<x.y> 的根段 */
  rootSymbol: string;
  /** self.<x.y> 的完整路径,与 resolvePropertyDefinition 的 fullPath 同口径 */
  fullPath: string;
}

/** 一处属性访问的 def 声明面(CodeLens 标题与跳转所需的最小面) */
export interface PropertyCodeLensHit {
  /** def 声明的属性名(FIXED_DICT 子键为键名) */
  propertyName: string;
  /** 组件槽属性命中的槽名(如 Inventory.items);无槽时缺省 */
  componentSlotName?: string;
  /** <Type> 直文本(别名未展开);未声明时 null */
  typeName: string | null;
  /** Flags 位集推导的可见域,定序 base → cell → client */
  domains: PropertyFlagDomain[];
  persistent: boolean;
  defFile: string;
  /** def 声明行(1 起) */
  defLine: number;
}

export interface PropertyCodeLensSpec {
  access: PythonSelfPropertyAccess;
  hit: PropertyCodeLensHit;
  title: string;
}

/** 与 pythonLanguageUtils.getPythonSelfAccessAtPosition 同正则,不另写口径 */
const PYTHON_SELF_ACCESS_PATTERN = /\bself\.(\w+(?:\.\w+)*)/g;

/** 解析/去重键:根段与完整路径都参与(FIXED_DICT 嵌套取父路径回退) */
export const propertyAccessKey = (access: PythonSelfPropertyAccess): string =>
  `${access.rootSymbol}\u0000${access.fullPath}`;

export function findPythonSelfPropertyAccesses(text: string): PythonSelfPropertyAccess[] {
  const accesses: PythonSelfPropertyAccess[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    PYTHON_SELF_ACCESS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PYTHON_SELF_ACCESS_PATTERN.exec(lines[index])) !== null) {
      const fullPath = match[1];
      // fullMatch 恒等于 'self.' + fullPath(批86 同口径:indexOf 会命中 'self'
      // 内部同形子串,按后缀算术取根段起点)
      const start = match.index + match[0].length - fullPath.length;
      accesses.push({
        line: index,
        character: start,
        rootSymbol: fullPath.split('.')[0],
        fullPath
      });
    }
  }

  return accesses;
}

/** 行标题:`属性 · <[槽名.]属性> · <类型> · <可见域> · Persistent?` */
export function describePropertyCodeLensTitle(hit: PropertyCodeLensHit): string {
  const display = hit.componentSlotName
    ? `${hit.componentSlotName}.${hit.propertyName}`
    : hit.propertyName;
  const type = hit.typeName ?? 'Type 未声明';
  const domains = hit.domains.length > 0 ? hit.domains.join('|') : 'Flags 未配置';
  const parts = ['属性', display, type, domains];

  if (hit.persistent) {
    parts.push('Persistent');
  }

  return parts.join(' · ');
}

export function buildPropertyCodeLenses(
  accesses: PythonSelfPropertyAccess[],
  resolve: (access: PythonSelfPropertyAccess) => PropertyCodeLensHit | null | undefined
): PropertyCodeLensSpec[] {
  // 不按属性去重:读者停在任意一行都要看得到标记,所以每处访问都出一枚镜;
  // 同一属性重复解析的浪费由 provider 侧的解析缓存挡掉
  return accesses.flatMap(access => {
    const hit = resolve(access);
    if (!hit) {
      return [];
    }

    return [{ access, hit, title: describePropertyCodeLensTitle(hit) }];
  });
}
