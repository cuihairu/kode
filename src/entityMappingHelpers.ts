// SRC-002(阶段 1):entityMapping.ts 尾部独立解析/身份辅助函数
// (2988..3296)迁出。纯移动:区域原文零改动,manager 上方对私有辅助的引用
// 经本模块导入回注,公开导出在 entityMapping.ts 经 re-export 保持既有导入
// 路径不变(消费者零改动)。区域自包含(无 manager 引用),仅依赖 vscode
// 运行时与若干类型导入。
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { readFileSyncUtf8Recorded } from './backend/fileReadMetrics';
import type {
  DefinitionSymbolIdentity,
  IndexedMethodDefinition,
  IndexedPythonMethodLocation,
  PythonOwnerFile
} from './entityMapping';
import type { DefMethodSection as EntityMethodSection } from './backend/defParser';
import { buildPythonSymbolsInRust } from './backend/pythonCallGraphRust';
import type { PythonSymbolCall, PythonSymbolsRustResult } from './backend/pythonCallGraphRust';
import type { DefinitionSemanticCategory } from './backend/definitionSemantics';
import { normalizeLookupPath } from './backend/definitionSemantics';
import { joinWorkspacePath } from './backend/workspacePath';
import { readSharedFileSnapshot } from './sharedFileSnapshot';

function buildFallbackPythonPath(entityName: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`);
}

/**
 * 接收者段过滤(用户令 2026-10-21):self.cell./self.base./self.client. 调用的
 * 候选闸——receiverSection 在场时只留段相符的 def 声明(段不符一律剔除,不是
 * 降权),过滤发生在形参闸与打分之前;无前缀(section 缺省)原样通过。
 */
export function filterMethodDefinitionsBySection<
  T extends { section: EntityMethodSection }
>(
  definitions: readonly T[],
  receiverSection?: EntityMethodSection
): T[] {
  return receiverSection
    ? definitions.filter(item => item.section === receiverSection)
    : [...definitions];
}

export function buildMethodOwnerBindingKey(identity: {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

export function sameIdentity(left: DefinitionSymbolIdentity, right: DefinitionSymbolIdentity): boolean {
  return left.ownerKind === right.ownerKind
    && left.ownerName === right.ownerName
    && left.sourceKind === right.sourceKind
    && left.section === right.section
    && left.symbolName === right.symbolName
    && left.componentSlotName === right.componentSlotName
    && normalizePropertyLookupPath(left.propertyPath || '') === normalizePropertyLookupPath(right.propertyPath || '')
    && left.sourceChain.join('::').toLowerCase() === right.sourceChain.join('::').toLowerCase();
}

function inferOwnerNameFromPythonFile(pythonFile: string): string {
  return path.basename(pythonFile, '.py');
}

export function inferOwnerKindFromPythonFile(
  pythonFile: string
): DefinitionSemanticCategory | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile).toLowerCase();
  if (normalizedPath.includes('/components/')) {
    return 'component';
  }
  if (normalizedPath.includes('/interfaces/')) {
    return 'interface';
  }
  if (normalizedPath.endsWith('.py')) {
    return 'entity';
  }
  return undefined;
}

export function inferMethodSectionFromPythonFile(pythonFile: string): EntityMethodSection | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile).toLowerCase();

  // 进程名目录形态(scripts/{baseapp,cellapp,bots};用户工程在用):此前只认
  // demo 资产目录形态(scripts/{base,cell,client}),baseapp/cellapp 文件全落
  // undefined——段过滤/作用域推断/调用图分段一并瞎(2026-11-11 用户报障根因)。
  // 两层名是两回事:demo 资产按脚本域命名(base/cell/client,引擎 baseapp→
  // scripts/base、cellapp→scripts/cell 装载),baseapp/cellapp 是引擎进程名;
  // bots 两层同名,脚本面是 client 面(KB-API-007:ClientObjectBase 组装)。
  if (normalizedPath.includes('/scripts/baseapp/') || normalizedPath.includes('/assets/scripts/baseapp/')
    || normalizedPath.startsWith('baseapp/') || normalizedPath.includes('/baseapp/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cellapp/') || normalizedPath.includes('/assets/scripts/cellapp/')
    || normalizedPath.startsWith('cellapp/') || normalizedPath.includes('/cellapp/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/bots/') || normalizedPath.includes('/assets/scripts/bots/')
    || normalizedPath.startsWith('bots/') || normalizedPath.includes('/bots/')) {
    return 'ClientMethods';
  }

  // demo 资产目录名(scripts/base|cell|client,官方资产模板形态)
  if (normalizedPath.includes('/scripts/base/') || normalizedPath.includes('/assets/scripts/base/')
    || normalizedPath.startsWith('base/') || normalizedPath.includes('/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/') || normalizedPath.includes('/assets/scripts/cell/')
    || normalizedPath.startsWith('cell/') || normalizedPath.includes('/cell/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/client/') || normalizedPath.includes('/assets/scripts/client/')
    || normalizedPath.startsWith('client/') || normalizedPath.includes('/client/')) {
    return 'ClientMethods';
  }

  return undefined;
}

export function uniqueFilePaths(candidatePaths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidatePath of candidatePaths) {
    const normalized = normalizeLookupPath(candidatePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidatePath);
  }
  return unique;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * C-19 诊断面缓冲区感知判存:readSharedFileSnapshot 打开缓冲区优先,未打开
 * 回磁盘;命中 `def <name>(`(可选 async)即视为已实现。与 findPythonMethodLine
 * 同 regex 形态(逐行匹配,不越行),供 collectDefMethodImplementationGaps
 * 在索引判存落空后兜底——覆盖「CodeAction 已生成但未保存」的即时消除。
 */
function hasMethodImplementationInSnapshot(filePath: string, methodName: string): boolean {
  const snapshot = readSharedFileSnapshot(filePath);
  if (!snapshot) {
    return false;
  }
  const regex = new RegExp(
    `^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodName)})\\s*\\(`,
    'm'
  );
  return regex.test(snapshot.content);
}

export function getLineNumber(text: string, index: number): number {
  return text.substring(0, index).split('\n').length;
}

export function getColumnNumber(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1);
  return index - (lineStart + 1);
}

function normalizePropertyLookupPath(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * C-20:Rust 符号表 → C-19 方法定位(IndexedPythonMethodLocation)。
 *
 * 口径对齐(与 parsePythonMethodBlocks 逐字段一致,tests/pythonSymbolsParity
 * 锁死):
 * - Rust line/character 是 def 语句起点(装饰器行/def 关键字列),TS 口径是
 *   def 行(1-based)与方法名列——故 line/character/endLine 从原文按 TS 同
 *   一算法派生(def 块从 Rust 提示行起扫,装饰器形态天然对齐;endLine 为缩
 *   进边界扫描,含 TS 的「跳过空行到下一条语句」语义)。
 * - 调用点行号 Rust 0-based → +1;列 Rust 为调用式起点(self 列),TS 口径
 *   为 self. 后方法名列 → +『self.』宽。`self(...)`(无方法名链)TS 正则
 *   本就不记,过滤对齐。
 * - 模块级函数无 calls(Rust 只按 (类,方法) 归集),空数组对齐。
 */
export function rustSymbolsToIndexedMethodLocations(
  files: Array<{ path: string; text: string }>,
  symbols: PythonSymbolsRustResult
): IndexedPythonMethodLocation[] {
  const symbolsByPath = new Map(symbols.map(file => [file.filePath, file]));
  const methods: IndexedPythonMethodLocation[] = [];

  for (const file of files) {
    const fileSymbols = symbolsByPath.get(file.path);
    if (!fileSymbols) {
      continue;
    }
    const sourceLines = file.text.split('\n');
    const defs: Array<{ name: string; hintLine: number; calls: PythonSymbolCall[] }> = [
      ...fileSymbols.functions.map(fn => ({ name: fn.name, hintLine: fn.line, calls: [] as PythonSymbolCall[] })),
      ...fileSymbols.classes.flatMap(cls =>
        cls.methods.map(method => ({ name: method.name, hintLine: method.line, calls: method.calls }))
      )
    ];
    for (const def of defs) {
      const located = locatePythonDefBlock(sourceLines, def.name, def.hintLine);
      if (!located) {
        continue;
      }
      methods.push({
        filePath: file.path,
        methodName: def.name,
        line: located.line,
        character: located.character,
        endLine: located.endLine,
        calls: def.calls
          .filter(call => call.methodName !== 'self')
          .map(call => ({
            methodName: call.methodName,
            line: call.line + 1,
            character: call.character + 'self.'.length,
            filePath: file.path
          }))
      });
    }
  }

  return methods;
}

/**
 * 在原文行集内定位 `def name` 块,返回 TS 口径的 1-based line / 方法名列 /
 * 缩进边界 endLine(算法与 parsePythonMethodBlocks 逐字相同)。hintLine 为
 * Rust 报的 def 语句起点(0-based,装饰器形态早于 def 行)——从它起扫而非
 * 全文扫,同名方法多块时各归其位。
 */
function locatePythonDefBlock(
  sourceLines: string[],
  methodName: string,
  hintLine: number
): { line: number; character: number; endLine: number } | null {
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = Math.max(hintLine, 0); index < sourceLines.length; index += 1) {
    const match = definitionRegex.exec(sourceLines[index]);
    if (!match || match[2] !== methodName) {
      continue;
    }
    const indent = match[1].length;
    let endLine = sourceLines.length;
    for (let nextLine = index + 1; nextLine < sourceLines.length; nextLine += 1) {
      const nextText = sourceLines[nextLine];
      if (!nextText.trim()) {
        continue;
      }
      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }
    return {
      line: index + 1,
      character: sourceLines[index].indexOf(methodName),
      endLine
    };
  }

  return null;
}

export function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocation[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocation[] = [];
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const match = definitionRegex.exec(lineText);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const methodName = match[2];
    const character = lineText.indexOf(methodName);
    let endLine = lines.length;

    for (let nextLine = index + 1; nextLine < lines.length; nextLine += 1) {
      const nextText = lines[nextLine];
      if (!nextText.trim()) {
        continue;
      }

      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }

    const bodyLines = lines.slice(index + 1, endLine);
    methods.push({
      filePath: pythonFile,
      methodName,
      line: index + 1,
      character,
      endLine,
      calls: parsePythonSelfCalls(bodyLines, index + 2, pythonFile)
    });
  }

  return methods;
}

function parsePythonSelfCalls(
  bodyLines: string[],
  startLine: number,
  pythonFile: string
): Array<{ methodName: string; line: number; character: number; filePath: string }> {
  const calls: Array<{ methodName: string; line: number; character: number; filePath: string }> = [];
  const callRegex = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const lineText = bodyLines[index];
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(lineText)) !== null) {
      calls.push({
        methodName: match[1],
        line: startLine + index,
        // match[0] 恒以 'self.' 开头,名字紧跟前缀(批86 M7 同类:indexOf(name)
        // 在 name 为 'self' 子串时命中前缀内部,self.e/self.self 列错位)
        character: match.index + 'self.'.length,
        filePath: pythonFile
      });
    }
  }

  return calls;
}
export { buildFallbackPythonPath, inferOwnerNameFromPythonFile, hasMethodImplementationInSnapshot, normalizePropertyLookupPath };

// ---------------------------------------------------------------------------
// SRC-002(阶段 2):Python 方法索引构建协作者——manager 上
// collectPythonMethods/bindPythonMethods 迁出(方法体原文零改动,仅去一级类缩进;
// 二者无 this 引用:索引构建=纯输入输出,Rust 符号表主路径+TS 正则回退+属主绑
// 定),manager 经导入回注调用。索引态(hits 缓存/失效流程)仍归 manager,
// 按分析留待后续。
// ---------------------------------------------------------------------------

export async function collectPythonMethods(ownerFiles: PythonOwnerFile[]): Promise<IndexedPythonMethodLocation[]> {
  const readableFiles: Array<{ path: string; text: string }> = [];
  for (const ownerFile of ownerFiles) {
    if (!fs.existsSync(ownerFile.filePath)) {
      continue;
    }
    readableFiles.push({ path: ownerFile.filePath, text: readFileSyncUtf8Recorded(ownerFile.filePath) });
  }

  // C-20:Rust 符号表主路径(AST 权威——方法枚举与自身调用点不含注释/字符串
  // 误报);Rust 不可用(无门/失败/形状不合规)回退 TS 正则自建,行为不变。
  if (readableFiles.length > 0) {
    const rustSymbols = await buildPythonSymbolsInRust(readableFiles);
    if (rustSymbols) {
      return rustSymbolsToIndexedMethodLocations(readableFiles, rustSymbols);
    }
  }

  const methods: IndexedPythonMethodLocation[] = [];
  for (const file of readableFiles) {
    for (const method of parsePythonMethodBlocks(file.text, file.path)) {
      methods.push({
        ...method
      });
    }
  }

  return methods;
}

export function bindPythonMethods(
  methodDefinitions: IndexedMethodDefinition[],
  pythonMethods: IndexedPythonMethodLocation[]
): void {
  const byOwner = new Map<string, IndexedMethodDefinition[]>();
  for (const definition of methodDefinitions) {
    const key = buildMethodOwnerBindingKey(definition.identity);
    const list = byOwner.get(key) || [];
    list.push(definition);
    byOwner.set(key, list);
  }

  for (const method of pythonMethods) {
    const ownerBindingKeys = [
      buildMethodOwnerBindingKey({
        ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'entity',
        ownerName: inferOwnerNameFromPythonFile(method.filePath),
        section: inferMethodSectionFromPythonFile(method.filePath),
        symbolName: method.methodName
      }),
      buildMethodOwnerBindingKey({
        ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'interface',
        ownerName: inferOwnerNameFromPythonFile(method.filePath),
        section: inferMethodSectionFromPythonFile(method.filePath),
        symbolName: method.methodName
      }),
      buildMethodOwnerBindingKey({
        ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'component',
        ownerName: inferOwnerNameFromPythonFile(method.filePath),
        section: inferMethodSectionFromPythonFile(method.filePath),
        symbolName: method.methodName
      })
    ];

    const boundDefinition = ownerBindingKeys
      .map(key => byOwner.get(key)?.[0])
      .find((candidate): candidate is IndexedMethodDefinition => !!candidate);

    if (!boundDefinition) {
      continue;
    }

    method.binding = {
      identity: boundDefinition.identity,
      pythonFile: method.filePath
    };
  }
}
