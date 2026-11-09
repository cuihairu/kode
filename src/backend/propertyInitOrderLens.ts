/**
 * 属性先于 __init__ 装载的可见化(IDE-PROP-001)。
 *
 * 引擎事实(语义已载 languageProviders 属性落点四档注释):KBEngine 在
 * __init__ 之前就把 Entity.def 声明的属性装载进实体,脚本里未必有同名
 * 赋值——self.hp 在 __init__ 内直接可读。这一引擎语义对只看 Python 的
 * 读者不可见(属性"未赋值先使用"),故在实体类的 __init__ 声明处出一行
 * CodeLens:「属性先于 __init__ 装载 · 来自 <实体>.def」,点击回 def。
 *
 * 纯逻辑层,不 import vscode:扫类定义与 __init__ 声明行 + 按外部解析器
 * (实体名 → def 路径)出镜;provider 层(languageProviders)装配成
 * vscode.CodeLens,独立开关 kbengine.codeLens.propertyInitOrder。
 *
 * 已知边界:类名即实体名(引擎装载链里 def 基名与实体类同名;四档落点的
 * 第一档同此口径),类名解析不到 def(工作区没有该实体)就不出镜——不
 * 给非实体类冒充「来自 Entity.def」。def 内是否真有 <Properties> 不在本
 * 层核实(标题说的是装载语义,不是属性清单)。
 */

/** 实体类 __init__ 处的一枚「属性先装载」镜 */
export interface PropertyInitOrderLensSpec {
  /** `def __init__` 声明行(0 起)——镜锚在 __init__ 行(标题说的就是它) */
  line: number;
  /** `def` 关键字起始列(0 起) */
  character: number;
  /** 实体类名(= def 文件基名) */
  entityName: string;
  /** 解析到的 def 文件绝对路径 */
  defPath: string;
  /** 镜标题 */
  title: string;
}

const PYTHON_CLASS_PATTERN = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PYTHON_INIT_PATTERN = /^(\s*)def\s+__init__\s*\(/;

export function describePropertyInitOrderTitle(entityName: string): string {
  return `属性先于 __init__ 装载 · 来自 ${entityName}.def`;
}

/**
 * 扫 python 源出「属性先装载」镜规格。类上下文按缩进维护成栈:类头入栈
 * (先弹出缩进 ≥ 自身的层),`def __init__(` 出现时弹出缩进 ≥ 自身的层后
 * 归栈顶类(缩进更浅=外层类身体在嵌套类之后继续);类名经 resolveDefPath
 * 解析到 def 才出镜(解析不到如实不出)。
 */
export function buildPropertyInitOrderLensSpecs(
  content: string,
  resolveDefPath: (entityName: string) => string | null
): PropertyInitOrderLensSpec[] {
  const specs: PropertyInitOrderLensSpec[] = [];
  const lines = content.split(/\r?\n/);
  const classStack: Array<{ name: string; indent: number }> = [];
  // 同一实体类只出第一枚镜(同名类重复定义本身是异常形态,不放大)
  const seenEntities = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const classMatch = PYTHON_CLASS_PATTERN.exec(line);
    if (classMatch) {
      const indent = classMatch[1].length;
      while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
        classStack.pop();
      }
      classStack.push({ name: classMatch[2], indent });
      continue;
    }

    const initMatch = PYTHON_INIT_PATTERN.exec(line);
    if (initMatch) {
      const indent = initMatch[1].length;
      while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
        classStack.pop();
      }
      const owner = classStack[classStack.length - 1];
      if (!owner) {
        continue;
      }
      const entityName = owner.name;
      if (seenEntities.has(entityName)) {
        continue;
      }
      const defPath = resolveDefPath(entityName);
      if (!defPath) {
        continue;
      }
      seenEntities.add(entityName);
      specs.push({
        line: index,
        character: indent,
        entityName,
        defPath,
        title: describePropertyInitOrderTitle(entityName)
      });
    }
  }

  return specs;
}
