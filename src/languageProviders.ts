import * as path from 'path';
import * as vscode from 'vscode';
import { EntityMappingManager } from './entityMapping';
import {
  findCustomTypeInfo,
  findDefinitionEntryByCategory,
  findDefinitionFileByCategory,
  findCustomTypePythonFile,
  findEntityDefinitionFile,
  getRegisteredCustomTypes,
  getRegisteredEntities,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
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
    diagnosticsCheckDuplicateDefinitions: config.get<boolean>('diagnostics.checkDuplicateDefinitions', true),
    diagnosticsCheckMissingPropertyFields: config.get<boolean>('diagnostics.checkMissingPropertyFields', true),
    hoverShowTagDocs: config.get<boolean>('hover.showTagDocs', true),
    hoverShowValueDocs: config.get<boolean>('hover.showValueDocs', true),
    hoverShowSymbolDocs: config.get<boolean>('hover.showSymbolDocs', true)
  };
}

const TOP_LEVEL_DEF_TAGS = [
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

const PROPERTY_CHILD_TAGS = [
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

const BASE_OR_CELL_METHOD_CHILD_TAGS = ['Arg', 'Utype', 'Exposed'];
const CLIENT_METHOD_CHILD_TAGS = ['Arg', 'Utype'];
const DETAIL_LEVEL_TAGS = ['NEAR', 'MEDIUM', 'FAR'];
const DETAIL_LEVEL_VALUE_TAGS = ['radius', 'hyst'];
const CONTAINER_TYPE_CHILD_TAGS = ['of', 'Properties', 'implementedBy'];

function createCompletionItems(
  labels: string[],
  kind: vscode.CompletionItemKind
): vscode.CompletionItem[] {
  return labels.map(label => new vscode.CompletionItem(label, kind));
}

function getTextBeforePosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const start = new vscode.Position(0, 0);
  return document.getText(new vscode.Range(start, position));
}

function getOpenTagStack(text: string): string[] {
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

function getDefTagCompletionLabels(
  document: vscode.TextDocument,
  position: vscode.Position
): string[] {
  const textBeforeCursor = getTextBeforePosition(document, position);
  const stack = getOpenTagStack(textBeforeCursor);
  const currentTag = stack[stack.length - 1];
  const parentTag = stack[stack.length - 2];
  const trimmedText = textBeforeCursor.trimEnd();

  if ((currentTag === 'Type' || currentTag === 'Arg') && /(ARRAY|TUPLE|FIXED_DICT)\s*<$/i.test(trimmedText)) {
    if (/FIXED_DICT\s*<$/i.test(trimmedText)) {
      return CONTAINER_TYPE_CHILD_TAGS.filter(tag => tag !== 'of');
    }

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

export class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (lineText.match(/<(Type|Arg|of)>\s*\w*$/)) {
      getKnownTypeSuggestions(document).forEach(type => {
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
      return createCompletionItems(
        getDefTagCompletionLabels(document, position),
        vscode.CompletionItemKind.Property
      );
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
    const isDefDocument = document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def');
    const typeValueHover = getTypeValueHover(document, position, word);
    if (typeValueHover) {
      return typeValueHover;
    }

    const customTypeHover = getCustomTypeHover(document, position, word);
    if (customTypeHover) {
      return customTypeHover;
    }

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
      if (hook && !isDefDocument) {
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
      const defPath = findEntityDefinitionFile(word, document);
      if (defPath) {
        return new vscode.Location(vscode.Uri.file(defPath), new vscode.Position(0, 0));
      }
    }

    if (document.fileName.endsWith('types.xml')) {
      const customTypeLocation = findCustomTypeDefinition(document, position, word);
      if (customTypeLocation) {
        return customTypeLocation;
      }

      const typeValueLocation = findTypeValueDefinitionInTypesXml(document, position, word);
      if (typeValueLocation) {
        return typeValueLocation;
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
  | 'Parent'
  | 'Interfaces'
  | 'Components'
  | 'Properties'
  | 'BaseMethods'
  | 'CellMethods'
  | 'ClientMethods'
  | 'Volatile';

interface SectionContext {
  section: KBEngineSectionName;
  symbols: Map<string, vscode.Range>;
}

interface SymbolContext {
  name: string;
  section: KBEngineSectionName;
  range: vscode.Range;
  hasType: boolean;
  hasFlags: boolean;
}

const PROPERTY_SECTIONS = new Set<KBEngineSectionName>(['Properties']);

const METHOD_SECTIONS = new Set<KBEngineSectionName>([
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

const ALLOWED_PROPERTY_CHILDREN = new Set([
  'Type',
  'Flags',
  'Default',
  'Persistent',
  'DetailLevel',
  'Identifier',
  'Index',
  'DatabaseLength',
  'Utype'
]);

const ALLOWED_METHOD_CHILDREN = new Set(['Arg', 'Utype', 'Exposed']);

const ALLOWED_TOP_LEVEL_SECTIONS = new Set<KBEngineSectionName>([
  'Parent',
  'Interfaces',
  'Components',
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods',
  'Volatile'
]);

const TAG_HOVER_DOCS: Record<string, { detail: string; documentation: string }> = {
  root: {
    detail: 'KBEngine 实体定义根节点',
    documentation: '`.def` 文件的根标签。源码会在该节点下读取 `Properties`、方法区块和 `DetailLevels` 等实体定义信息。'
  },
  Properties: {
    detail: '属性区块',
    documentation: '源码通过 `<Properties>` 读取实体属性。区块内通常使用 `<属性名><Type/><Flags/>...</属性名>` 结构。'
  },
  BaseMethods: {
    detail: 'Base 方法区块',
    documentation: '源码通过 `<BaseMethods>` 读取 BaseApp 方法。方法节点内部可包含 `<Arg>`、`<Utype>` 和 `<Exposed>`。'
  },
  CellMethods: {
    detail: 'Cell 方法区块',
    documentation: '源码通过 `<CellMethods>` 读取 CellApp 方法。方法节点内部可包含 `<Arg>`、`<Utype>` 和 `<Exposed>`。'
  },
  ClientMethods: {
    detail: '客户端方法区块',
    documentation: '源码通过 `<ClientMethods>` 读取客户端方法。方法节点内部可包含 `<Arg>` 和 `<Utype>`，不处理 `<Exposed>`。'
  },
  DetailLevels: {
    detail: '细节等级区块',
    documentation: '源码通过 `<DetailLevels>` 读取 `NEAR`、`MEDIUM`、`FAR` 三档同步细节配置，每档都要求同时提供 `<radius>` 和 `<hyst>`。'
  },
  Type: {
    detail: '类型声明标签',
    documentation: '用于声明属性类型、方法参数类型或容器内部元素类型，例如 `UINT32`、`VECTOR3`、`ARRAY<of>UINT8</of>`。'
  },
  Arg: {
    detail: '方法参数标签',
    documentation: '用于声明方法参数类型。只应出现在 `BaseMethods`、`CellMethods`、`ClientMethods` 的方法节点内。'
  },
  Flags: {
    detail: '属性同步/存储标志标签',
    documentation: '用于描述属性的存储位置和同步范围，例如 `BASE`、`CELL_PUBLIC`、`OWN_CLIENT`。'
  },
  Default: {
    detail: '默认值标签',
    documentation: '用于声明属性的默认值。字符串、数字和布尔值都可以在这里配置。'
  },
  Persistent: {
    detail: '持久化标签',
    documentation: '用于声明属性是否持久化到数据库。源码按 `true` 识别为启用。'
  },
  Identifier: {
    detail: '标识字段标签',
    documentation: '用于标记属性是否作为索引键。源码按 `true` 识别为启用。'
  },
  Index: {
    detail: '索引类型标签',
    documentation: '用于声明属性的索引类型，源码会读取并转为大写。'
  },
  DatabaseLength: {
    detail: '数据库长度标签',
    documentation: '用于声明属性在数据库中的长度限制，对应源码中的 `DatabaseLength`。'
  },
  DetailLevel: {
    detail: '细节级别标签',
    documentation: '用于定义属性同步细节等级，可选值为 `NEAR`、`MEDIUM`、`FAR`。'
  },
  of: {
    detail: '容器元素类型标签',
    documentation: '用于 `ARRAY` 或 `TUPLE` 的内部类型声明，源码会读取 `<of>` 子节点作为元素类型。'
  },
  radius: {
    detail: '细节等级半径标签',
    documentation: '用于 `DetailLevels` 的 `NEAR`、`MEDIUM`、`FAR` 节点内，源码会读取其数值作为该档位半径。'
  },
  hyst: {
    detail: '细节等级迟滞标签',
    documentation: '用于 `DetailLevels` 的 `NEAR`、`MEDIUM`、`FAR` 节点内，源码会读取其数值作为该档位迟滞。'
  },
  Utype: {
    detail: '显式 Utype 标签',
    documentation: '用于显式指定属性或方法的 Utype；未提供时由引擎自动分配。'
  },
  Exposed: {
    detail: '暴露方法标签',
    documentation: '用于 Base/Cell 方法，表示该方法允许远端调用。'
  },
  implementedBy: {
    detail: 'FIXED_DICT 实现类标签',
    documentation: '用于给 `FIXED_DICT` 指定实现模块名。源码会直接读取该节点字符串，并尝试加载对应实现。'
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

Object.assign(TAG_HOVER_DOCS, {
  Parent: {
    detail: '父类区块',
    documentation: '对应 KBEngine 的 `loadParentClass`，用于声明当前实体或组件继承的父定义。'
  },
  Interfaces: {
    detail: '接口区块',
    documentation: '对应 KBEngine 的 `loadInterfaces`，用于组合 `entity_defs/interfaces/*.def` 中的接口定义。'
  },
  Components: {
    detail: '组件区块',
    documentation: '对应 KBEngine 的 `loadComponents`，用于声明当前实体挂载的组件属性及其组件定义类型。'
  },
  Interface: {
    detail: '接口引用标签',
    documentation: '在 `<Interfaces>` 下使用，内部通常写成 `<SomeInterface/>`，KBEngine 会到 `entity_defs/interfaces/SomeInterface.def` 加载定义。'
  },
  Volatile: {
    detail: '易变同步区块',
    documentation: '对应 KBEngine 的 `loadVolatileInfo`，用于配置 position、yaw、pitch、roll 等实时同步参数。'
  }
});

function validateScalarTagValues(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  text: string,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const knownTypeContext = getKnownTypeContext(document);
  const knownFlags = new Set(KBENGINE_FLAGS.map(flag => flag.name));
  const knownLevels = new Set(DETAIL_LEVELS);

  const typeRegex = /<Type>\s*([\s\S]*?)\s*<\/Type>/g;
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRegex.exec(text)) !== null) {
    const value = typeMatch[1].trim();
    if (!value || /<[^>]+>/.test(value)) {
      continue;
    }

    const typeCandidateRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let typeCandidateMatch: RegExpExecArray | null;
    while ((typeCandidateMatch = typeCandidateRegex.exec(value)) !== null) {
      const candidate = typeCandidateMatch[0];
      if (knownTypeContext.builtins.has(candidate) || knownTypeContext.entityTypes.has(candidate)) {
        continue;
      }

      if (!featureConfig.diagnosticsCheckUnknownTypes) {
        continue;
      }

      const customTypeResolution = resolveCustomTypeReference(document, candidate, knownTypeContext.customTypes);
      if (customTypeResolution.status === 'resolved' || customTypeResolution.status === 'unverifiable') {
        continue;
      }

      if (customTypeResolution.status === 'missingPythonFile') {
        pushDiagnosticForMatch(
          document,
          diagnosticsList,
          text,
          candidate,
          typeMatch.index,
          `自定义类型 ${candidate} 已在 types.xml 中注册，但未找到对应的 user_type Python 文件，请检查 user_type/${candidate}.py`,
          vscode.DiagnosticSeverity.Warning
        );
        continue;
      }

      if (customTypeResolution.status === 'missingTypeRegistration') {
        pushDiagnosticForMatch(
          document,
          diagnosticsList,
          text,
          candidate,
          typeMatch.index,
          `自定义类型 ${candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用`,
          vscode.DiagnosticSeverity.Error
        );
      }
    }
  }

  const flagsRegex = /<Flags>\s*([\s\S]*?)\s*<\/Flags>/g;
  let flagsMatch: RegExpExecArray | null;
  while ((flagsMatch = flagsRegex.exec(text)) !== null) {
    const rawValue = flagsMatch[1].trim();
    const value = rawValue.toUpperCase();
    if (!value) {
      continue;
    }

    if (featureConfig.diagnosticsCheckUnknownFlags && !knownFlags.has(value)) {
      pushDiagnosticForMatch(
        document,
        diagnosticsList,
        text,
        rawValue,
        flagsMatch.index,
        `未知的 KBEngine Flags 值: ${rawValue}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。`,
        vscode.DiagnosticSeverity.Error
      );
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
          hasType: false,
          hasFlags: false
        });
      }
      continue;
    }

    if (PROPERTY_SECTIONS.has(currentSymbol.section)) {
      if (tagName === 'Type') {
        currentSymbol.hasType = true;
      }
      if (tagName === 'Flags') {
        currentSymbol.hasFlags = true;
      }
      continue;
    }

    if (METHOD_SECTIONS.has(currentSymbol.section)) {
      continue;
    }
  }
}

function finalizeSymbol(
  diagnosticsList: vscode.Diagnostic[],
  symbol: SymbolContext
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (PROPERTY_SECTIONS.has(symbol.section)) {
    if (featureConfig.diagnosticsCheckMissingPropertyFields && !symbol.hasType) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 缺少 <Type> 定义`,
        vscode.DiagnosticSeverity.Error
      ));
    }

    if (featureConfig.diagnosticsCheckMissingPropertyFields && !symbol.hasFlags) {
      diagnosticsList.push(new vscode.Diagnostic(
        symbol.range,
        `属性 ${symbol.name} 缺少 <Flags> 定义`,
        vscode.DiagnosticSeverity.Error
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
    || tagName === 'Interface'
    || tagName === 'interface'
    || tagName === 'implementedBy'
    || ALLOWED_TOP_LEVEL_SECTIONS.has(tagName as KBEngineSectionName)
    || ALLOWED_PROPERTY_CHILDREN.has(tagName)
    || ALLOWED_METHOD_CHILDREN.has(tagName)
    || tagName === 'FIXED_DICT'
    || tagName === 'TUPLE';
}

function getSectionLabel(section: KBEngineSectionName): string {
  if (section === 'Parent') {
    return '????';
  }

  if (section === 'Interfaces') {
    return '????';
  }

  if (section === 'Components') {
    return '????';
  }

  if (section === 'Properties') {
    return '????';
  }

  if (section === 'Volatile') {
    return '??????';
  }

  return '????';
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
      markdown.appendMarkdown(`**DatabaseLength**: \`${symbolInfo.database}\`\n\n`);
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

  return new vscode.Hover(markdown);
}

function getCustomTypeHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeAtPosition(document, position, word);
  if (!customTypeInfo) {
    return null;
  }

  return createCustomTypeHover(customTypeInfo, 'Custom type from `types.xml`');
}

function getTypeValueHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(word, document);
  if (customTypeInfo) {
    return createCustomTypeHover(customTypeInfo, 'Referenced custom type from `types.xml`');
  }

  const componentPath = findDefinitionFileByCategory(word, 'component', document);
  if (componentPath) {
    return createDefinitionReferenceHover(word, 'Component type', componentPath);
  }

  const entityPath = findEntityDefinitionFile(word, document);
  if (entityPath) {
    const entityInfo = getRegisteredEntityInfo(document, word);
    const extraLines = entityInfo
      ? [
          `**Base**: \`${entityInfo.hasBase}\``,
          `**Cell**: \`${entityInfo.hasCell}\``,
          `**Client**: \`${entityInfo.hasClient}\``
        ]
      : [];
    return createDefinitionReferenceHover(word, 'Entity type', entityPath, extraLines);
  }

  return null;
}

function createCustomTypeHover(
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>,
  summary: string
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${customTypeInfo.name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**AliasType**: \`${customTypeInfo.aliasType}\`\n\n`);

  if (customTypeInfo.rawValue && customTypeInfo.rawValue !== customTypeInfo.aliasType) {
    markdown.appendMarkdown(`**Raw**: \`${customTypeInfo.rawValue}\`\n\n`);
  }

  if (customTypeInfo.implementedBy) {
    markdown.appendMarkdown(`**implementedBy**: \`${customTypeInfo.implementedBy}\`\n\n`);
  }

  if (customTypeInfo.pythonFilePath) {
    markdown.appendMarkdown(`**Python**: \`${path.basename(customTypeInfo.pythonFilePath)}\`\n\n`);
  }

  if (customTypeInfo.properties.length > 0) {
    markdown.appendMarkdown('**Properties**:\n');
    for (const property of customTypeInfo.properties) {
      markdown.appendMarkdown(`- \`${property.name}\`: \`${property.typeName || 'UNKNOWN'}\`\n`);
    }
  }

  return new vscode.Hover(markdown);
}

function createDefinitionReferenceHover(
  name: string,
  summary: string,
  filePath: string,
  extraLines: string[] = []
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**Definition**: \`${path.basename(filePath)}\`\n\n`);

  for (const line of extraLines) {
    markdown.appendMarkdown(`${line}\n\n`);
  }

  return new vscode.Hover(markdown);
}

function getRegisteredEntityInfo(
  document: vscode.TextDocument,
  entityName: string
) {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  return getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName) || null;
}

type CustomTypeResolutionStatus =
  | 'resolved'
  | 'missingTypeRegistration'
  | 'missingPythonFile'
  | 'unverifiable';

interface CustomTypeResolution {
  status: CustomTypeResolutionStatus;
}

function resolveCustomTypeReference(
  document: vscode.TextDocument,
  candidate: string,
  registeredCustomTypes?: Set<string>
): CustomTypeResolution {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return { status: 'unverifiable' };
  }

  const customTypes = registeredCustomTypes ?? getRegisteredCustomTypes(workspaceRoot);
  if (!customTypes.size) {
    return { status: 'unverifiable' };
  }

  if (!customTypes.has(candidate)) {
    return { status: 'missingTypeRegistration' };
  }

  const customPythonTypePath = findCustomTypePythonFile(workspaceRoot, candidate);
  if (!customPythonTypePath) {
    return { status: 'missingPythonFile' };
  }

  return { status: 'resolved' };
}

function findEnclosingSymbol(
  text: string,
  offset: number,
  word: string
): SymbolHoverInfo | null {
  const sectionRegex = /<(Properties|BaseMethods|CellMethods|ClientMethods)>([\s\S]*?)<\/\1>/g;
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
  const definitionReference = findDefinitionReferenceInDef(document, position, word);
  return createDefinitionLocation(document, definitionReference);
}

function findTypeValueDefinitionInTypesXml(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  return createDefinitionLocation(document, findTypeValueDefinitionReference(document, word));
}

function findCustomTypeDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeAtPosition(document, position, word);
  if (!customTypeInfo) {
    return null;
  }

  if (isPositionInsideImplementedByValue(document, position)) {
    if (customTypeInfo.pythonFilePath) {
      return new vscode.Location(vscode.Uri.file(customTypeInfo.pythonFilePath), new vscode.Position(0, 0));
    }
    return null;
  }

  if (customTypeInfo.pythonFilePath) {
    return new vscode.Location(vscode.Uri.file(customTypeInfo.pythonFilePath), new vscode.Position(0, 0));
  }

  return new vscode.Location(
    vscode.Uri.file(customTypeInfo.filePath),
    new vscode.Position(customTypeInfo.line - 1, 0)
  );
}

function findCustomTypeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
) {
  if (!document.fileName.endsWith('types.xml')) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(word, document);
  if (!customTypeInfo) {
    return null;
  }

  const offset = document.offsetAt(position);
  if (offset < customTypeInfo.startOffset || offset > customTypeInfo.endOffset) {
    return null;
  }

  return customTypeInfo;
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
    database: extractFirstTagValue(body, 'DatabaseLength'),
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

function isPositionInsideImplementedByValue(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  return isPositionInsideTagValue(document, position, 'implementedBy');
}

function isPositionInsideChildTag(
  document: vscode.TextDocument,
  position: vscode.Position,
  parentTagName: string
): boolean {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const parentRegex = new RegExp(`<${parentTagName}>\\s*([\\s\\S]*?)\\s*<\\/${parentTagName}>`, 'g');
  let parentMatch: RegExpExecArray | null;

  while ((parentMatch = parentRegex.exec(text)) !== null) {
    const innerContent = parentMatch[1];
    const innerContentStart = parentMatch.index + parentMatch[0].indexOf(innerContent);
    const childRegex = /<([A-Za-z_][A-Za-z0-9_]*)\b[^/>]*\/>/g;
    let childMatch: RegExpExecArray | null;

    while ((childMatch = childRegex.exec(innerContent)) !== null) {
      const childStart = innerContentStart + childMatch.index;
      const childEnd = childStart + childMatch[0].length;
      if (offset >= childStart && offset <= childEnd) {
        return true;
      }
    }
  }

  return false;
}

function looksLikeEntityName(word: string): boolean {
  const builtInTypes = new Set(KBENGINE_TYPES.map(type => type.name));
  return !builtInTypes.has(word) && /^[A-Z][A-Za-z0-9_]*$/.test(word);
}

function createDefinitionLocation(
  document: vscode.TextDocument,
  definitionReference: { filePath: string; line?: number } | null
): vscode.Location | null {
  if (!definitionReference) {
    return null;
  }

  if (definitionReference.filePath === document.uri.fsPath && definitionReference.line === undefined) {
    return null;
  }

  return new vscode.Location(
    vscode.Uri.file(definitionReference.filePath),
    new vscode.Position((definitionReference.line || 1) - 1, 0)
  );
}

function findTypeValueDefinitionReference(
  document: vscode.TextDocument,
  word: string
): { filePath: string; line?: number } | null {
  const customTypeEntry = findDefinitionEntryByCategory(word, 'type', document);
  if (customTypeEntry) {
    return { filePath: customTypeEntry.filePath, line: customTypeEntry.line };
  }

  const componentPath = findDefinitionFileByCategory(word, 'component', document);
  if (componentPath) {
    return { filePath: componentPath };
  }

  const entityPath = findEntityDefinitionFile(word, document);
  if (entityPath) {
    return { filePath: entityPath };
  }

  return null;
}

function findDefinitionReferenceInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): { filePath: string; line?: number } | null {
  if (!looksLikeEntityName(word)) {
    return null;
  }

  if (isPositionInsideTagValue(document, position, 'Arg')) {
    const entityPath = findEntityDefinitionFile(word, document);
    if (entityPath) {
      return { filePath: entityPath };
    }
  }

  if (isPositionInsideTagValue(document, position, 'Type')) {
    return findTypeValueDefinitionReference(document, word);
  }

  if (isPositionInsideChildTag(document, position, 'Interfaces')) {
    const interfacePath = findDefinitionFileByCategory(word, 'interface', document);
    if (interfacePath) {
      return { filePath: interfacePath };
    }
  }

  if (isPositionInsideChildTag(document, position, 'Parent')) {
    const siblingPath = findDefinitionSiblingForParent(document, word);
    if (siblingPath) {
      return { filePath: siblingPath };
    }
  }

  return null;
}

function findDefinitionSiblingForParent(
  document: vscode.TextDocument,
  word: string
): string | null {
  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
  if (normalizedPath.includes('/components/')) {
    const componentPath = findDefinitionFileByCategory(word, 'component', document);
    if (componentPath) {
      return componentPath;
    }
  }

  return findEntityDefinitionFile(word, document);
}

interface KnownTypeContext {
  builtins: Set<string>;
  customTypes: Set<string>;
  entityTypes: Set<string>;
}

interface KnownTypeSuggestion {
  name: string;
  detail: string;
  documentation: string;
}

function getKnownTypeContext(document: vscode.TextDocument): KnownTypeContext {
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
    customTypes: getRegisteredCustomTypes(workspaceRoot),
    entityTypes: new Set(getRegisteredEntities(workspaceRoot).map(entity => entity.name))
  };
}

function getKnownTypeSuggestions(document: vscode.TextDocument): KnownTypeSuggestion[] {
  const suggestions = new Map<string, KnownTypeSuggestion>();

  for (const type of KBENGINE_TYPES) {
    suggestions.set(type.name, {
      name: type.name,
      detail: type.detail,
      documentation: type.documentation
    });
  }

  const knownTypeContext = getKnownTypeContext(document);
  for (const typeName of [...knownTypeContext.customTypes].sort()) {
    if (!suggestions.has(typeName)) {
      suggestions.set(typeName, {
        name: typeName,
        detail: 'Custom type',
        documentation: '来自 types.xml 的自定义类型。'
      });
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

