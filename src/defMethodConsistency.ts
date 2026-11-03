// C-19:def↔Python 方法一致性规则(诊断 + 一键骨架)的纯逻辑半边。
//
// 边界:跨文件集合差(def 方法 vs 同名实体类 Python 实现)的**判定与定位**
// 归本模块(纯函数,无 vscode 依赖,可单测);数据收集(读 def/扫 Python 符号
// 索引)在 entityMapping 的查询面,诊断/CodeAction 接线在 languageProviders 与
// extension。集合差口径与 Go to Implementations / IDE-NAV-014 同一实现查询面
// (listMethodImplementationsByIdentity)——诊断、CodeAction、跳转三方一致。
//
// 两条规则:
//  - def-method-missing-in-python(def 方法在对应实体类无实现)→ 警告,定位在
//    def 方法行,关联提示目标 Python 文件与类名。默认开。
//  - python-method-not-in-def(Python 有 def 无)→ 默认关(防误报,可配);跳过
//    引擎钩子(KBENGINE_HOOKS)与 dunder,仅剩真「有实现无声明」候选。
//
// 规则标识符(todo 命名):`def-method-missing-in-python` / `python-method-not-in-def`。
// 正向规则诊断 code = Rust lint 规则 id `def-method-missing-in-python`(必须与
// languageProviders 的 DEF_PYTHON_PARITY_DIAGNOSTIC_CODE 及 Rust lint 规则 id
// 同值,否则 CodeAction 严格比较不命中 → 恒空;KODE-AUD-002 统一);反向规则
// 无 Rust/CodeAction 对接口,沿用惯例 `kbengine.<camelCase>`(同 kbengine.receiverNone)。

import { PYTHON_BUILTIN_TYPE_ANNOTATIONS } from './pythonTypeStubs';

/** 诊断 code:def 方法在对应实体类 Python 脚本无实现(默认开) */
export const DEF_METHOD_MISSING_DIAGNOSTIC_CODE = 'def-method-missing-in-python';
/** 诊断 code:Python 实体类方法在 def 中无声明(默认关,防误报) */
export const PYTHON_METHOD_NOT_IN_DEF_DIAGNOSTIC_CODE = 'kbengine.pythonMethodNotInDef';
/** CodeAction 应用后按 def URI 重算缺实现诊断的命令(编辑后诊断消除) */
export const KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND =
  'kbengine.defMethodConsistency.revalidate';

/** 一键骨架体类型:pass(空体)或 raise(NotImplementedError),可配 */
export type MethodStubBody = 'pass' | 'raise';

/** 仅内建注解(可直接出现在方法签名,无需引入 typing):int/float/str/bool/bytes */
const BUILTIN_ANNOTATIONS = new Set(['int', 'float', 'str', 'bool', 'bytes']);

/**
 * def 参数类型(<Arg> 文本)→ Python 签名注解。只映射**内建名**注解
 * (PYTHON_BUILTIN_TYPE_ANNOTATIONS 同源,单一事实源):Tuple/Dict/List/Any 等
 * typing 泛型名需要 import 才能安全求值,骨架是纯插入编辑(不碰文件头),故
 * 不发射未导入名字,返回 undefined → 调用方退化为裸参数名(argN)。
 */
export function defArgTypeToPythonAnnotation(typeText: string): string | undefined {
  const trimmed = (typeText || '').trim();
  if (!trimmed) {
    return undefined;
  }
  const annotation = PYTHON_BUILTIN_TYPE_ANNOTATIONS[trimmed];
  if (!annotation || !BUILTIN_ANNOTATIONS.has(annotation)) {
    return undefined;
  }
  return annotation;
}

/**
 * 生成方法骨架(4 空格缩进,与 IDE-NAV-014 输出形态一致,形参自 def <Arg>
 * 类型映射)。body='pass' 空体;body='raise' 抛 NotImplementedError。
 */
export function buildMethodStubCode(
  methodName: string,
  argTypes: string[],
  body: MethodStubBody
): string {
  const params = argTypes.map((typeText, index) => {
    const annotation = defArgTypeToPythonAnnotation(typeText);
    return annotation ? `arg${index}: ${annotation}` : `arg${index}`;
  });
  const signature = params.length > 0 ? `self, ${params.join(', ')}` : 'self';
  const bodyLine = body === 'raise' ? '        raise NotImplementedError' : '        pass';
  return `    def ${methodName}(${signature}):\n${bodyLine}\n`;
}

/** 实体 def 方法缺实现的记录(来自 entityMapping 查询面) */
export interface DefMethodGap {
  name: string;
  /** 1 基行号(def 方法声明行) */
  line: number;
  section: string;
  declaredArgs: string[];
  ownerName: string;
  ownerFile: string;
}

/** 缺实现诊断项(纯数据,接线侧转 vscode.Diagnostic) */
export interface DefMethodMissingItem {
  message: string;
  /** 0 基字节偏移与方法名长度(诊断定位) */
  startOffset: number;
  endOffset: number;
  related: { targetFile: string; label: string };
}

const SECTION_LABELS: Record<string, string> = {
  BaseMethods: 'base',
  CellMethods: 'cell',
  ClientMethods: 'client'
};

const basenameOf = (filePath: string): string => filePath.split(/[\\/]/).pop() || filePath;

/**
 * def 方法缺实现诊断项(纯函数):给定 def 原文与缺实现记录,逐条定位方法名
 * 字节区间并组装消息与关联目标。方法名在声明行内定位(首个 `<name` 出现),
 * 定位不到回退整行区间。
 */
export function collectDefMethodMissingItems(
  defText: string,
  gaps: DefMethodGap[]
): DefMethodMissingItem[] {
  if (gaps.length === 0) {
    return [];
  }
  const lineStarts = computeLineStarts(defText);
  const items: DefMethodMissingItem[] = [];
  for (const gap of gaps) {
    const lineIndex = gap.line - 1;
    if (lineIndex < 0 || lineIndex >= lineStarts.length) {
      continue;
    }
    const lineStart = lineStarts[lineIndex];
    const lineEnd = lineStarts[lineIndex + 1] ?? defText.length;
    const sectionLabel = SECTION_LABELS[gap.section] ?? gap.section;
    const fileBase = basenameOf(gap.ownerFile);
    const message =
      `方法 ${gap.name} 声明于 ${sectionLabel} 段,但实体类 ${gap.ownerName} 的 ` +
      `Python 脚本未实现(目标 ${fileBase} 无 def ${gap.name})——运行时调用无处理函数,` +
      `可一键生成实现骨架`;
    const match = new RegExp(`<${escapeRegExp(gap.name)}[\\s/>]`).exec(
      defText.slice(lineStart, lineEnd)
    );
    const nameStart = match ? lineStart + match.index + 1 : lineStart;
    const nameEnd = match ? nameStart + gap.name.length : lineEnd;
    items.push({
      message,
      startOffset: nameStart,
      endOffset: nameEnd,
      related: {
        targetFile: gap.ownerFile,
        label: `实体类 ${gap.ownerName}(${fileBase})`
      }
    });
  }
  return items;
}

/** 反向记录:Python 实体类方法在 def 无声明(默认关) */
export interface PythonMethodNotInDefGap {
  methodName: string;
  line: number;
  character: number;
}

/** 反向诊断项(定位在 Python 方法行) */
export interface PythonMethodNotInDefItem {
  message: string;
  line: number;
  character: number;
  /** 方法名长度(0 基) */
  length: number;
}

export function collectPythonMethodNotInDefItems(
  gaps: PythonMethodNotInDefGap[]
): PythonMethodNotInDefItem[] {
  return gaps.map(gap => ({
    message:
      `方法 ${gap.methodName} 在实体类 Python 脚本中已实现,但对应 .def 未声明——` +
      `引擎不识别该 RPC(仅当 def 声明才可被调用方远程触发)`,
    line: gap.line,
    character: gap.character,
    length: gap.methodName.length
  }));
}

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
