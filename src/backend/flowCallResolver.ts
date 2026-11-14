/**
 * KFLOW 本地函数调用解析(FLOW-004,G2 静态调用路径的解析核)。
 *
 * 验收:解析直接函数、self 方法、导入和可证明接收者;输出真实调用点及
 * 声明,不以方法名全局匹配。产出 = flowGraphModel 节点/边(FLOW-003 协议);
 * 展开与工作区聚合归 FLOW-005,跨进程落点实现归 FLOW-007/008(本核只把
 * 角色化发送边立起来,落点声明如实留空)。
 *
 * 解析口径(每条都有 FLOW-001 失败样本背书):
 *   - 直接函数:文件内顶层 def 或 `from M import f` 绑定;resolve 回调缺位
 *     时导入函数如实降级 third-party-function,不猜;
 *   - self 方法:**按封闭类方法表解析**(同类同名不跨类——不以方法名全局
 *     匹配);类表缺名=missing-declaration;
 *   - 角色化接收:self.<role>.<name> / 动态实体引用 .<role>.<name>——九面
 *     表合法性闸(base 面无 .base 等,face-invalid-receiver),发送边带语法
 *     锚,落点声明留空给 FLOW-007;
 *   - 可证明接收者:封闭方法内赋值链(构造调用→类名、别名有界跟随、
 *     KBEngine.entities.get → 引擎实体引用);推不出=unknown-receiver;
 *   - 词法掩码(globalDataIndexCore.buildPythonCodeMask)剔注释/字符串伪调用;
 *   - 多行调用在**开括号行**记录调用点(诚实标注);
 *   - 内建函数(native)如实 unresolved,不造帧;
 *   - 每条边的 caller 是真实调用帧节点(封闭方法/模块函数/模块伪节点)——
 *     调用者向上查询(FLOW-005)依赖 caller 身份,不用占位 id。
 */

import { buildPythonCodeMask } from './globalDataIndexCore';
import {
  PYTHON_RECEIVER_FACES,
  type PythonCallerFace
} from './pythonLanguageUtils';
import {
  flowGraphEdge,
  flowGraphNode,
  type FlowEdgeCondition,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowProcessRole,
  type FlowUnresolvedReason,
  type FlowUnresolvedReasonCode
} from './flowGraphModel';

/** 单文件解析入参。 */
export interface FlowCallResolverInput {
  text: string;
  filePath: string;
  rootKey: string;
  /** 调用面(九面闸依据);缺省按 scripts/<base|cell|client>/ 目录推导 */
  callerFace?: PythonCallerFace;
  /** 跨文件导入解析:模块名+函数名 → 声明位置;缺位=null(如实降级) */
  resolveImportedFunction?: (
    module: string,
    name: string
  ) => { filePath: string; line: number } | null;
}

export interface FlowCallResolverResult {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

interface MethodEntry {
  name: string;
  line: number;
  character: number;
  indent: number;
  endLine: number;
  signature: string;
}

interface ClassEntry {
  name: string;
  line: number;
  indent: number;
  methods: Map<string, MethodEntry>;
}

interface ModuleFnEntry {
  name: string;
  line: number;
  character: number;
  signature: string;
}

const ROLE_KEYWORDS = new Set(['base', 'cell', 'client']);

const FACE_TO_ROLE: Record<'base' | 'cell' | 'client', FlowProcessRole> = {
  base: 'base',
  cell: 'cell',
  client: 'client'
};

const ROLE_KEYWORD_TO_ROLE: Record<string, FlowProcessRole> = {
  base: 'base',
  cell: 'cell',
  client: 'client'
};

/** Python 内建(抽样覆盖常见面;命中=native-function 如实未解析)。 */
const BUILTIN_NAMES = new Set([
  'abs', 'all', 'any', 'bool', 'dict', 'dir', 'enumerate', 'filter', 'float',
  'format', 'getattr', 'hasattr', 'id', 'int', 'isinstance', 'issubclass',
  'len', 'list', 'map', 'max', 'min', 'object', 'open', 'print', 'range',
  'repr', 'round', 'set', 'setattr', 'sorted', 'str', 'sum', 'super', 'tuple',
  'type', 'zip'
]);

const DEF_PATTERN = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const CLASS_PATTERN = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
const FROM_IMPORT_PATTERN =
  /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/;
const IMPORT_MODULE_PATTERN = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/;
const ASSIGN_PATTERN = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
/** 点链调用:`a.b.c(` —链=除末段外的全部段,末段=callee */
const DOTTED_CALL_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const BARE_CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
/** 引擎实体引用形态(KBEngine.entities.get) */
const ENGINE_REF_PATTERN = /entities\s*\.\s*get\s*\(/;
/** 控制流/语句关键字(裸名扫描排除) */
const KEYWORD_NAMES = new Set([
  'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'return', 'yield',
  'with', 'try', 'except', 'finally', 'raise', 'assert', 'lambda', 'and',
  'or', 'not', 'in', 'is', 'del', 'global', 'nonlocal', 'pass', 'break',
  'continue', 'import', 'from', 'as', 'print'
]);

/** 文件路径 → 调用面(scripts/<dir>/ 布局;推不出=null)。 */
export function callerFaceFromFilePath(filePath: string): PythonCallerFace | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const marker = normalized.indexOf('/scripts/');
  if (marker < 0) {
    return null;
  }
  const rest = normalized.slice(marker + '/scripts/'.length);
  if (rest.startsWith('base/')) {
    return 'base';
  }
  if (rest.startsWith('cell/')) {
    return 'cell';
  }
  if (rest.startsWith('client/') || rest.startsWith('bots/')) {
    return 'client';
  }
  return null;
}

function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { lines, starts };
}

/** 块结束行(下一个缩进 ≤ 自身缩进的非空行;文件尾=len)。 */
function blockEndLine(lines: string[], startLine: number, indent: number): number {
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const lineText = lines[index];
    if (!lineText.trim()) {
      continue;
    }
    const lineIndent = lineText.match(/^\s*/)?.[0].length ?? 0;
    if (lineIndent <= indent) {
      return index;
    }
  }
  return lines.length;
}

function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

/** Pass 1:类/模块函数/导入表扫描(缩进域;注释/字符串行按掩码跳过)。 */
function scanStructure(
  lines: string[],
  starts: number[],
  mask: Uint8Array
): {
  classes: ClassEntry[];
  moduleFunctions: ModuleFnEntry[];
  imports: Map<string, { module: string }>;
} {
  const classes: ClassEntry[] = [];
  const moduleFunctions: ModuleFnEntry[] = [];
  const imports = new Map<string, { module: string }>();

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const lineStart = starts[index];
    const indent = lineText.match(/^\s*/)?.[0].length ?? 0;

    const fromMatch = FROM_IMPORT_PATTERN.exec(lineText);
    if (fromMatch && spanIsCode(mask, lineStart, lineText.length)) {
      for (const piece of fromMatch[2].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          imports.set(name, { module: fromMatch[1] });
        }
      }
      continue;
    }
    const importMatch = IMPORT_MODULE_PATTERN.exec(lineText);
    if (importMatch && spanIsCode(mask, lineStart, lineText.length)) {
      imports.set(importMatch[1].split('.')[0], { module: importMatch[1] });
      continue;
    }

    if (!spanIsCode(mask, lineStart, lineText.length)) {
      continue;
    }

    const classMatch = CLASS_PATTERN.exec(lineText);
    if (classMatch && indent === 0) {
      classes.push({
        name: classMatch[2],
        line: index,
        indent,
        methods: new Map()
      });
      continue;
    }

    const defMatch = DEF_PATTERN.exec(lineText);
    if (!defMatch) {
      continue;
    }
    const nameText = defMatch[2];
    const defTokenIndex = lineText.indexOf(`def ${nameText}`);
    const character = defTokenIndex >= 0
      ? defTokenIndex + 'def '.length
      : indent;
    const entry: MethodEntry = {
      name: nameText,
      line: index,
      character,
      indent,
      endLine: blockEndLine(lines, index, indent),
      signature: lineText.trim()
    };
    if (indent === 0) {
      moduleFunctions.push({
        name: nameText,
        line: index,
        character: entry.character,
        signature: entry.signature
      });
      continue;
    }
    // 类体方法:归属最近的、缩进更小的已开放类
    const ownerClass = [...classes]
      .reverse()
      .find(candidate => candidate.indent < indent && candidate.line < index);
    if (ownerClass && !ownerClass.methods.has(nameText)) {
      ownerClass.methods.set(nameText, entry);
    }
  }
  return { classes, moduleFunctions, imports };
}

interface EnclosingFrame {
  kind: 'class-method' | 'module-function';
  className: string | null;
  methodName: string;
  signature: string;
  startLine: number;
  endLine: number;
}

/** 封闭方法帧查找(最小区间包含该行)。 */
function enclosingFrameAt(
  classes: ClassEntry[],
  moduleFunctions: ModuleFnEntry[],
  lines: string[],
  line: number
): EnclosingFrame | null {
  let best: EnclosingFrame | null = null;
  const consider = (candidate: EnclosingFrame | null) => {
    if (candidate && (!best || candidate.endLine - candidate.startLine < best.endLine - best.startLine)) {
      best = candidate;
    }
  };
  for (const klass of classes) {
    for (const method of klass.methods.values()) {
      if (line > method.line && line < method.endLine) {
        consider({
          kind: 'class-method',
          className: klass.name,
          methodName: method.name,
          signature: method.signature,
          startLine: method.line,
          endLine: method.endLine
        });
      }
    }
  }
  for (const fn of moduleFunctions) {
    const end = blockEndLine(lines, fn.line, 0);
    if (line > fn.line && line < end) {
      consider({
        kind: 'module-function',
        className: null,
        methodName: fn.name,
        signature: fn.signature,
        startLine: fn.line,
        endLine: end
      });
    }
  }
  return best;
}

/**
 * 分支条件候选(FLOW-005 验收「分支条件」的解析面):调用点向上找最近一处
 * 缩进更小的 if/elif 头行;else 分支语义不展开(elif 链取反非简单 not),
 * 如实标 other。候选标记——不是执行顺序。
 */
function branchConditionAt(
  lines: string[],
  frame: EnclosingFrame | null,
  callLine: number
): FlowEdgeCondition | null {
  if (!frame) {
    return null;
  }
  const callIndent = lines[callLine].match(/^\s*/)?.[0].length ?? 0;
  let elseIndent: number | null = null;
  for (let line = callLine - 1; line > frame.startLine; line -= 1) {
    const text = lines[line];
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    if (indent >= callIndent) {
      continue;
    }
    const header = /^\s*(?:if|elif)\s+(.+):/.exec(text);
    if (header) {
      const expr = header[1].trim().slice(0, 80);
      if (elseIndent !== null && elseIndent === indent) {
        return { text: `else(否分支,语义未展开): ${expr}`, kind: 'other' };
      }
      return { text: expr, kind: 'if-branch' };
    }
    if (/^\s*else\s*:/.test(text)) {
      elseIndent = indent;
    }
  }
  return null;
}

type VarBinding =
  | { kind: 'class'; className: string }
  | { kind: 'engine-ref' }
  | { kind: 'alias'; name: string };

/** 封闭方法内赋值链扫描(调用行之前)。 */
function collectBindings(
  lines: string[],
  starts: number[],
  mask: Uint8Array,
  frame: EnclosingFrame,
  beforeLine: number
): Map<string, VarBinding> {
  const bindings = new Map<string, VarBinding>();
  for (let index = frame.startLine + 1; index < Math.min(beforeLine, frame.endLine); index += 1) {
    const lineText = lines[index];
    const lineStart = starts[index];
    if (!spanIsCode(mask, lineStart, lineText.length)) {
      continue;
    }
    const match = ASSIGN_PATTERN.exec(lineText);
    if (!match) {
      continue;
    }
    const rhs = match[3].trim();
    const ctor = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(rhs);
    if (ctor && !BUILTIN_NAMES.has(ctor[1])) {
      bindings.set(match[2], { kind: 'class', className: ctor[1] });
      continue;
    }
    if (ENGINE_REF_PATTERN.test(rhs)) {
      bindings.set(match[2], { kind: 'engine-ref' });
      continue;
    }
    const alias = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(rhs);
    if (alias && alias[1] !== match[2]) {
      bindings.set(match[2], { kind: 'alias', name: alias[1] });
    }
  }
  return bindings;
}

function resolveAlias(
  bindings: Map<string, VarBinding>,
  name: string
): VarBinding | null {
  let current: VarBinding | null = bindings.get(name) ?? null;
  for (let hops = 0; current && current.kind === 'alias' && hops < 5; hops += 1) {
    current = bindings.get(current.name) ?? null;
  }
  return current;
}

export function resolveFlowCallSites(
  input: FlowCallResolverInput
): FlowCallResolverResult {
  const { text, filePath, rootKey } = input;
  const mask = buildPythonCodeMask(text);
  const { lines, starts } = splitLines(text);
  const face = input.callerFace ?? callerFaceFromFilePath(filePath);
  const callerRole: FlowProcessRole = face ? FACE_TO_ROLE[face] : 'unknown';
  const { classes, moduleFunctions, imports } = scanStructure(lines, starts, mask);

  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];
  const nodeByKey = new Map<string, FlowGraphNode>();
  const pushNode = (node: FlowGraphNode): string => {
    if (!nodeByKey.has(node.id)) {
      nodeByKey.set(node.id, node);
      nodes.push(node);
    }
    return node.id;
  };

  /** caller 帧节点(封闭方法/模块函数/模块伪节点),按帧缓存。 */
  const callerNodeCache = new Map<string, string>();
  const callerNodeFor = (frame: EnclosingFrame | null): string => {
    if (!frame) {
      const node = flowGraphNode({
        rootKey,
        role: callerRole,
        kind: 'function',
        label: '模块顶层'
      });
      return pushNode(node);
    }
    const cacheKey = `${frame.kind}\u001f${frame.className ?? ''}\u001f${frame.methodName}\u001f${frame.startLine}`;
    const cached = callerNodeCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const node = flowGraphNode({
      rootKey,
      role: callerRole,
      kind: 'function',
      entity: frame.className ? { name: frame.className, defFile: filePath } : null,
      fn: {
        name: frame.methodName,
        filePath,
        signature: frame.signature
      },
      declaration: {
        file: filePath,
        line: frame.startLine,
        character: 0
      },
      label: `候选帧 ${frame.className ? `${frame.className}.` : ''}${frame.methodName}`
    });
    const id = pushNode(node);
    callerNodeCache.set(cacheKey, id);
    return id;
  };

  const functionNodeFor = (args: {
    name: string;
    declFile: string;
    declLine: number;
    declCharacter: number;
    signature: string;
    role: FlowProcessRole;
    className: string | null;
  }): string => pushNode(flowGraphNode({
    rootKey,
    role: args.role,
    kind: 'function',
    entity: args.className ? { name: args.className, defFile: args.declFile } : null,
    fn: {
      name: args.name,
      filePath: args.declFile,
      signature: args.signature
    },
    declaration: {
      file: args.declFile,
      line: args.declLine,
      character: args.declCharacter
    },
    label: `候选帧 ${args.className ? `${args.className}.` : ''}${args.name}`
  }));

  const unresolvedNodeFor = (args: {
    code: FlowUnresolvedReasonCode;
    detail: string;
    role: FlowProcessRole;
    nameHint: string;
  }): string => pushNode(flowGraphNode({
    rootKey,
    role: args.role,
    kind: 'unresolved',
    unresolvedCode: args.code,
    unresolvedDetail: args.detail,
    label: `未解析:${args.nameHint}(${args.code})`
  }));

  // RPC 声明节点:fn 带 pending-def 标记文件(实现 def 文件归 FLOW-007 接线)
  // ——fn 进节点身份,不同 callee 不合并成同一个声明节点。
  const rpcDeclarationNodeFor = (role: FlowProcessRole, nameHint: string): string =>
    pushNode(flowGraphNode({
      rootKey,
      role,
      kind: 'rpc-declaration',
      fn: {
        name: nameHint,
        filePath: `pending-def:${role}`,
        signature: ''
      },
      label: `RPC 声明:${nameHint}(${role})`
    }));

  const unresolved = (
    code: FlowUnresolvedReasonCode,
    detail: string
  ): FlowUnresolvedReason => ({ code, detail });

  const handleSite = (args: {
    line: number;
    character: number;
    chain: string[];
    callee: string;
    frame: EnclosingFrame | null;
  }): void => {
    const callSite = {
      file: filePath,
      line: args.line,
      character: args.character
    };
    const callerId = callerNodeFor(args.frame);
    const frame = args.frame;
    const condition = branchConditionAt(lines, frame, args.line);
    const frameClass = frame?.className ?? null;
    const calleeRef = [...args.chain, args.callee].join('.');
    const syntaxEvidence = {
      type: 'syntax-anchor' as const,
      detail: calleeRef
    };
    const localDirection = {
      fromRole: callerRole,
      toRole: callerRole,
      kind: 'downstream-call' as const
    };

    // ① self.<name>( —封闭类方法表(不全局同名匹配)
    if (args.chain.length === 1 && args.chain[0] === 'self') {
      if (!frame || frame.kind !== 'class-method' || !frameClass) {
        const target = unresolvedNodeFor({
          code: 'unknown-receiver',
          detail: 'self 调用不在可判定的方法体作用域内',
          role: callerRole,
          nameHint: `self.${args.callee}`
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: localDirection,
          syncAsync: 'unknown',
          messageKind: 'unresolved',
          evidence: syntaxEvidence,
          unresolvedReason: unresolved('unknown-receiver', 'self 调用不在方法体作用域内')
        }));
        return;
      }
      const klass = classes.find(candidate => candidate.name === frameClass);
      const method = klass?.methods.get(args.callee);
      if (method) {
        const target = functionNodeFor({
          name: method.name,
          declFile: filePath,
          declLine: method.line,
          declCharacter: method.character,
          signature: method.signature,
          role: callerRole,
          className: frameClass
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: localDirection,
          syncAsync: 'sync',
          messageKind: 'local-call',
          evidence: syntaxEvidence
        }));
      } else {
        const target = unresolvedNodeFor({
          code: 'missing-declaration',
          detail: `类 ${frameClass} 方法表无 ${args.callee}(动态附加属性不在静态面)`,
          role: callerRole,
          nameHint: `self.${args.callee}`
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: localDirection,
          syncAsync: 'unknown',
          messageKind: 'unresolved',
          evidence: syntaxEvidence,
          unresolvedReason: unresolved(
            'missing-declaration',
            `类 ${frameClass} 无方法 ${args.callee}`
          )
        }));
      }
      return;
    }

    // ② self.<role>.<name>( —九面闸 + 角色化发送边
    if (
      args.chain.length === 2 &&
      args.chain[0] === 'self' &&
      ROLE_KEYWORDS.has(args.chain[1])
    ) {
      const roleKeyword = args.chain[1];
      const toRole = ROLE_KEYWORD_TO_ROLE[roleKeyword];
      const crossDirection = {
        fromRole: callerRole,
        toRole,
        kind: 'cross-process' as const
      };
      const faceValid = face
        ? PYTHON_RECEIVER_FACES[face][roleKeyword as 'base' | 'cell' | 'client'] !== null
        : true;
      if (!faceValid) {
        const target = unresolvedNodeFor({
          code: 'face-invalid-receiver',
          detail: `${face} 面实体无 .${roleKeyword} 属性(引擎九面表;运行期必 AttributeError)`,
          role: toRole,
          nameHint: `self.${roleKeyword}.${args.callee}`
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: crossDirection,
          syncAsync: 'unknown',
          messageKind: 'unresolved',
          evidence: syntaxEvidence,
          unresolvedReason: unresolved(
            'face-invalid-receiver',
            `${face} 面无 .${roleKeyword} 属性`
          )
        }));
        return;
      }
      const target = rpcDeclarationNodeFor(toRole, args.callee);
      edges.push(flowGraphEdge({
        fromNodeId: callerId,
        toNodeId: target,
        condition,
        callSite,
        direction: crossDirection,
        syncAsync: 'async-send',
        messageKind: 'rpc',
        evidence: syntaxEvidence
      }));
      return;
    }

    // ③ 点链(非 self):可证明接收者 / 引擎实体引用角色发送 / 未知
    if (args.chain.length >= 1) {
      // 引擎 API 调用(KBEngine.entities.get 等):native 面,不进静态树
      // (其赋值结果的**使用**才建模,见 engine-ref 分支)
      if (args.chain[0] === 'KBEngine' || args.chain[0] === 'BigWorld') {
        const target = unresolvedNodeFor({
          code: 'native-function',
          detail: `引擎 API ${calleeRef}():native 面,静态调用树不建模`,
          role: callerRole,
          nameHint: calleeRef
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: localDirection,
          syncAsync: 'unknown',
          messageKind: 'unresolved',
          evidence: syntaxEvidence,
          unresolvedReason: unresolved('native-function', `引擎 API ${calleeRef}`)
        }));
        return;
      }
      const bindings = frame
        ? collectBindings(lines, starts, mask, frame, args.line)
        : new Map<string, VarBinding>();
      const head = resolveAlias(bindings, args.chain[0]);

      // 引擎实体引用 + 角色访问器:<ref>.cell.halt() —发送边,落点实体未知
      if (
        head?.kind === 'engine-ref' &&
        args.chain.length === 2 &&
        ROLE_KEYWORDS.has(args.chain[1])
      ) {
        const roleKeyword = args.chain[1];
        const toRole = ROLE_KEYWORD_TO_ROLE[roleKeyword];
        const target = rpcDeclarationNodeFor(toRole, args.callee);
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: { fromRole: callerRole, toRole, kind: 'cross-process' },
          syncAsync: 'async-send',
          messageKind: 'rpc',
          evidence: syntaxEvidence,
          unresolvedReason: unresolved(
            'unknown-receiver',
            '实体引用来自 KBEngine.entities.get(运行期实体);发送边已证,落点实体未知'
          )
        }));
        return;
      }

      // 可证明类接收者:封闭类方法表解析(本文件内),不全局同名匹配
      if (head?.kind === 'class') {
        const klass = classes.find(candidate => candidate.name === head.className);
        const method = klass?.methods.get(args.callee);
        if (method) {
          const target = functionNodeFor({
            name: method.name,
            declFile: filePath,
            declLine: method.line,
            declCharacter: method.character,
            signature: method.signature,
            role: callerRole,
            className: head.className
          });
          edges.push(flowGraphEdge({
            fromNodeId: callerId,
            toNodeId: target,
            condition,
            callSite,
            direction: localDirection,
            syncAsync: 'sync',
            messageKind: 'local-call',
            evidence: syntaxEvidence
          }));
        } else {
          const target = unresolvedNodeFor({
            code: 'missing-declaration',
            detail: `类 ${head.className} 方法表无 ${args.callee}`,
            role: callerRole,
            nameHint: calleeRef
          });
          edges.push(flowGraphEdge({
            fromNodeId: callerId,
            toNodeId: target,
            condition,
            callSite,
            direction: localDirection,
            syncAsync: 'unknown',
            messageKind: 'unresolved',
            evidence: syntaxEvidence,
            unresolvedReason: unresolved(
              'missing-declaration',
              `类 ${head.className} 无方法 ${args.callee}`
            )
          }));
        }
        return;
      }

      // 推不出接收者(含点链中段):如实未解析,不猜唯一落点
      const target = unresolvedNodeFor({
        code: 'unknown-receiver',
        detail: `接收者 ${args.chain.join('.')} 类型不可静态证明(赋值链无构造/别名/引擎引用形态)`,
        role: callerRole,
        nameHint: calleeRef
      });
      edges.push(flowGraphEdge({
        fromNodeId: callerId,
        toNodeId: target,
        condition,
        callSite,
        direction: localDirection,
        syncAsync: 'unknown',
        messageKind: 'unresolved',
        evidence: syntaxEvidence,
        unresolvedReason: unresolved(
          'unknown-receiver',
          `接收者 ${args.chain.join('.')} 不可证明`
        )
      }));
      return;
    }

    // ④ 裸名:文件内顶层函数 / 导入绑定 / 内建 / 第三方
    const moduleFn = moduleFunctions.find(candidate => candidate.name === args.callee);
    if (moduleFn) {
      const target = functionNodeFor({
        name: moduleFn.name,
        declFile: filePath,
        declLine: moduleFn.line,
        declCharacter: moduleFn.character,
        signature: moduleFn.signature,
        role: callerRole,
        className: null
      });
      edges.push(flowGraphEdge({
        fromNodeId: callerId,
        toNodeId: target,
        condition,
        callSite,
        direction: localDirection,
        syncAsync: 'sync',
        messageKind: 'local-call',
        evidence: syntaxEvidence
      }));
      return;
    }
    const imported = imports.get(args.callee);
    if (imported) {
      const resolvedImport = input.resolveImportedFunction
        ? input.resolveImportedFunction(imported.module, args.callee)
        : null;
      if (resolvedImport) {
        const target = functionNodeFor({
          name: args.callee,
          declFile: resolvedImport.filePath,
          declLine: resolvedImport.line,
          declCharacter: 0,
          signature: `from ${imported.module} import ${args.callee}`,
          role: callerRole,
          className: null
        });
        edges.push(flowGraphEdge({
          fromNodeId: callerId,
          toNodeId: target,
          condition,
          callSite,
          direction: localDirection,
          syncAsync: 'sync',
          messageKind: 'local-call',
          evidence: syntaxEvidence
        }));
        return;
      }
      const target = unresolvedNodeFor({
        code: 'third-party-function',
        detail: `从 ${imported.module} 导入的 ${args.callee}:无跨文件解析回调,不猜实现位置`,
        role: callerRole,
        nameHint: args.callee
      });
      edges.push(flowGraphEdge({
        fromNodeId: callerId,
        toNodeId: target,
        condition,
        callSite,
        direction: localDirection,
        syncAsync: 'sync',
        messageKind: 'unresolved',
        evidence: syntaxEvidence,
        unresolvedReason: unresolved(
          'third-party-function',
          `导入函数 ${imported.module}.${args.callee} 无解析回调`
        )
      }));
      return;
    }
    if (BUILTIN_NAMES.has(args.callee)) {
      const target = unresolvedNodeFor({
        code: 'native-function',
        detail: `内建 ${args.callee}():native 帧,静态调用树不建模`,
        role: callerRole,
        nameHint: args.callee
      });
      edges.push(flowGraphEdge({
        fromNodeId: callerId,
        toNodeId: target,
        condition,
        callSite,
        direction: localDirection,
        syncAsync: 'unknown',
        messageKind: 'unresolved',
        evidence: syntaxEvidence,
        unresolvedReason: unresolved('native-function', `内建 ${args.callee}`)
      }));
      return;
    }
    const target = unresolvedNodeFor({
      code: 'third-party-function',
      detail: `裸名 ${args.callee}:文件内无 def、无导入绑定,不猜`,
      role: callerRole,
      nameHint: args.callee
    });
    edges.push(flowGraphEdge({
      fromNodeId: callerId,
      toNodeId: target,
      condition,
      callSite,
      direction: localDirection,
      syncAsync: 'unknown',
      messageKind: 'unresolved',
      evidence: syntaxEvidence,
      unresolvedReason: unresolved('third-party-function', `裸名 ${args.callee} 无绑定`)
    }));
  };

  // Pass 2:逐行扫描调用点(掩码代码域;点链优先于裸名,避免双计)
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const lineStart = starts[index];
    // def/class 头行不是调用点(`def main():` 的 'main(' / `class B(Base):`
    // 的 'Base(' 都是声明语法,不产边——否则全文件每个 def 都有幻影自环)
    if (/^\s*(?:async\s+)?def\s+[A-Za-z_]/.test(lineText) || /^\s*class\s+[A-Za-z_]/.test(lineText)) {
      continue;
    }
    const frame = enclosingFrameAt(classes, moduleFunctions, lines, index);

    const dottedRegex = new RegExp(DOTTED_CALL_PATTERN.source, 'g');
    let dottedMatch: RegExpExecArray | null;
    const dottedSpans: Array<[number, number]> = [];
    while ((dottedMatch = dottedRegex.exec(lineText)) !== null) {
      if (!spanIsCode(mask, lineStart + dottedMatch.index, dottedMatch[0].length)) {
        continue;
      }
      dottedSpans.push([
        dottedMatch.index,
        dottedMatch.index + dottedMatch[0].length
      ]);
      // callee 列 = 链段结束(含点)之后——对 `halt (` 尾随空白稳健
      const calleeCharacter = dottedMatch.index + dottedMatch[1].length + 1;
      handleSite({
        line: index,
        character: calleeCharacter,
        chain: dottedMatch[1].split('.'),
        callee: dottedMatch[2],
        frame
      });
    }

    const bareRegex = new RegExp(BARE_CALL_PATTERN.source, 'g');
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareRegex.exec(lineText)) !== null) {
      const spanStart = bareMatch.index;
      if (dottedSpans.some(([from, to]) => spanStart >= from && spanStart < to)) {
        continue;
      }
      if (KEYWORD_NAMES.has(bareMatch[1])) {
        continue;
      }
      if (!spanIsCode(mask, lineStart + spanStart, bareMatch[0].length)) {
        continue;
      }
      handleSite({
        line: index,
        // \b 零宽断言:裸名起点即 match 起点
        character: spanStart,
        chain: [],
        callee: bareMatch[1],
        frame
      });
    }
  }

  return { nodes, edges };
}
