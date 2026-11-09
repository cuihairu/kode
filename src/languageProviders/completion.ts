// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { findFilesAcrossRoots } from '../scanRoots';
import { EntityMappingManager } from '../entityMapping';
import { getRegisteredCustomTypes, getRegisteredAliasTypes, getRegisteredEntities, getWorkspaceRootForDocument, resolveEntityAnnotationType } from '../definitionWorkspace';
import { HOOK_CATEGORY_NAMES, KBENGINE_HOOKS } from '../hooks';
import { KBENGINE_ENTRY_HOOKS, isComponentEntryScriptFile } from '../entryHooks';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_RELOAD_FUNCTIONS, KBENGINE_TYPES } from '../kbengineMetadata';
import { formatEntityBuiltinPropertyDetail, getEntityBuiltinPropertiesForFace, hasKnownEntityBuiltinPropertyType, resolveEntityComponentFaceFromPath, type EntityComponentFace } from '../backend/entityBuiltinProperties';
import { PYTHON_TYPE_STUB_FALLBACK } from '../pythonTypeStubs';
import { getPythonSelfCompletionContext } from '../backend/pythonLanguageUtils';
import { filterKbeSymbols, getKbeAliases, getKbeCompletionContext, kbeCompletionDocumentation } from '../kbeModuleIndex';
import { EngineApiCatalog } from '../backend/engineApiMetadata';
import { getEngineVersion } from '../engineVersion';
import { getLanguageFeatureConfig } from './shared';
import {
  getKodeCoreShadowGate,
  serveCompletionFromRust,
  type LspCompletionReportFace
} from '../kodeCoreShadowFaces';
export const TOP_LEVEL_DEF_TAGS = [
  'Parent',
  'Interfaces',
  'Components',
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods',
  'DetailLevels',
  'Volatile'
];

export const PROPERTY_CHILD_TAGS = [
  'Type',
  'Flags',
  'Default',
  'Persistent',
  'Identifier',
  'Index',
  'DatabaseLength',
  'DetailLevel',
  'Utype'
];

export const BASE_OR_CELL_METHOD_CHILD_TAGS = ['Arg', 'Utype', 'Exposed'];
export const CLIENT_METHOD_CHILD_TAGS = ['Arg', 'Utype'];
export const DETAIL_LEVEL_TAGS = ['NEAR', 'MEDIUM', 'FAR'];
export const DETAIL_LEVEL_VALUE_TAGS = ['radius', 'hyst'];
export const ENTITY_BASE_DATA_FLAGS = new Set(['BASE', 'BASE_AND_CLIENT']);
export const ENTITY_CELL_DATA_FLAGS = new Set([
  'CELL_PUBLIC',
  'CELL_PRIVATE',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
]);
export const ENTITY_CLIENT_DATA_FLAGS = new Set([
  'BASE_AND_CLIENT',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
]);
export const PROPERTY_SCOPE_LABELS = {
  base: 'Base',
  cell: 'Cell',
  client: 'Client'
} as const;
export type PropertyScope = keyof typeof PROPERTY_SCOPE_LABELS;

export function createCompletionItems(
  labels: string[],
  kind: vscode.CompletionItemKind
): vscode.CompletionItem[] {
  return labels.map(label => new vscode.CompletionItem(label, kind));
}

/**
 * def 方法签名文本(审计遗留承诺 2026-10-21;用户令 2026-10-21 统一解析链):
 * def 声明了 <Arg> 的形参带类型注解(arg1: int 形态),类型走
 * resolveEntityAnnotationType 同一解析链——内建直查 → types.xml/alias.xml
 * 自定义类型逐层下钻;声明面 hover、接收者面 hover 与补全方法 detail 三处
 * 同源,一面都不得私走单表。def 未声明 <Arg> 的不硬造(只出 self);<Arg>
 * 在而类型文本空的只出名不造型。链断/未知(解析落 Any)按「能推才显」闸
 * 同规则无提示降级:只出名不带注解(不显 `: Any`)。声明形参名以 def 为
 * 准不可考,统一 argN 与存根生成器同口径。
 */
export function formatDefMethodParameter(
  workspaceRoot: string | undefined,
  arg: string,
  index: number
): string {
  const trimmed = arg.trim();
  if (!trimmed) {
    // 有 <Arg> 无 <Type>:只出名不造型
    return `arg${index + 1}`;
  }
  const annotation = resolveEntityAnnotationType(workspaceRoot ?? '', trimmed);
  // 解析链断/未知(落 Any)→ 无提示降级,只出名(三提示面不显 Any)
  if (annotation === PYTHON_TYPE_STUB_FALLBACK) {
    return `arg${index + 1}`;
  }
  return `arg${index + 1}: ${annotation}`;
}

export function formatDefMethodSignature(
  workspaceRoot: string | undefined,
  methodName: string,
  declaredArgs?: readonly string[]
): string {
  const parameters = (declaredArgs ?? []).map((arg, index) =>
    formatDefMethodParameter(workspaceRoot, arg, index)
  );
  return `def ${methodName}(self${parameters.length > 0 ? `, ${parameters.join(', ')}` : ''})`;
}

export function getTextBeforePosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const start = new vscode.Position(0, 0);
  return document.getText(new vscode.Range(start, position));
}

export function getOpenTagStack(text: string): string[] {
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z][\w-]*)[^>]*\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const [tagText, tagName] = match;
    if (tagText.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === tagName) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (tagText.endsWith('/>')) {
      continue;
    }

    stack.push(tagName);
  }

  return stack;
}

export function getDefTagCompletionLabels(
  document: vscode.TextDocument,
  position: vscode.Position
): string[] {
  const textBeforeCursor = getTextBeforePosition(document, position);
  const stack = getOpenTagStack(textBeforeCursor);
  const currentTag = stack[stack.length - 1];
  const parentTag = stack[stack.length - 2];
  const trimmedText = textBeforeCursor.trimEnd();

  if ((currentTag === 'Type' || currentTag === 'Arg') && /ARRAY\s*<$/i.test(trimmedText)) {
    // 引擎源码 FixedArrayType::initialize 强制要求 <of> 子节点声明元素类型
    return ['of'];
  }

  if (!currentTag || currentTag === 'root') {
    return TOP_LEVEL_DEF_TAGS;
  }

  if (currentTag === 'Properties') {
    return [];
  }

  if (currentTag === 'Interfaces') {
    return ['Interface', 'interface', 'Type', 'type'];
  }

  if (currentTag === 'Components' || currentTag === 'Parent') {
    return [];
  }

  if (currentTag === 'Volatile') {
    return ['position', 'yaw', 'pitch', 'roll', 'optimized'];
  }

  if (TOP_LEVEL_DEF_TAGS.includes(currentTag) && currentTag !== 'DetailLevels' && currentTag !== 'Interfaces') {
    return [];
  }

  if (currentTag === 'DetailLevels') {
    return DETAIL_LEVEL_TAGS;
  }

  if (DETAIL_LEVEL_TAGS.includes(currentTag) && parentTag === 'DetailLevels') {
    return DETAIL_LEVEL_VALUE_TAGS;
  }

  if (parentTag === 'Properties') {
    return PROPERTY_CHILD_TAGS;
  }

  if (parentTag === 'BaseMethods' || parentTag === 'CellMethods') {
    return BASE_OR_CELL_METHOD_CHILD_TAGS;
  }

  if (parentTag === 'ClientMethods') {
    return CLIENT_METHOD_CHILD_TAGS;
  }

  return [];
}

/**
 * SP-3: detect cursor inside a string literal of addSpaceGeometryMapping(...).
 * lineText is the line prefix up to the cursor. Returns the typed prefix
 * inside the open string, or null when not in a target string context.
 */
export function getAddSpaceGeometryStringPrefix(lineText: string): { prefix: string } | null {
  const callIdx = lineText.indexOf('addSpaceGeometryMapping');
  if (callIdx < 0) {
    return null;
  }
  const openIdx = lineText.indexOf('(', callIdx);
  if (openIdx < 0) {
    return null;
  }
  let inString: string | null = null;
  let stringStart = -1;
  let depth = 0;
  for (let i = openIdx; i < lineText.length; i += 1) {
    const ch = lineText[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      stringStart = i + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth <= 0) {
        return null; // left the call
      }
    }
  }
  if (!inString || depth < 1) {
    return null;
  }
  return { prefix: lineText.slice(stringStart) };
}

/**
 * LSP CompletionItemKind 数值 → vscode.CompletionItemKind(kode-server 投影:
 * method=2/type/entity/alias=7(Class)/property=10(Property);其余归 Text)。
 */
function completionKindFromLsp(lspKind: number): vscode.CompletionItemKind {
  switch (lspKind) {
    case 2:
      return vscode.CompletionItemKind.Method;
    case 10:
      return vscode.CompletionItemKind.Property;
    case 7:
      return vscode.CompletionItemKind.Class;
    default:
      // Rust 只投影 2/7/10;未知数值归 Class(类型桶)保守兜底。
      return vscode.CompletionItemKind.Class;
  }
}

/** kode-server 补全面 → vscode.CompletionItem[](label/kind/detail 投影) */
export function lspCompletionToVscode(face: LspCompletionReportFace): vscode.CompletionItem[] {
  return face.items.map(item => {
    const completion = new vscode.CompletionItem(item.label, completionKindFromLsp(item.kind));
    if (item.detail) {
      completion.detail = item.detail;
    }
    return completion;
  });
}

export class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  // 内建属性补全(用户令 2026-10-21 内建属性单 ③):self. 上下文需要 def
  // 归属面兜底,可选注入;缺省时仅目录域判面(既有无参用例口径不变)。
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (token?.isCancellationRequested) return null;
    // 2026-11-08 用户令「直接切」:服务轨道下补全先走 Rust(语料文档)。Rust
    // 判定出上下文且有条目即 Rust 优先;空集(null 或 items=[])回 TS 既有链
    // (方法面 def 链与 TS 的 KBENGINE_HOOKS 语义不同,Rust 空集时让位,
    // 不空集时 Rust 面是 def 链声明的成员——直接切语义)。
    if (getKodeCoreShadowGate()?.serveFromRust()) {
      return this.provideCompletionRustFirst(document, position, token);
    }
    return this.provideCompletionItemsSync(document, position, token);
  }

  /** Rust 优先补全:非空 Rust 条目集即用,否则回 TS 既有链路。 */
  private async provideCompletionRustFirst(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    const report = await serveCompletionFromRust(document, position);
    if (token?.isCancellationRequested) return [];
    if (report && report.items.length > 0) {
      return lspCompletionToVscode(report);
    }
    const tsResult = await this.provideCompletionItemsSync(document, position, token);
    return tsResult ?? [];
  }

  /** TS 既有补全链路(原 provideCompletionItems 主体,Rust 回落复用)。 */
  private provideCompletionItemsSync(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (token?.isCancellationRequested) return null;
    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (lineText.match(/<(Type|Arg|of)>\s*\w*$/)) {
      getKnownTypeSuggestions(document, token).forEach(type => {
        const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
        item.detail = type.detail;
        item.documentation = new vscode.MarkdownString(type.documentation);
        items.push(item);
      });
      return token?.isCancellationRequested ? null : items;
    }

    if (lineText.match(/<Flags>\s*\w*$/)) {
      KBENGINE_FLAGS.forEach(flag => {
        const item = new vscode.CompletionItem(flag.name, vscode.CompletionItemKind.Enum);
        item.detail = flag.detail;
        item.documentation = new vscode.MarkdownString(flag.documentation);
        items.push(item);
      });
      return items;
    }

    if (lineText.match(/<DetailLevel>\s*\w*$/)) {
      DETAIL_LEVELS.forEach(level => {
        const item = new vscode.CompletionItem(level, vscode.CompletionItemKind.Constant);
        items.push(item);
      });
      return items;
    }

    if (lineText.endsWith('<')) {
      return createCompletionItems(
        getDefTagCompletionLabels(document, position),
        vscode.CompletionItemKind.Property
      );
    }

    const openTags = getOpenTagStack(getTextBeforePosition(document, position));
    const enclosingTag = openTags[openTags.length - 1];
    const inMethodsSection =
      enclosingTag === 'BaseMethods' || enclosingTag === 'CellMethods' || enclosingTag === 'ClientMethods';
    const methodPrefixMatch = lineText.match(/<([A-Za-z][A-Za-z0-9_]*)$/);

    if (inMethodsSection && methodPrefixMatch) {
      const methodName = methodPrefixMatch[1].toLowerCase();
      KBENGINE_HOOKS.forEach(hook => {
        if (hook.name.toLowerCase().startsWith(methodName)) {
          const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
          item.detail = `${vscode.l10n.t(HOOK_CATEGORY_NAMES[hook.category])} - ${hook.description}`;
          item.documentation = new vscode.MarkdownString(
            `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}\n\n签名:\n\`\`\`python\n${hook.signature}\n\`\`\``
          );
          items.push(item);
        }
      });
      return items;
    }

    if (document.fileName.endsWith('.py') || document.fileName.endsWith('.def')) {
      // 内建属性补全(用户令 2026-10-21 内建属性单 ③):实体脚本内 self.<片段>
      // 上下文给所在面的属性项(单段,self.cell.X 等多段访问不接管);
      // 非实体脚本不接管(返回空,不遮蔽既有链)。
      // kbengine.entity.builtinProperties=false 时整体让位,回落原链路。
      if (document.fileName.endsWith('.py')) {
        const selfContext = getPythonSelfCompletionContext(lineText);
        if (
          getLanguageFeatureConfig().entityBuiltinProperties &&
          selfContext &&
          selfContext.parentPath === ''
        ) {
          return this.provideBuiltinPropertyCompletions(document);
        }

        // SP-1: 入口脚本(kbemain)模块级 SPI——`def on...` 前缀补全。
        // 仅组件入口脚本路径生效,实体脚本(Avatar.py 等)不接管。
        const entryDefMatch = lineText.match(/def\s+(on\w*)$/);
        if (entryDefMatch && isComponentEntryScriptFile(document.fileName, 'cellapp')) {
          const prefix = entryDefMatch[1].toLowerCase();
          KBENGINE_ENTRY_HOOKS.forEach(hook => {
            if (hook.name.toLowerCase().startsWith(prefix)) {
              const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
              item.detail = `Entry Script (${hook.component}) - ${hook.description}`;
              item.documentation = new vscode.MarkdownString(
                `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}\n\n签名:\n\`\`\`python\n${hook.signature}\n\`\`\``
              );
              items.push(item);
            }
          });
          return items;
        }

        // SP-3: addSpaceGeometryMapping 字符串实参(path 第 3 参 / params dict 值)
        // → 扫描 workspace+assetsRoot 的 *.navmesh/*.tmx 路径补全。
        const navString = getAddSpaceGeometryStringPrefix(lineText);
        if (navString !== null) {
          return this.provideNavPathCompletions(document, navString.prefix, token);
        }
      }

      if (lineText.match(/KBEngine\.[a-zA-Z]*$/)) {
        KBENGINE_RELOAD_FUNCTIONS
          .filter(fn => fn.name.startsWith('KBEngine.'))
          .forEach(fn => {
            const shortName = fn.name.replace('KBEngine.', '');
            const item = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Function);
            item.detail = fn.detail;
            item.documentation = new vscode.MarkdownString(fn.documentation);
            items.push(item);
          });
        return items;
      }

      if (lineText.match(/importlib\.[a-zA-Z]*$/)) {
        const fn = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name === 'importlib.reload');
        // 不可达(批64 定性):KBENGINE_RELOAD_FUNCTIONS 是模块级静态白名单,
        // 恒含 'importlib.reload'(src/kbengineMetadata.ts),故 fn 恒真。
        // 精确单行区间只摘除该 if 的分支条目,补全项构造保持被覆盖计入分母。
        /* istanbul ignore start */
        if (fn) {
        /* istanbul ignore stop */
          const item = new vscode.CompletionItem('reload', vscode.CompletionItemKind.Function);
          item.detail = fn.detail;
          item.documentation = new vscode.MarkdownString(fn.documentation);
          items.push(item);
        }
        return items;
      }
    }

    return items;
  }

  /**
   * self. 上下文的内建属性项(用户令 ③④):目录域判面先行;判不出且注入了
   * manager 时问 def 归属——唯一面给全量面属性,多面歧义或判为实体但无面
   * → 只给宏公共 3;非实体(manager 判 null 且无目录域)→ 空表不接管。
   */
  /**
   * SP-3: scan workspace+assetsRoot for *.navmesh/*.tmx and offer relative
   * paths filtered by the typed string prefix. Empty result on no match
   * (does not block or error).
   */
  private async provideNavPathCompletions(
    document: vscode.TextDocument,
    prefix: string,
    token?: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    const [navmeshes, tmxes] = await Promise.all([
      findFilesAcrossRoots('**/*.navmesh', null, token),
      findFilesAcrossRoots('**/*.tmx', null, token)
    ]);
    if (token?.isCancellationRequested) {
      return [];
    }
    const root = getWorkspaceRootForDocument(document);
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    for (const uri of [...navmeshes, ...tmxes]) {
      const abs = uri.fsPath.replace(/\\/g, '/');
      const rel = root
        ? path.relative(root, uri.fsPath).replace(/\\/g, '/')
        : abs;
      if (prefix && !rel.includes(prefix)) {
        continue;
      }
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
      item.detail = abs.endsWith('.navmesh') ? 'navmesh' : 'tmx';
      item.documentation = abs;
      items.push(item);
    }
    return items;
  }

  private provideBuiltinPropertyCompletions(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    if (pathFace) {
      return createBuiltinPropertyCompletionItems(pathFace);
    }
    const manager = this.entityMappingManager;
    if (!manager) {
      return [];
    }
    return manager
      .getEntityComponentFacesForPythonFile(document.fileName)
      .then(faces => {
        // null = 无 def 归属(非实体)→ 不接管;空数组/多面 → 只给宏公共 3
        if (faces === null) {
          return [];
        }
        return createBuiltinPropertyCompletionItems(faces.length === 1 ? faces[0] : null);
      })
      .catch(() => []);
  }
}

/** 面属性 → 补全项(label 右列灰字类型(Pylance 同款),detail 面与读写短句,documentation 带引擎注册面取证) */
export function createBuiltinPropertyCompletionItems(
  face: EntityComponentFace | null
): vscode.CompletionItem[] {
  return getEntityBuiltinPropertiesForFace(face).map(property => {
    // label 用 CompletionItemLabel 形态:名称旁右列灰字类型(用户令 2026-10-21
    // 形态升级单 ②),detail 保留读写/面短句(单一 formatter,与 hover 同源);
    // Any 位按「能推才显」闸不显示类型(右列空,无 Any 降级)
    const item = new vscode.CompletionItem(
      { label: property.name, description: hasKnownEntityBuiltinPropertyType(property) ? property.type : undefined },
      vscode.CompletionItemKind.Property
    );
    item.detail = formatEntityBuiltinPropertyDetail(face, property);
    item.documentation = new vscode.MarkdownString(`引擎注册面: \`${property.source}\``);
    return item;
  });
}

export interface KnownTypeContext {
  builtins: Set<string>;
  customTypes: Set<string>;
  entityTypes: Set<string>;
}

export interface KnownTypeSuggestion {
  name: string;
  detail: string;
  documentation: string;
}

export function getKnownTypeContext(document: vscode.TextDocument, token?: vscode.CancellationToken): KnownTypeContext {
  const builtins = new Set(KBENGINE_TYPES.map(type => type.name));
  const workspaceRoot = getWorkspaceRootForDocument(document);

  if (!workspaceRoot) {
    return {
      builtins,
      customTypes: new Set<string>(),
      entityTypes: new Set<string>()
    };
  }

  return {
    builtins,
    customTypes: token?.isCancellationRequested ? new Set<string>() : getRegisteredCustomTypes(workspaceRoot),
    entityTypes: token?.isCancellationRequested ? new Set<string>() : new Set(getRegisteredEntities(workspaceRoot).map(entity => entity.name))
  };
}

// IDE-NAV-013:未知类型的修正候选——只从已注册集合取近拼(大小写归一后
// 编辑距离≤2),按距稳定排序截 5;候选与未知名同名(已注册时)不入选,
// 无近似不猜。不自动创建 types.xml 声明是硬边界(候选只是替换)。
export const TYPE_SUGGESTION_MAX_DISTANCE = 2;
export const TYPE_SUGGESTION_LIMIT = 5;

export function boundedEditDistance(left: string, right: string, max: number): number | null {
  if (Math.abs(left.length - right.length) > max) {
    return null;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      const cost = Math.min(substitution, previous[column] + 1, current[column - 1] + 1);
      current.push(cost);
      rowMin = Math.min(rowMin, cost);
    }
    if (rowMin > max) {
      return null;
    }
    previous = current;
  }
  const distance = previous[right.length];
  return distance > max ? null : distance;
}

export function findRegisteredTypeSuggestions(
  unknownName: string,
  registered: Iterable<string>
): string[] {
  const target = unknownName.toLowerCase();
  const hits: Array<{ name: string; distance: number }> = [];
  for (const candidate of registered) {
    if (candidate === unknownName) {
      continue;
    }
    const distance = boundedEditDistance(target, candidate.toLowerCase(), TYPE_SUGGESTION_MAX_DISTANCE);
    if (distance === null) {
      continue;
    }
    hits.push({ name: candidate, distance });
  }
  hits.sort((left, right) =>
    left.distance - right.distance || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return hits.slice(0, TYPE_SUGGESTION_LIMIT).map(hit => hit.name);
}

export function getKnownTypeSuggestions(document: vscode.TextDocument, token?: vscode.CancellationToken): KnownTypeSuggestion[] {
  const suggestions = new Map<string, KnownTypeSuggestion>();

  for (const type of KBENGINE_TYPES) {
    suggestions.set(type.name, {
      name: type.name,
      detail: type.detail,
      documentation: type.documentation
    });
  }

  const knownTypeContext = getKnownTypeContext(document, token);
  if (token?.isCancellationRequested) return [];
  for (const typeName of [...knownTypeContext.customTypes].sort()) {
    if (!suggestions.has(typeName)) {
      suggestions.set(typeName, {
        name: typeName,
        detail: 'Custom type',
        documentation: '来自 types.xml 的自定义类型。'
      });
    }
  }

  // 别名指向面(alias.xml;PR-012 门 G-C 关闭单):parity 复算面含别名而
  // provider 缺,致 Rust-only 差异;此处补面后 Rust 补全 ⊆ TS 面。
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (workspaceRoot && !token?.isCancellationRequested) {
    for (const [aliasName, aliasType] of [...getRegisteredAliasTypes(workspaceRoot)].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!suggestions.has(aliasName)) {
        suggestions.set(aliasName, {
          name: aliasName,
          detail: aliasType,
          documentation: '来自 alias.xml 的别名指向。'
        });
      }
    }
  }

  for (const entityName of [...knownTypeContext.entityTypes].sort()) {
    if (!suggestions.has(entityName)) {
      suggestions.set(entityName, {
        name: entityName,
        detail: 'Entity type',
        documentation: '来自 entities.xml 的实体类型引用。'
      });
    }
  }

  return [...suggestions.values()];
}

export class PythonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    private engineApiCatalog: EngineApiCatalog | null = null
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    if (token?.isCancellationRequested) return null;
    const version = document.version;
    const result = this.computeCompletionItems(document, position);
    return token?.isCancellationRequested || document.version !== version ? null : result;
  }

  private computeCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);

    // kbe/KBEngine 模块符号补全(批108):`kbe.` / `KBEngine.` 语境下按索引
    // 前缀过滤。仅识别已引入/已使用的模块别名,非模块语境照常走 self 补全。
    const kbeAliases = getKbeAliases(document.getText());
    const kbeContext = getKbeCompletionContext(linePrefix, kbeAliases);
    if (kbeContext) {
      const entries = filterKbeSymbols(kbeContext.partialSymbol);
      return entries.map(entry => {
        const item = new vscode.CompletionItem(
          entry.name,
          entry.kind === 'class' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Function
        );
        item.detail = entry.signature;
        item.documentation = new vscode.MarkdownString(
          kbeCompletionDocumentation(entry, vscode.env.language, getEngineVersion())
        );
        return item;
      });
    }

    const completionContext = getPythonSelfCompletionContext(
      line.text.substring(0, position.character)
    );
    if (!completionContext) {
      return null;
    }

    const mapping = this.entityMappingManager.getMappingForPythonFile(document.fileName);

    if (!mapping) {
      // IDE-NAV-016:索引未就绪的冷查询回可刷新空 CompletionList
      // (isIncomplete=true,编辑器继续输入会重查同前缀),不装作终答 null;
      // 不记录任何 miss——首扫落地后同前缀重查即得成员补全。首扫已完成的
      // 真无归属(非实体 .py)维持 null,不虚报可刷新。
      if (!this.entityMappingManager.isInitialScanComplete()) {
        return new vscode.CompletionList([], true);
      }
      return null;
    }

    const items: vscode.CompletionItem[] = [];
    const partialLower = completionContext.partialSymbol.toLowerCase();
    const seenProperties = new Set<string>();

    if (completionContext.parentPath) {
      const nestedPrefix = `${completionContext.parentPath}.`;
      for (const [propPath, propInfo] of Object.entries(mapping.properties)) {
        if (!propPath.startsWith(nestedPrefix)) {
          continue;
        }

        const remainder = propPath.slice(nestedPrefix.length);
        const nextSegment = remainder.split('.')[0];
        if (!nextSegment) {
          continue;
        }

        if (partialLower && !nextSegment.toLowerCase().startsWith(partialLower)) {
          continue;
        }

        if (seenProperties.has(nextSegment)) {
          continue;
        }
        seenProperties.add(nextSegment);

        const item = new vscode.CompletionItem(nextSegment, vscode.CompletionItemKind.Property);
        item.detail = 'Nested Entity Property';
        item.documentation = new vscode.MarkdownString(
          `定义于: \`${path.basename(propInfo.defFile)}:${propInfo.line}\`\n\n从 .def 文件中的嵌套属性自动推导。`
        );
        items.push(item);
      }

      return items;
    }

    for (const [propName, propInfo] of Object.entries(mapping.properties)) {
      if (propName.includes('.')) {
        continue;
      }

      if (partialLower && !propName.toLowerCase().startsWith(partialLower)) {
        continue;
      }

      const item = new vscode.CompletionItem(propName, vscode.CompletionItemKind.Property);
      item.detail = 'Entity Property';
      item.documentation = new vscode.MarkdownString(
        `定义于: \`${path.basename(propInfo.defFile)}:${propInfo.line}\`\n\n从 .def 文件自动生成的实体属性。`
      );
      items.push(item);
    }

    for (const [methodName, methodDefinitions] of Object.entries(mapping.methods)) {
      if (partialLower && !methodName.toLowerCase().startsWith(partialLower)) {
        continue;
      }

      const primaryDefinition = methodDefinitions[0];
      if (!primaryDefinition) {
        continue;
      }

      const item = new vscode.CompletionItem(methodName, vscode.CompletionItemKind.Method);
      item.detail = primaryDefinition.exposed ? 'Entity Method (Exposed)' : 'Entity Method';
      // def 方法签名随补全出示(审计遗留承诺):declared <Arg> 的形参带类型注解,
      // 与两处 hover 同走 resolveEntityAnnotationType 解析链(用户令 2026-10-21);
      // 未声明 <Arg> 不硬造(只出 self)
      item.documentation = new vscode.MarkdownString(
        `\`${formatDefMethodSignature(getWorkspaceRootForDocument(document) ?? undefined, methodName, primaryDefinition.declaredArgs)}\`\n\n` +
        `定义于: \`${path.basename(primaryDefinition.defFile)}:${primaryDefinition.line}\`\n\n从 .def 文件自动生成的实体方法。`
      );
      items.push(item);
    }

    return items;
  }
}
