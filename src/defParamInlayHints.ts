import * as vscode from 'vscode';
import type { EntityMappingManager, EntityMethodDefinitionLocation } from './entityMapping';
import { inferMethodSectionFromPythonFile } from './entityMapping';
import { parsePythonFile } from './pythonParser';
import { resolveEntityAnnotationType, getWorkspaceRootForDocument } from './definitionWorkspace';
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';

// def 函数形参 inlay(定义点,用户令 2026-10-27 任务2):entity 脚本区块
// (ClientMethods/BaseMethods/CellMethods,按文件路径判段,与
// inferMethodSectionFromPythonFile 同口径)内 `def foo(self, a, b):` 的
// 未手写标注形参后渲染 `: <Type>`,类型按「区块+方法名」反查 .def <Arg>
// 声明(resolveMethodDefinition 段闸 + resolveEntityAnnotationType,与调用点
// 实参 inlay/签名 formatter 同链,方向反转到定义点)。口径:def 未声明
// <Arg> 不出;形参已有标注不覆盖;区块外普通方法不出(不做推导);
// <ReturnType> 存在时顺带 `->` 提示;跨行 def 与现有 inlay 同规则
// (同行括号不闭合不出)。独立开关 kbengine.inlayHints.defParams(默认开),
// provider 现读配置下一次渲染即生效。

export interface DefParamSiteParam {
  /** 形参名 token 起(0 起列,行内绝对) */
  start: number;
  /** 形参名 token 尾后一列 */
  end: number;
  name: string;
  /** 已手写标注(`a: int` / `a: int = 1`)不覆盖 */
  hasAnnotation: boolean;
  /** *args / **kwargs:无 def <Arg> 对应位,该位不出 */
  isStar: boolean;
}

export interface DefParamSite {
  line: number;
  methodName: string;
  section: NonNullable<ReturnType<typeof inferMethodSectionFromPythonFile>>;
  /** 除 self/cls 外的形参序列(按位与 def <Arg> 对齐) */
  params: DefParamSiteParam[];
  /** 参数列表闭括号列(0 起)——ReturnType 提示锚在其后 */
  closeParenCharacter: number;
}

const IDENTIFIER = /^[A-Za-z_]\w*/;

/**
 * 提取定义点:只认区块文件内、类体内、单行闭合括号的 def。
 * 纯函数(文本 + 路径),测试免 vscode 依赖。
 */
export function findDefParamSites(text: string, filePath: string): DefParamSite[] {
  const section = inferMethodSectionFromPythonFile(filePath);
  // 区块外普通方法不出(不做推导)
  if (!section) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const sites: DefParamSite[] = [];
  const parsed = parsePythonFile(text, filePath);
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      const lineText = lines[location.line];
      if (lineText === undefined) {
        continue;
      }
      const site = parseDefLine(lineText, location.line, methodName, location.character, section);
      if (site) {
        sites.push(site);
      }
    }
  }
  return sites;
}

/** 单行 def 解析:括号不闭合(跨行)返回 undefined,与调用点 inlay 同规则 */
function parseDefLine(
  lineText: string,
  line: number,
  methodName: string,
  nameCharacter: number,
  section: DefParamSite['section']
): DefParamSite | undefined {
  // 方法名 token 后第一个 '(' 起参数列表
  const openParen = lineText.indexOf('(', nameCharacter + methodName.length);
  if (openParen < 0) {
    return undefined;
  }
  let depth = 0;
  let closeParen = -1;
  for (let index = openParen; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0 && ch === ')') {
        closeParen = index;
        break;
      }
    }
  }
  // 跨行 def(同行括号不闭合)不出
  if (closeParen < 0) {
    return undefined;
  }
  const params = splitParams(lineText.slice(openParen + 1, closeParen), openParen + 1);
  // 首参 self/cls 不参与(引擎实体方法恒 self;类方法 cls 同样不是 RPC 形参)
  const meaningful = params.length > 0 && (params[0].name === 'self' || params[0].name === 'cls')
    ? params.slice(1)
    : params;
  return {
    line,
    methodName,
    section,
    params: meaningful,
    closeParenCharacter: closeParen
  };
}

/** 顶层逗号切分(括号/方括号/字符串字面量内不切);name token 定位到行内绝对列 */
function splitParams(paramText: string, offset: number): DefParamSiteParam[] {
  const params: DefParamSiteParam[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const flush = (endExclusive: number): void => {
    const raw = paramText.slice(start, endExclusive);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      const star = trimmed.startsWith('*');
      const nameSource = star ? trimmed.replace(/^\*+/, '') : trimmed;
      // 名字 token:标注/默认值之前的标识符段
      const nameMatch = IDENTIFIER.exec(nameSource);
      const annotationSeparator = nameSource.indexOf(':', nameMatch ? nameMatch[0].length : 0);
      const defaultSeparator = nameSource.indexOf('=', nameMatch ? nameMatch[0].length : 0);
      const boundary = annotationSeparator >= 0 && (defaultSeparator < 0 || annotationSeparator < defaultSeparator)
        ? annotationSeparator
        : defaultSeparator;
      const nameText = boundary >= 0 ? nameSource.slice(0, boundary) : nameSource;
      const nameInRaw = raw.indexOf(nameText.trim());
      // 标注判定:名字 token 后首个顶层分隔符是 ':' 才算已标注
      // (默认值字典字面量里的 ':' 不算)
      const hasAnnotation = boundary >= 0 && nameSource[boundary] === ':';
      params.push({
        start: offset + start + (nameInRaw >= 0 ? nameInRaw : leading),
        end: offset + start + (nameInRaw >= 0 ? nameInRaw : leading) + nameText.trim().length,
        name: nameText.trim(),
        hasAnnotation,
        isStar: star
      });
    }
    start = endExclusive + 1;
  };
  for (let index = 0; index < paramText.length; index += 1) {
    const ch = paramText[index];
    if (quote) {
      if (ch === quote && paramText[index - 1] !== '\\') {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      flush(index);
    }
  }
  flush(paramText.length);
  return params;
}

/** inlay 项(纯数据;extension 侧转 vscode.InlayHint,测试免 vscode 依赖) */
export interface DefParamInlayItem {
  position: { line: number; character: number };
  text: string;
  kind: 'Parameter' | 'Type';
}

/**
 * 一个定义点的 inlay 项:未标注形参逐位配对 def <Arg>
 * (min(声明数, 形参数),与调用点实参 inlay 同口径),<ReturnType>
 * 存在且可解析时闭括号后 `-> <Type>`。纯函数。
 */
export function buildDefParamInlayItems(
  site: DefParamSite,
  declaration: Pick<EntityMethodDefinitionLocation, 'declaredArgs' | 'declaredReturnType'>,
  workspaceRoot: string
): DefParamInlayItem[] {
  const items: DefParamInlayItem[] = [];
  const declaredArgs = declaration.declaredArgs ?? [];
  // 只做 def 已声明的:def 未声明 <Arg> 不硬造
  const paired = Math.min(declaredArgs.length, site.params.length);
  for (let index = 0; index < paired; index += 1) {
    const declared = declaredArgs[index].trim();
    const param = site.params[index];
    // def 有 <Arg> 无 <Type> 直文本/形参已手写标注/*args 位 → 该位不出
    if (!declared || param.hasAnnotation || param.isStar) {
      continue;
    }
    // 类型与签名 formatter 同一解析链;链断/未知(落 Any)→ 该位不出
    const annotation = resolveEntityAnnotationType(workspaceRoot, declared);
    if (annotation === PYTHON_TYPE_STUB_FALLBACK) {
      continue;
    }
    items.push({
      position: { line: site.line, character: param.end },
      text: `: ${annotation}`,
      kind: 'Parameter'
    });
  }
  const declaredReturn = declaration.declaredReturnType?.trim();
  if (declaredReturn) {
    const returnAnnotation = resolveEntityAnnotationType(workspaceRoot, declaredReturn);
    if (returnAnnotation !== PYTHON_TYPE_STUB_FALLBACK) {
      items.push({
        position: { line: site.line, character: site.closeParenCharacter + 1 },
        text: ` -> ${returnAnnotation}`,
        kind: 'Type'
      });
    }
  }
  return items;
}

export class DefParamInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('inlayHints.defParams', true)) {
      return [];
    }
    const text = document.getText();
    const workspaceRoot = getWorkspaceRootForDocument(document) ?? '';
    const hints: vscode.InlayHint[] = [];
    const resolved = new Map<
      string,
      Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>
    >();
    for (const site of findDefParamSites(text, document.fileName)) {
      // inlay 按可视区要:视图口外的定义行不出 hint
      if (site.line < range.start.line || site.line > range.end.line) {
        continue;
      }
      const key = `${site.section}.${site.methodName}`;
      if (!resolved.has(key)) {
        let location: EntityMethodDefinitionLocation | null;
        try {
          location = await this.entityMappingManager.resolveMethodDefinition(
            document.fileName,
            site.methodName,
            site.section
          );
        } catch {
          location = null;
        }
        resolved.set(key, location);
      }
      const declaration = resolved.get(key) ?? null;
      // def 无该方法声明(未在 .def 登记)→ 不出,不推导
      if (!declaration) {
        continue;
      }
      for (const item of buildDefParamInlayItems(site, declaration, workspaceRoot)) {
        hints.push(
          new vscode.InlayHint(
            new vscode.Position(item.position.line, item.position.character),
            item.text,
            item.kind === 'Parameter'
              ? vscode.InlayHintKind.Parameter
              : vscode.InlayHintKind.Type
          )
        );
      }
    }
    return hints;
  }
}
