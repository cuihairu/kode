import * as vscode from 'vscode';
import type { EntityMappingManager, EntityMethodDefinitionLocation } from './entityMapping';
import { inferMethodSectionFromPythonFile } from './entityMapping';
import { parsePythonFile, pythonCodeLines } from './backend/pythonParser';
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
  /** 形参名所在行(0 起)——KODE-SYN-004 起签名跨行,形参可落在续行 */
  line: number;
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
  /** 参数列表闭括号行(0 起)——KODE-SYN-004 起闭括号可在续行 */
  closeParenLine: number;
  /** 参数列表闭括号列(0 起,closeParenLine 行内)——ReturnType 提示锚在其后 */
  closeParenCharacter: number;
}

const IDENTIFIER = /^[A-Za-z_]\w*/;

/**
 * 提取定义点:区块文件内、类体内的 def(签名可跨行,KODE-SYN-004)。
 * 纯函数(文本 + 路径),测试免 vscode 依赖。
 */
export function findDefParamSites(text: string, filePath: string): DefParamSite[] {
  const section = inferMethodSectionFromPythonFile(filePath);
  // 区块外普通方法不出(不做推导)
  if (!section) {
    return [];
  }
  // KODE-SYN-004:统一事实源=pythonCodeLines 掩码行域(列不位移,引号/注释
  // 天然中性化)——跨行签名解析与 semanticTokens 形参着色走同一份掩码行,
  // 与 Rust def_param_hints 镜像逐位同构
  const maskedLines = pythonCodeLines(text);
  const sites: DefParamSite[] = [];
  const parsed = parsePythonFile(text, filePath);
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      if (maskedLines[location.line] === undefined) {
        continue;
      }
      const site = parseDefSignature(maskedLines, location.line, methodName, location.character, section);
      if (site) {
        sites.push(site);
      }
    }
  }
  return sites;
}

/**
 * 跨行 def 签名解析(KODE-SYN-004):统一事实源=pythonCodeLines 掩码行域
 * (列不位移;引号/字符串/注释已中性化,括号/逗号扫描零字符串干扰)。
 * 从方法名 token 后首个 '(' 起,跨行括号配对到 depth-0 ')';未闭合(编辑中
 * 签名/EOF 截断)返回 undefined 如实让位。形参位(名字 token 行/列 UTF-16
 * 域)与 inlay/semanticTokens 消费面共用同一产物;`/` 与裸 `*` 仅为 Python
 * 形参标记不占 <Arg> 位,出序列;`*args`/`**kwargs` 保留 isStar 位。
 * 与 Rust def_param_hints parse_def_signature 逐位同构。
 */
export function parseDefSignature(
  maskedLines: readonly string[],
  startLine: number,
  methodName: string,
  nameCharacter: number,
  section: DefParamSite['section']
): DefParamSite | undefined {
  const firstLine = maskedLines[startLine];
  if (firstLine === undefined) {
    return undefined;
  }
  const openParen = firstLine.indexOf('(', nameCharacter + methodName.length);
  if (openParen < 0) {
    return undefined;
  }
  // 跨行分段:depth-0 逗号切段,每段记录 (line, col, ch) 单元流;depth 初值
  // 1=参数列表开括号已计入(扫描自 openParen+1 起,与旧核含位起扫等价)
  interface MaskUnit { line: number; col: number; ch: string; }
  const segments: MaskUnit[][] = [[]];
  let depth = 1;
  let closeParenLine = -1;
  let closeParenCharacter = -1;
  scan: for (let line = startLine; line < maskedLines.length; line += 1) {
    const text = maskedLines[line];
    const from = line === startLine ? openParen + 1 : 0;
    for (let col = from; col < text.length; col += 1) {
      const ch = text[col];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        segments[segments.length - 1].push({ line, col, ch });
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0 && ch === ')') {
          closeParenLine = line;
          closeParenCharacter = col;
          break scan;
        }
        segments[segments.length - 1].push({ line, col, ch });
      } else if (ch === ',' && depth === 1) {
        // depth 1=参数列表顶层(开括号已计入 depth);嵌套默认值里的逗号
        // 在 depth ≥2 不切
        segments.push([]);
      } else {
        segments[segments.length - 1].push({ line, col, ch });
      }
    }
  }
  // 编辑中未闭合签名:括号未配对到 depth-0 ')' 不出
  if (closeParenLine < 0) {
    return undefined;
  }
  const params: DefParamSiteParam[] = [];
  for (const segment of segments) {
    const param = flushSegment(segment, maskedLines);
    if (param) {
      params.push(param);
    }
  }
  // 首参 self/cls 不参与(引擎实体方法恒 self;类方法 cls 同样不是 RPC 形参)
  const meaningful = params.length > 0 && (params[0].name === 'self' || params[0].name === 'cls')
    ? params.slice(1)
    : params;
  return {
    line: startLine,
    methodName,
    section,
    params: meaningful,
    closeParenLine,
    closeParenCharacter
  };
}

/** 单段成形:跳空白(跨行续行的行首缩进)→ `*` 标记 → 名字 token;标注判定
 * 走段内 depth-0 首个 ':'/'='(嵌套默认值里的分隔符不算)。`/` 与裸 `*`
 * (后随无标识符)是 Python 形参标记,不产形参位。 */
function flushSegment(
  segment: Array<{ line: number; col: number; ch: string }>,
  maskedLines: readonly string[]
): DefParamSiteParam | undefined {
  let index = 0;
  while (index < segment.length && /\s/.test(segment[index].ch)) {
    index += 1;
  }
  if (index >= segment.length) {
    return undefined; // 尾逗号空段不产形参
  }
  let isStar = false;
  while (index < segment.length && segment[index].ch === '*') {
    isStar = true;
    index += 1;
  }
  const nameUnit = segment[index];
  if (!nameUnit) {
    return undefined; // 裸 `*`(keyword-only 标记):无名字 token 不产形参位
  }
  const nameLineText = maskedLines[nameUnit.line] ?? '';
  const firstUnit = nameLineText.charCodeAt(nameUnit.col) || 0;
  // ASCII 侧走标识符判定;非 ASCII 单元(中文等 Unicode 名字,PEP 3131)
  // 保留为名字单元。`/` 等标记是 ASCII 非标识符,照旧不产形参位。
  if (!IDENTIFIER.test(nameLineText.slice(nameUnit.col, nameUnit.col + 1)) && firstUnit < 0x80) {
    return undefined; // `/`(positional-only 标记)等 ASCII 非标识符段不产形参位
  }
  let nameEnd = nameUnit.col + 1;
  while (nameEnd < nameLineText.length) {
    const unit = nameLineText.charCodeAt(nameEnd);
    if (!(/\w/.test(String.fromCharCode(unit)) || unit >= 0x80)) {
      break;
    }
    nameEnd += 1;
  }
  const name = nameLineText.slice(nameUnit.col, nameEnd);
  // 名字 token 后首个 depth-0 分隔符是 ':' 才算已标注(默认值字典字面量
  // 里的 ':' 处在 depth ≥1,不算)
  let segDepth = 0;
  let hasAnnotation = false;
  let afterName = false;
  for (const unit of segment) {
    if (!afterName) {
      if (unit.line === nameUnit.line && unit.col === nameUnit.col + name.length) {
        afterName = true; // 命中位本身也可能是分隔符(`a: int`),落穿到下面的判定
      } else {
        continue;
      }
    }
    if (unit.ch === '(' || unit.ch === '[' || unit.ch === '{') {
      segDepth += 1;
    } else if (unit.ch === ')' || unit.ch === ']' || unit.ch === '}') {
      segDepth -= 1;
    } else if (segDepth === 0 && unit.ch === ':') {
      hasAnnotation = true;
      break;
    } else if (segDepth === 0 && unit.ch === '=') {
      break;
    }
  }
  return {
    start: nameUnit.col,
    end: nameUnit.col + name.length,
    line: nameUnit.line,
    name,
    hasAnnotation,
    isStar
  };
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
      position: { line: param.line, character: param.end },
      text: `: ${annotation}`,
      kind: 'Parameter'
    });
  }
  const declaredReturn = declaration.declaredReturnType?.trim();
  if (declaredReturn) {
    const returnAnnotation = resolveEntityAnnotationType(workspaceRoot, declaredReturn);
    if (returnAnnotation !== PYTHON_TYPE_STUB_FALLBACK) {
      items.push({
        position: { line: site.closeParenLine, character: site.closeParenCharacter + 1 },
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
    range: vscode.Range,
    token?: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    // RUST-149 批 3:取消令牌贯穿——逐点位 def 反查是 await 面,取消后不再
    // 解析后续方法(与 rpc CodeLens 同口径:循环顶闸 + 返回空)
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !vscode.workspace.getConfiguration('kbengine').get<boolean>('inlayHints.defParams', true)) {
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
      // inlay 按可视区要:签名跨行后取定义行..闭括号行与视口的交集行
      // (KODE-SYN-004:续行形参在视口内也应出 hint,定义行出视口不算出局)
      if (site.closeParenLine < range.start.line || site.line > range.end.line) {
        continue;
      }
      if (cancelled()) {
        return [];
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
