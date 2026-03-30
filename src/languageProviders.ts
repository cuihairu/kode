import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EntityMappingManager } from './entityMapping';
import { HOOK_CATEGORY_NAMES, KBENGINE_HOOKS, getHookByName } from './hooks';
import {
  DETAIL_LEVELS,
  KBENGINE_FLAGS,
  KBENGINE_RELOAD_FUNCTIONS,
  KBENGINE_TYPES
} from './kbengineMetadata';
import {
  getPythonSelfAccessAtPosition,
  getPythonSelfCompletionContext
} from './pythonLanguageUtils';

function getLanguageFeatureConfig() {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    enableDiagnostics: config.get<boolean>('enableDiagnostics', true),
    enableStructureDiagnostics: config.get<boolean>('enableStructureDiagnostics', true),
    diagnosticsCheckUnknownTypes: config.get<boolean>('diagnostics.checkUnknownTypes', true),
    diagnosticsCheckUnknownFlags: config.get<boolean>('diagnostics.checkUnknownFlags', true),
    diagnosticsCheckUnknownDetailLevels: config.get<boolean>('diagnostics.checkUnknownDetailLevels', true),
    diagnosticsCheckFlagConflicts: config.get<boolean>('diagnostics.checkFlagConflicts', true),
    diagnosticsCheckDuplicateDefinitions: config.get<boolean>('diagnostics.checkDuplicateDefinitions', true),
    diagnosticsCheckInvalidChildren: config.get<boolean>('diagnostics.checkInvalidChildren', true),
    diagnosticsCheckMissingPropertyFields: config.get<boolean>('diagnostics.checkMissingPropertyFields', true),
    hoverShowTagDocs: config.get<boolean>('hover.showTagDocs', true),
    hoverShowValueDocs: config.get<boolean>('hover.showValueDocs', true),
    hoverShowSymbolDocs: config.get<boolean>('hover.showSymbolDocs', true)
  };
}

export class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (lineText.match(/<Type>\s*\w*$/)) {
      KBENGINE_TYPES.forEach(type => {
        const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
        item.detail = type.detail;
        item.documentation = new vscode.MarkdownString(type.documentation);
        items.push(item);
      });
      return items;
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
      const tags = [
        'Properties', 'ClientMethods', 'BaseMethods', 'CellMethods',
        'Type', 'Flags', 'Default', 'Database', 'Identifier', 'DetailLevel', 'Arg'
      ];
      tags.forEach(tag => {
        const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Property);
        items.push(item);
      });
      return items;
    }

    if (lineText.match(/<[A-Za-z]+Methods>[\s\S]*<[a-zA-Z]/)) {
      const methodMatch = lineText.match(/<([a-zA-Z]+)>/);
      if (methodMatch) {
        const methodName = methodMatch[1];
        KBENGINE_HOOKS.forEach(hook => {
          if (hook.name.toLowerCase().startsWith(methodName.toLowerCase())) {
            const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
            item.detail = `${HOOK_CATEGORY_NAMES[hook.category]} - ${hook.description}`;
            item.documentation = new vscode.MarkdownString(
              `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}\n\n签名:\n\`\`\`python\n${hook.signature}\n\`\`\``
            );
            items.push(item);
          }
        });
        return items;
      }
    }

    if (lineText.match(/<on[a-zA-Z]*$/)) {
      KBENGINE_HOOKS.forEach(hook => {
        const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
        item.detail = `${HOOK_CATEGORY_NAMES[hook.category]} - ${hook.description}`;
        item.documentation = new vscode.MarkdownString(
          `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}`
        );
        items.push(item);
      });
      return items;
    }

    if (document.fileName.endsWith('.py') || document.fileName.endsWith('.def')) {
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
        if (fn) {
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
}

export class KBEngineHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const featureConfig = getLanguageFeatureConfig();
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    if (featureConfig.hoverShowSymbolDocs) {
      const symbolHover = getSymbolHover(document, position, word);
      if (symbolHover) {
        return symbolHover;
      }
    }

    if (featureConfig.hoverShowTagDocs) {
      const tagDoc = TAG_HOVER_DOCS[word];
      if (tagDoc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown(`${tagDoc.detail}\n\n`);
        markdown.appendMarkdown(tagDoc.documentation);
        return new vscode.Hover(markdown);
      }
    }

    if (featureConfig.hoverShowValueDocs) {
      const type = KBENGINE_TYPES.find(t => t.name === word);
      if (type) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${type.name}**\n\n`);
        markdown.appendMarkdown(`${type.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(type.documentation);
        return new vscode.Hover(markdown);
      }

      if (DETAIL_LEVELS.includes(word)) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown('KBEngine 属性细节级别。\n\n');
        markdown.appendMarkdown('可用于 `<DetailLevel>` 标签，表示属性同步的重要程度。');
        return new vscode.Hover(markdown);
      }

      const flag = KBENGINE_FLAGS.find(f => f.name === word);
      if (flag) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${flag.name}**\n\n`);
        markdown.appendMarkdown(`${flag.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(flag.documentation);
        return new vscode.Hover(markdown);
      }

      const hook = getHookByName(word);
      if (hook) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${hook.name}** - ${HOOK_CATEGORY_NAMES[hook.category]}\n\n`);
        markdown.appendMarkdown(`${hook.description}\n\n`);
        markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
        markdown.appendMarkdown('**函数签名**:\n');
        markdown.appendCodeblock(hook.signature, 'python');
        markdown.appendMarkdown('\n**详细说明**:\n');
        markdown.appendMarkdown(hook.documentation);
        if (hook.sourceLocation) {
          markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
        }
        if (hook.example) {
          markdown.appendMarkdown('\n\n**使用示例**:\n');
          markdown.appendCodeblock(hook.example, 'python');
        }
        return new vscode.Hover(markdown);
      }

      const reloadFunc = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name.endsWith(word) || word === f.name);
      if (reloadFunc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${reloadFunc.name}**\n\n`);
        markdown.appendMarkdown(`${reloadFunc.detail}\n\n`);
        markdown.appendMarkdown(reloadFunc.documentation);
        return new vscode.Hover(markdown);
      }
    }

    return null;
  }
}

interface SymbolHoverInfo {
  name: string;
  section: KBEngineSectionName;
  type?: string;
  flags?: string;
  defaultValue?: string;
  detailLevel?: string;
  database?: string;
  identifier?: string;
  args: string[];
}

export class KBEngineDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location> {
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    if (document.fileName.endsWith('entities.xml')) {
      const defPath = findEntityDefFile(word);
      if (defPath) {
        return new vscode.Location(vscode.Uri.file(defPath), new vscode.Position(0, 0));
      }
    }

    if (document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def')) {
      const location = findEntityDefinitionInDef(document, position, word);
      if (location) {
        return location;
      }
    }

    return null;
  }
}

export function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const diagnosticsList: vscode.Diagnostic[] = [];
  const text = document.getText();

  validateScalarTagValues(document, diagnosticsList, text, featureConfig);
  if (featureConfig.enableStructureDiagnostics) {
    validateDefStructure(document, diagnosticsList, featureConfig);
  }

  diagnostics.set(document.uri, diagnosticsList);
}

type KBEngineSectionName =
  | 'Properties'
  | 'CellProperties'
  | 'ClientProperties'
  | 'BaseMethods'
  | 'CellMethods'
  | 'ClientMethods';

interface SectionContext {
  section: KBEngineSectionName;
  symbols: Map<string, vscode.Range>;
}

interface SymbolContext {
  name: string;
  section: KBEngineSectionName;
  range: vscode.Range;
  typeCount: number;
  flagsCount: number;
  argCount: number;
  nestedTags: string[];
}

const PROPERTY_SECTIONS = new Set<KBEngineSectionName>([
  'Properties',
  'CellProperties',
  'ClientProperties'
]);

const METHOD_SECTIONS = new Set<KBEngineSectionName>([
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

const ALLOWED_PROPERTY_CHILDREN = new Set([
  'Type',
  'Flags',
  'Default',
  'Database',
  'DetailLevel',
  'Identifier'
]);

const ALLOWED_METHOD_CHILDREN = new Set(['Arg']);

const ALLOWED_TOP_LEVEL_SECTIONS = new Set<KBEngineSectionName>([
  'Properties',
  'CellProperties',
  'ClientProperties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

const TAG_HOVER_DOCS: Record<string, { detail: string; documentation: string }> = {
  root: {
    detail: 'KBEngine 实体定义根节点',
    documentation: '`.def` 文件的根标签，所有属性定义、方法定义和容器结构都应放在该节点下。'
  },
  Properties: {
    detail: 'Base 属性区块',
    documentation: '定义实体的 Base 属性。区块内通常使用 `<属性名><Type/><Flags/>...</属性名>` 结构。'
  },
  CellProperties: {
    detail: 'Cell 属性区块',
    documentation: '定义实体的 Cell 属性。常见于空间、位置、AOI 等 CellApp 侧数据。'
  },
  ClientProperties: {
    detail: 'Client 属性区块',
    documentation: '定义客户端相关属性，用于描述直接暴露给客户端的属性集合。'
  },
  BaseMethods: {
    detail: 'Base 方法区块',
    documentation: '定义 BaseApp 可调用的方法。子节点通常为方法名标签，内部包含一个或多个 `<Arg>`。'
  },
  CellMethods: {
    detail: 'Cell 方法区块',
    documentation: '定义 CellApp 可调用的方法。子节点通常为方法名标签，内部包含一个或多个 `<Arg>`。'
  },
  ClientMethods: {
    detail: '客户端方法区块',
    documentation: '定义同步到客户端或供客户端调用的方法。子节点通常为方法名标签，内部包含一个或多个 `<Arg>`。'
  },
  Type: {
    detail: '类型声明标签',
    documentation: '用于声明属性类型、方法参数类型或容器内部元素类型，例如 `UINT32`、`VECTOR3`、`ARRAY<UINT8>`。'
  },
  Arg: {
    detail: '方法参数标签',
    documentation: '用于声明方法参数类型。只应出现在 `BaseMethods`、`CellMethods`、`ClientMethods` 的方法节点内。'
  },
  Flags: {
    detail: '属性同步/存储标志标签',
    documentation: '用于描述属性的存储位置和同步范围，例如 `BASE_CLIENT`、`CELL_PUBLIC`、`OWN_CLIENT`。'
  },
  Default: {
    detail: '默认值标签',
    documentation: '用于声明属性的默认值。字符串、数字和布尔值都可以在这里配置。'
  },
  Database: {
    detail: '数据库长度标签',
    documentation: '通常用于声明数据库存储长度，常见于 `STRING` 等需要长度限制的字段。'
  },
  Identifier: {
    detail: '标识字段标签',
    documentation: '用于标记属性是否参与标识用途。通常应填写数值或布尔约定值。'
  },
  DetailLevel: {
    detail: '细节级别标签',
    documentation: '用于定义属性同步的细节等级，可选值为 `LOW`、`MEDIUM`、`HIGH`、`CRITICAL`。'
  },
  implementedBy: {
    detail: 'FIXED_DICT 实现类标签',
    documentation: '用于给 `FIXED_DICT` 指定实现类，内部通常通过 `<Type>` 指向 Python 类或脚本路径。'
  },
  FIXED_DICT: {
    detail: '固定字典容器',
    documentation: 'KBEngine 容器类型之一，通常配合 `implementedBy` 和内层 `Properties` 使用。'
  },
  TUPLE: {
    detail: '元组容器',
    documentation: 'KBEngine 容器类型之一，内部可以包含多个 `<Type>`，用于定义固定顺序和长度的元素列表。'
  }
};

function validateScalarTagValues(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  text: string,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const knownTypes = new Set(KBENGINE_TYPES.map(type => type.name));
  const knownFlags = new Set(KBENGINE_FLAGS.map(flag => flag.name));
  const knownLevels = new Set(DETAIL_LEVELS);

  const typeRegex = /<Type>\s*([\s\S]*?)\s*<\/Type>/g;
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRegex.exec(text)) !== null) {
    const value = typeMatch[1].trim();
    if (!value || /<[^>]+>/.test(value)) {
      continue;
    }

    const typeCandidateRegex = /\b[A-Z][A-Z0-9_]*\b/g;
    let typeCandidateMatch: RegExpExecArray | null;
    while ((typeCandidateMatch = typeCandidateRegex.exec(value)) !== null) {
      const candidate = typeCandidateMatch[0];
      if (featureConfig.diagnosticsCheckUnknownTypes && !knownTypes.has(candidate)) {
        pushDiagnosticForMatch(
          document,
          diagnosticsList,
          text,
          candidate,
          typeMatch.index,
          `未知的 KBEngine 类型: ${candidate}`,
          vscode.DiagnosticSeverity.Error
        );
      }
    }
  }

  const flagsRegex = /<Flags>\s*([\s\S]*?)\s*<\/Flags>/g;
  let flagsMatch: RegExpExecArray | null;
  while ((flagsMatch = flagsRegex.exec(text)) !== null) {
    const value = flagsMatch[1].trim();
    if (!value) {
      continue;
    }

    const flags = value.split(/[\s|,]+/).filter(Boolean);
    let hasBase = false;
    let hasCell = false;

    for (const flag of flags) {
      if (featureConfig.diagnosticsCheckUnknownFlags && !knownFlags.has(flag)) {
        pushDiagnosticForMatch(
          document,
          diagnosticsList,
          text,
          flag,
          flagsMatch.index,
          `未知的 KBEngine Flags 值: ${flag}`,
          vscode.DiagnosticSeverity.Error
        );
        continue;
      }

      if (knownFlags.has(flag) && (flag === 'BASE' || flag === 'BASE_CLIENT')) {
        hasBase = true;
      }

      if (knownFlags.has(flag) && flag.startsWith('CELL_')) {
        hasCell = true;
      }
    }

    if (featureConfig.diagnosticsCheckFlagConflicts && hasBase && hasCell) {
      const startPos = document.positionAt(flagsMatch.index);
      const endPos = document.positionAt(flagsMatch.index + flagsMatch[0].length);
      diagnosticsList.push(new vscode.Diagnostic(
        new vscode.Range(startPos, endPos),
        'BASE 和 CELL 标志不能同时使用',
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  const detailRegex = /<DetailLevel>\s*([\s\S]*?)\s*<\/DetailLevel>/g;
  let detailMatch: RegExpExecArray | null;
  while ((detailMatch = detailRegex.exec(text)) !== null) {
    const value = detailMatch[1].trim();
    if (featureConfig.diagnosticsCheckUnknownDetailLevels && value && !knownLevels.has(value)) {
      pushDiagnosticForMatch(
        document,
        diagnosticsList,
        text,
        value,
        detailMatch.index,
        `未知的 DetailLevel: ${value}`,
        vscode.DiagnosticSeverity.Error
      );
    }
  }
}

function validateDefStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const sectionStack: SectionContext[] = [];
  const symbolStack: SymbolContext[] = [];
  const tagRegex = /<\/?([A-Za-z_][A-Za-z0-9_]*)\b[^>]*>/g;
  const text = document.getText();
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    const isClosingTag = fullTag.startsWith('</');
    const range = new vscode.Range(
      document.positionAt(match.index),
      document.positionAt(match.index + fullTag.length)
    );

    if (isClosingTag) {
      const currentSymbol = symbolStack[symbolStack.length - 1];
      if (currentSymbol?.nestedTags.length && currentSymbol.nestedTags[currentSymbol.nestedTags.length - 1] === tagName) {
        currentSymbol.nestedTags.pop();
        continue;
      }

      if (currentSymbol?.name === tagName) {
        finalizeSymbol(diagnosticsList, currentSymbol);
        symbolStack.pop();
        continue;
      }

      const currentSection = sectionStack[sectionStack.length - 1];
      if (currentSection?.section === tagName) {
        sectionStack.pop();
      }
      continue;
    }

    if (ALLOWED_TOP_LEVEL_SECTIONS.has(tagName as KBEngineSectionName)) {
      sectionStack.push({
        section: tagName as KBEngineSectionName,
        symbols: new Map<string, vscode.Range>()
      });
      continue;
    }

    const currentSection = sectionStack[sectionStack.length - 1];
    if (!currentSection) {
      continue;
    }

    const currentSymbol = symbolStack[symbolStack.length - 1];
    if (!currentSymbol) {
      if (!isReservedTagName(tagName)) {
        const existing = currentSection.symbols.get(tagName);
        if (featureConfig.diagnosticsCheckDuplicateDefinitions && existing) {
          diagnosticsList.push(new vscode.Diagnostic(
            range,
            `${getSectionLabel(currentSection.section)}中存在重复定义: ${tagName}`,
            vscode.DiagnosticSeverity.Warning
          ));
          diagnosticsList.push(new vscode.Diagnostic(
            existing,
            `${tagName} 在 ${getSectionLabel(currentSection.section)} 中已定义`,
            vscode.DiagnosticSeverity.Information
          ));
        } else {
          currentSection.symbols.set(tagName, range);
        }

        symbolStack.push({
          name: tagName,
          section: currentSection.section,
          range,
          typeCount: 0,
          flagsCount: 0,
          argCount: 0,
          nestedTags: []
        });
      }
      continue;
    }

    if (currentSymbol.nestedTags.length > 0) {
      if (isNestedTrackedTag(tagName)) {
        currentSymbol.nestedTags.push(tagName);
      }
      continue;
    }

    if (PROPERTY_SECTIONS.has(currentSymbol.section)) {
      if (!ALLOWED_PROPERTY_CHILDREN.has(tagName)) {
        if (!featureConfig.diagnosticsCheckInvalidChildren) {
          continue;
        }
        diagnosticsList.push(new vscode.Diagnostic(
          range,
          `属性 ${currentSymbol.name} 中不应出现 <${tagName}>，允许的子标签: ${Array.from(ALLOWED_PROPERTY_CHILDREN).join(', ')}`,
          vscode.DiagnosticSeverity.Warning
        ));
      } else {
        if (tagName === 'Type') {
          currentSymbol.typeCount += 1;
        }
        if (tagName === 'Flags') {
          currentSymbol.flagsCount += 1;
        }
        if (isNestedTrackedTag(tagName)) {
          currentSymbol.nestedTags.push(tagName);
        }
      }
      continue;
    }

    if (METHOD_SECTIONS.has(currentSymbol.section)) {
      if (!ALLOWED_METHOD_CHILDREN.has(tagName)) {
        if (!featureConfig.diagnosticsCheckInvalidChildren) {
          continue;
        }
        diagnosticsList.push(new vscode.Diagnostic(
          range,
          `方法 ${currentSymbol.name} 中只允许 <Arg> 子标签`,
          vscode.DiagnosticSeverity.Warning
        ));
      } else {
        currentSymbol.argCount += 1;
        currentSymbol.nestedTags.push(tagName);
      }
    }
  }
}

function finalizeSymbol(
  diagnosticsList: vscode.Diagnostic[],
  symbol: SymbolContext
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (PROPERTY_SECTIONS.has(symbol.section)) {
    if (featureConfig.diagnosticsCheckMissingPropertyFields && symbol.typeCount === 0) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 缺少 <Type> 定义`,
        vscode.DiagnosticSeverity.Error
      ));
    }

    if (featureConfig.diagnosticsCheckMissingPropertyFields && symbol.flagsCount === 0) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 缺少 <Flags> 定义`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    if (featureConfig.diagnosticsCheckMissingPropertyFields && symbol.typeCount > 1) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 只能定义一个 <Type>`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    if (featureConfig.diagnosticsCheckMissingPropertyFields && symbol.flagsCount > 1) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 只能定义一个 <Flags>`,
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }
}

function pushDiagnosticForMatch(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  text: string,
  value: string,
  startOffset: number,
  message: string,
  severity: vscode.DiagnosticSeverity
): void {
  const offset = text.indexOf(value, startOffset);
  if (offset === -1) {
    return;
  }

  diagnosticsList.push(new vscode.Diagnostic(
    new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + value.length)
    ),
    message,
    severity
  ));
}

function isReservedTagName(tagName: string): boolean {
  return tagName === 'root'
    || tagName === 'implementedBy'
    || ALLOWED_TOP_LEVEL_SECTIONS.has(tagName as KBEngineSectionName)
    || ALLOWED_PROPERTY_CHILDREN.has(tagName)
    || ALLOWED_METHOD_CHILDREN.has(tagName)
    || tagName === 'FIXED_DICT'
    || tagName === 'TUPLE';
}

function isNestedTrackedTag(tagName: string): boolean {
  return isReservedTagName(tagName);
}

function getSectionLabel(section: KBEngineSectionName): string {
  switch (section) {
    case 'Properties':
    case 'CellProperties':
    case 'ClientProperties':
      return '属性区块';
    case 'BaseMethods':
    case 'CellMethods':
    case 'ClientMethods':
      return '方法区块';
  }
}

function getSymbolHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  const offset = document.offsetAt(position);
  const text = document.getText();
  const symbolInfo = findEnclosingSymbol(text, offset, word);
  if (!symbolInfo) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${symbolInfo.name}**\n\n`);
  markdown.appendMarkdown(`${getSectionLabel(symbolInfo.section)}中的自定义定义。\n\n`);

  if (PROPERTY_SECTIONS.has(symbolInfo.section)) {
    if (symbolInfo.type) {
      markdown.appendMarkdown(`**Type**: \`${symbolInfo.type}\`\n\n`);
    }
    if (symbolInfo.flags) {
      markdown.appendMarkdown(`**Flags**: \`${symbolInfo.flags}\`\n\n`);
    }
    if (symbolInfo.defaultValue) {
      markdown.appendMarkdown(`**Default**: \`${symbolInfo.defaultValue}\`\n\n`);
    }
    if (symbolInfo.detailLevel) {
      markdown.appendMarkdown(`**DetailLevel**: \`${symbolInfo.detailLevel}\`\n\n`);
    }
    if (symbolInfo.database) {
      markdown.appendMarkdown(`**Database**: \`${symbolInfo.database}\`\n\n`);
    }
    if (symbolInfo.identifier) {
      markdown.appendMarkdown(`**Identifier**: \`${symbolInfo.identifier}\`\n\n`);
    }
  }

  if (METHOD_SECTIONS.has(symbolInfo.section)) {
    markdown.appendMarkdown(`**参数个数**: ${symbolInfo.args.length}\n\n`);
    if (symbolInfo.args.length > 0) {
      markdown.appendMarkdown(`**Args**: \`${symbolInfo.args.join(', ')}\``);
    }
  }

  const hook = getHookByName(symbolInfo.name);
  if (hook) {
    markdown.appendMarkdown(`\n\n---\n\n**KBEngine Hook**: ${HOOK_CATEGORY_NAMES[hook.category]}\n\n`);
    markdown.appendMarkdown(`${hook.description}\n\n`);
    markdown.appendMarkdown(`**调用时机**: ${hook.timing}\n\n`);
    markdown.appendMarkdown('**函数签名**:\n');
    markdown.appendCodeblock(hook.signature, 'python');
    markdown.appendMarkdown('\n**详细说明**:\n');
    markdown.appendMarkdown(hook.documentation);
    if (hook.sourceLocation) {
      markdown.appendMarkdown(`\n\n**源码位置**: \`${hook.sourceLocation}\``);
    }
    if (hook.example) {
      markdown.appendMarkdown('\n\n**使用示例**:\n');
      markdown.appendCodeblock(hook.example, 'python');
    }
  }

  return new vscode.Hover(markdown);
}

function findEnclosingSymbol(
  text: string,
  offset: number,
  word: string
): SymbolHoverInfo | null {
  const sectionRegex = /<(Properties|CellProperties|ClientProperties|BaseMethods|CellMethods|ClientMethods)>([\s\S]*?)<\/\1>/g;
  let sectionMatch: RegExpExecArray | null;

  while ((sectionMatch = sectionRegex.exec(text)) !== null) {
    const section = sectionMatch[1] as KBEngineSectionName;
    const sectionContent = sectionMatch[2];
    const sectionContentStart = sectionMatch.index + sectionMatch[0].indexOf(sectionContent);
    const symbolRegex = /<([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/g;
    let symbolMatch: RegExpExecArray | null;

    while ((symbolMatch = symbolRegex.exec(sectionContent)) !== null) {
      const name = symbolMatch[1];
      if (name !== word) {
        continue;
      }

      const absoluteStart = sectionContentStart + symbolMatch.index;
      const absoluteEnd = absoluteStart + symbolMatch[0].length;
      if (offset < absoluteStart || offset > absoluteEnd) {
        continue;
      }

      return buildSymbolHoverInfo(section, name, symbolMatch[2]);
    }
  }

  return null;
}

function findEntityDefinitionInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (!looksLikeEntityName(word)) {
    return null;
  }

  if (!isPositionInsideTagValue(document, position, 'Type')
    && !isPositionInsideTagValue(document, position, 'Arg')) {
    return null;
  }

  const defPath = findEntityDefFile(word);
  if (!defPath || defPath === document.uri.fsPath) {
    return null;
  }

  return new vscode.Location(vscode.Uri.file(defPath), new vscode.Position(0, 0));
}

function buildSymbolHoverInfo(
  section: KBEngineSectionName,
  name: string,
  body: string
): SymbolHoverInfo {
  return {
    name,
    section,
    type: extractFirstTagValue(body, 'Type'),
    flags: extractFirstTagValue(body, 'Flags'),
    defaultValue: extractFirstTagValue(body, 'Default'),
    detailLevel: extractFirstTagValue(body, 'DetailLevel'),
    database: extractFirstTagValue(body, 'Database'),
    identifier: extractFirstTagValue(body, 'Identifier'),
    args: extractAllTagValues(body, 'Arg')
  };
}

function extractFirstTagValue(text: string, tagName: string): string | undefined {
  const match = text.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function extractAllTagValues(text: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'g');
  const values: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const value = match[1].trim();
    if (value) {
      values.push(value);
    }
  }

  return values;
}

function isPositionInsideTagValue(
  document: vscode.TextDocument,
  position: vscode.Position,
  tagName: string
): boolean {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    const innerValue = match[1];
    const innerStart = match.index + fullMatch.indexOf(innerValue);
    const innerEnd = innerStart + innerValue.length;
    if (offset >= innerStart && offset <= innerEnd) {
      return true;
    }
  }

  return false;
}

function looksLikeEntityName(word: string): boolean {
  const builtInTypes = new Set(KBENGINE_TYPES.map(type => type.name));
  return !builtInTypes.has(word) && /^[A-Z][A-Za-z0-9_]*$/.test(word);
}

export class PythonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location | vscode.Location[]> {
    const line = document.lineAt(position.line);
    const access = getPythonSelfAccessAtPosition(line.text, position.character);
    if (!access) {
      return null;
    }

    const entityName = path.basename(document.fileName, '.py');
    const mapping = this.entityMappingManager.getMapping(entityName);
    if (mapping) {
      if (mapping.properties[access.fullPath]) {
        const location = mapping.properties[access.fullPath];
        return new vscode.Location(
          vscode.Uri.file(location.defFile),
          new vscode.Position(location.line - 1, 0)
        );
      }

      if (mapping.properties[access.rootSymbol]) {
        const location = mapping.properties[access.rootSymbol];
        return new vscode.Location(
          vscode.Uri.file(location.defFile),
          new vscode.Position(location.line - 1, 0)
        );
      }

      if (mapping.methods[access.rootSymbol]) {
        const location = mapping.methods[access.rootSymbol];
        return new vscode.Location(
          vscode.Uri.file(location.defFile),
          new vscode.Position(location.line - 1, 0)
        );
      }
    }

    return null;
  }
}

export class PythonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const completionContext = getPythonSelfCompletionContext(
      line.text.substring(0, position.character)
    );
    if (!completionContext) {
      return null;
    }

    const entityName = path.basename(document.fileName, '.py');
    const mapping = this.entityMappingManager.getMapping(entityName);

    if (!mapping) {
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

    for (const [methodName, methodInfo] of Object.entries(mapping.methods)) {
      if (partialLower && !methodName.toLowerCase().startsWith(partialLower)) {
        continue;
      }

      const item = new vscode.CompletionItem(methodName, vscode.CompletionItemKind.Method);
      item.detail = 'Entity Method';
      item.documentation = new vscode.MarkdownString(
        `定义于: \`${path.basename(methodInfo.defFile)}:${methodInfo.line}\`\n\n从 .def 文件自动生成的实体方法。`
      );
      items.push(item);
    }

    return items;
  }
}

function findEntityDefFile(entityName: string): string | null {
  if (!vscode.workspace.workspaceFolders) {
    return null;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const possiblePaths = [
    path.join(workspaceRoot, 'scripts/entity_defs', `${entityName}.def`),
    path.join(workspaceRoot, '**/entity_defs', `${entityName}.def`),
    path.join(workspaceRoot, '**', `${entityName}.def`)
  ];

  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      return possiblePath;
    }
  }

  return null;
}
