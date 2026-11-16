// python 方法调用层次解析决策核(RUST-145 批 1)。CallHierarchy
// incoming/outgoing 的索引查询算法(目标定位→self. 调用点枚举→绑定解析
// (精确文件+名,同名回退)→去重/进程作用域过滤)与索引首扫/未保存
// 文档覆盖共用的方法块解析(parsePythonMethodBlocks,自 entityMappingHelpers
// 迁入)与区块推断(inferMethodSectionFromPythonFile,迁入;语义不变,
// normalizeLookupPath 即 normalizeFileIdentity 的直通别名,此处直用)。
// 纯库零 vscode/fs;manager 面(entityMapping getIncoming/OutgoingPython
// MethodCalls)只做索引获取+取消检查+打开文档清单收集。与 Rust
// python_method_calls.rs golden 对拍同源(tests/kodePythonMethodCallsParity
// .test.ts)。
import { normalizeFileIdentity } from './pathIdentity';
import type { DefMethodSection } from './defParser';

export interface PythonMethodLocationCore {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface PythonSelfCallCore {
  methodName: string;
  line: number;
  character: number;
  filePath: string;
}

export interface IndexedPythonMethodLocationCore extends PythonMethodLocationCore {
  endLine: number;
  calls: PythonSelfCallCore[];
}

export interface PythonMethodCallReferenceCore {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface IncomingPythonMethodCallCore {
  caller: PythonMethodLocationCore;
  callLine: number;
  callCharacter: number;
}

export interface OpenDocumentTextCore {
  fsPath: string;
  content: string;
}

export function inferMethodSectionFromPythonFile(pythonFile: string): DefMethodSection | undefined {
  const normalizedPath = normalizeFileIdentity(pythonFile).toLowerCase();

  // demo 资产目录名(scripts/base|cell|client|bots,官方资产模板形态;引擎
  // baseapp→scripts/base、cellapp→scripts/cell、bots→scripts/bots 装载,
  // bots.cpp:211-228)。此前只认 base/cell/client,demo 资产里实有的
  // scripts/bots 文件全落 undefined——段过滤/作用域推断/调用图分段一并瞎
  // (2026-11-11 用户报障收编)。bots 的脚本面是 client 面(KB-API-007:
  // ClientObjectBase 组装)。引擎进程名(baseapp/cellapp)不是目录名,两层
  // 名不得混称——目录只按资产层认。
  if (normalizedPath.includes('/scripts/bots/') || normalizedPath.includes('/assets/scripts/bots/')
    || normalizedPath.startsWith('bots/') || normalizedPath.includes('/bots/')) {
    return 'ClientMethods';
  }

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

export function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocationCore[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocationCore[] = [];
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
): PythonSelfCallCore[] {
  const calls: PythonSelfCallCore[] = [];
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

/**
 * outgoing:目标方法定位(路径身份归一)→ 逐 self. 调用点绑定解析——
 * 精确(文件+名)优先,同文件无此名回退同名任意文件(现状口径:跨文件
 * 同名是弱信号),dedup 键=归一路径:名:行:列。返回保留 resolved 原始
 * 路径(非归一形)。纯函数,取消检查归 manager 包装面。
 */
export function resolveOutgoingPythonMethodCalls(
  methods: IndexedPythonMethodLocationCore[],
  pythonFile: string,
  methodName: string
): PythonMethodCallReferenceCore[] {
  const targetMethod = methods.find(method =>
    normalizeFileIdentity(method.filePath) === normalizeFileIdentity(pythonFile)
    && method.methodName === methodName
  );
  if (!targetMethod) {
    return [];
  }

  const references: PythonMethodCallReferenceCore[] = [];
  const seen = new Set<string>();
  for (const reference of targetMethod.calls) {
    const binding = methods.find(candidate =>
      normalizeFileIdentity(candidate.filePath) === normalizeFileIdentity(reference.filePath)
      && candidate.methodName === reference.methodName
    );

    const resolved = binding
      || methods.find(candidate => candidate.methodName === reference.methodName);
    if (!resolved) {
      continue;
    }

    const key = `${normalizeFileIdentity(resolved.filePath)}:${resolved.methodName}:${resolved.line}:${resolved.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    references.push({
      filePath: resolved.filePath,
      methodName: resolved.methodName,
      line: resolved.line,
      character: resolved.character
    });
  }

  return references;
}

/**
 * incoming:调用方全量扫描。2026-11-05 用户反馈(def 方法 Shift+F12):
 * 本地调用按方法自身区块/进程作用域收录——baseapp 的 self.x() 不计入
 * cellapp 同名方法引用。KBEngine def 方法不可跨进程,本进程 self.x() 是
 * 本地调用,跨进程是 self.cell/base/client.x()(RPC,另走
 * getIncomingPythonReceiverCalls)。目标区块由实现文件路径推断;调用方区块
 * 已知且不同 → 跨进程伪引用,跳过。调用方区块未知(common/ 等共享脚本,
 * 可被目标进程导入)→ 保守保留;目标区块未知 → 全保留(现状行为)。
 * IDE-NAV-004:未保存文档跟随——openTexts(在位打开文档缓冲区当前版)
 * 覆盖该文件的索引条目后再扫(与索引首扫同一纯函数);仅覆盖已入索引的
 * 文件(未入索引的打开文件不整体增扫,现状口径)。纯函数,openTexts
 * 清单收集与取消检查归 manager 包装面。
 */
export function resolveIncomingPythonMethodCalls(
  methods: IndexedPythonMethodLocationCore[],
  openTexts: OpenDocumentTextCore[],
  pythonFile: string,
  methodName: string
): IncomingPythonMethodCallCore[] {
  const incoming: IncomingPythonMethodCallCore[] = [];
  const normalizedTarget = normalizeFileIdentity(pythonFile);
  const targetSection = inferMethodSectionFromPythonFile(normalizedTarget);

  const methodsByFile = new Map<string, IndexedPythonMethodLocationCore[]>();
  for (const method of methods) {
    const key = normalizeFileIdentity(method.filePath);
    const bucket = methodsByFile.get(key);
    if (bucket) {
      bucket.push(method);
    } else {
      methodsByFile.set(key, [method]);
    }
  }
  for (const openText of openTexts) {
    const key = normalizeFileIdentity(openText.fsPath);
    const bucket = methodsByFile.get(key);
    if (bucket) {
      methodsByFile.set(key, parsePythonMethodBlocks(openText.content, bucket[0].filePath));
    }
  }
  const methodsOverride = [...methodsByFile.values()].flat();

  for (const method of methodsOverride) {
    for (const call of method.calls) {
      if (call.methodName !== methodName) {
        continue;
      }

      const resolved = methodsOverride.find(candidate =>
        candidate.methodName === call.methodName
        && normalizeFileIdentity(candidate.filePath) === normalizedTarget
      );
      if (!resolved) {
        continue;
      }

      // 进程作用域过滤(见上方注释)。调用方文件区块与目标区块都已知且
      // 不同 → 跨进程伪引用(如 base 调 cell 方法),跳过。
      const callerSection = inferMethodSectionFromPythonFile(method.filePath);
      if (targetSection && callerSection && callerSection !== targetSection) {
        continue;
      }

      incoming.push({
        caller: {
          filePath: method.filePath,
          methodName: method.methodName,
          line: method.line,
          character: method.character
        },
        callLine: call.line,
        callCharacter: call.character
      });
    }
  }

  return incoming;
}
