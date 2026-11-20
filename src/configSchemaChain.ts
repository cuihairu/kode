/**
 * CFG-HOVER-FIX-002 配置数据成员链类型直读(纯核,零 IO):
 * `Config.MOBILES[0].hp` 悬停 hp / `TABLE['k'].hp` 悬停键名 → 顺
 * ConfigSchemaEntry 的直读 typeText 走链解析成员类型。类型全部来自
 * collectConfigSchema 的字面量直读(非推断):binding typeText=字面量推断,
 * class typeText=`字段: 类型` 逗点连接;本模块只做代数行走,不新造类型。
 *
 * 根解析两形态:①条目名直配(binding/class);②模块根——链首标识符是
 * 配置目录里的模块名(file basename),`.attr` 步=该模块内同名条目
 * (excel 生成物 `Config.MOBILES` 形态)。
 */

export interface MemberChainStep {
  kind: 'attr' | 'subscript';
  /** attr 步:属性名 */
  name?: string;
  /** subscript 步:字面量键原文(去引号后,静态可知时) */
  key?: string;
}

export interface MemberChainQuery {
  root: string;
  steps: MemberChainStep[];
  /** 悬停目标:链尾 attr,或 dict 字符串键(excel 生成物下标直读) */
  target: { kind: 'attr'; name: string } | { kind: 'dict-key'; key: string };
}

export interface MemberChainResolution {
  /** 目标成员的直读类型文本;class 引用形态为 `Name(字段…)` */
  typeText: string;
  /** 根条目(定义位置展示用) */
  rootName: string;
  rootFile: string;
  rootLine: number;
}

/** 入参依赖面(测试与 provider 共用;entry 形状见 ConfigSchemaEntry) */
export interface ChainSchemaEntry {
  name: string;
  kind: 'class' | 'binding';
  typeText: string;
  file: string;
  line: number;
}

/** 类型形状:顶层括号感知拆分(嵌套 list[dict[…]] 保形);方括号泛型形态
 * (与 inferLiteralType 的 typeText 同源:`dict[str, int]`/`list[T]`/`set[T]`) */
export function parseTypeShape(typeText: string):
  | { shape: 'dict'; key: string; value: string }
  | { shape: 'list'; elem: string }
  | { shape: 'set'; elem: string }
  | { shape: 'name'; name: string }
  | { shape: 'scalar' } {
  const text = typeText.trim();
  const lt = text.indexOf('[');
  if (lt < 0 || !text.endsWith(']')) {
    return /^[A-Za-z_]\w*$/.test(text) ? { shape: 'name', name: text } : { shape: 'scalar' };
  }
  const head = text.slice(0, lt).trim();
  const inner = text.slice(lt + 1, -1);
  const topComma = findTopLevelComma(inner);
  if (head === 'dict' && topComma >= 0) {
    return { shape: 'dict', key: inner.slice(0, topComma).trim(), value: inner.slice(topComma + 1).trim() };
  }
  if (head === 'list') {
    return { shape: 'list', elem: inner.trim() };
  }
  if (head === 'set') {
    return { shape: 'set', elem: inner.trim() };
  }
  return { shape: 'scalar' };
}

function findTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '<' || c === '[' || c === '(') {
      depth += 1;
    } else if (c === '>' || c === ']' || c === ')') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** class 条目 typeText(`hp: int, name: str`)→ 字段名→类型表 */
export function parseClassFieldTypes(typeText: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = typeText.split(',');
  for (const part of parts) {
    const m = /^\s*([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

const basenameOf = (file: string): string => {
  const segs = file.split('/');
  const last = segs[segs.length - 1];
  return last.endsWith('.py') ? last.slice(0, -3) : last;
};

/** dict/list/set 常用方法名:attr 直读面不参与(excel 生成物属性风格访问
 * 会撞 `.get` 等方法名,防假命中) */
const CONTAINER_METHOD_NAMES = new Set([
  'get', 'keys', 'values', 'items', 'pop', 'popitem', 'setdefault', 'update',
  'copy', 'clear', 'fromkeys', 'append', 'extend', 'insert', 'remove', 'sort',
  'reverse', 'index', 'count', 'add', 'discard', 'union', 'difference',
  'intersection', 'symmetric_difference'
]);

interface ClassNode {
  kind: 'class';
  entry: ChainSchemaEntry;
}
interface TypeNode {
  kind: 'type';
  typeText: string;
}
type ChainNode = ClassNode | TypeNode;

/** 从行前缀提取成员链查询;不构成链(悬停处无 `.`/`['` 前缀)返回 null */
export function extractMemberChainQuery(
  line: string,
  wordStart: number,
  word: string
): MemberChainQuery | null {
  const before = line.slice(0, wordStart);
  // 目标形态一:链尾 attr——前缀止于 `.`
  const attrMatch = /([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*|\s*\[[^\][]*\])*)\s*\.\s*$/.exec(before);
  // 目标形态二:dict 字符串键——前缀止于 `['` 或 `["`
  const keyMatch = /([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*|\s*\[[^\][]*\])*)\s*\[\s*['"]$/.exec(before);
  const match = attrMatch ?? keyMatch;
  if (!match) {
    return null;
  }
  // 链首必须是独立标识符(前一个字符不得是词字符/`.`/`]`——那说明匹配到的
  // 不是真正的根,如 `a.b.hp` 应根=a 而非中段;正则左最匹配已保证,这里只
  // 拒绝前缀紧贴的形态如 `x_config.` 中匹配起点落在标识符中段)
  const prev = before[match.index - 1];
  if (prev && /[\w.$]/.test(prev)) {
    return null;
  }
  const steps = parseStepText(match[2] ?? '');
  if (keyMatch && !attrMatch) {
    return { root: match[1], steps, target: { kind: 'dict-key', key: word } };
  }
  return { root: match[1], steps, target: { kind: 'attr', name: word } };
}

function parseStepText(text: string): MemberChainStep[] {
  const steps: MemberChainStep[] = [];
  const re = /\s*\.\s*([A-Za-z_]\w*)|\s*\[([^\][]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      steps.push({ kind: 'attr', name: m[1] });
    } else {
      const raw = m[2].trim();
      const key = /^['"](.*)['"]$/.exec(raw)?.[1];
      steps.push(key !== undefined ? { kind: 'subscript', key } : { kind: 'subscript' });
    }
  }
  return steps;
}

/**
 * 走链解析目标成员类型。命中返回直读 typeText 与根条目位置;任一步
 * 落空(未知成员/方法名/形状不支持)返回 null——provider 面零产出,
 * 不与其他 hover 面抢位。
 */
export function resolveConfigMemberChain(
  query: MemberChainQuery,
  entries: readonly ChainSchemaEntry[]
): MemberChainResolution | null {
  let node = resolveRootNode(query.root, entries);
  if (!node) {
    return null;
  }
  const rootEntry = node.kind === 'class' ? node.entry : rootBindingEntry(query.root, entries);
  if (!rootEntry) {
    return null;
  }
  const path: string[] = [query.root];
  for (const step of query.steps) {
    const next = walkStep(node, step, entries, path);
    if (!next) {
      return null;
    }
    node = next;
  }
  const typeText = resolveTarget(node, query.target, entries, path);
  if (typeText === null) {
    return null;
  }
  return { typeText, rootName: rootEntry.name, rootFile: rootEntry.file, rootLine: rootEntry.line };
}

function resolveRootNode(root: string, entries: readonly ChainSchemaEntry[]): ChainNode | null {
  const byName = entries.find(e => e.name === root);
  if (byName) {
    return byName.kind === 'class' ? { kind: 'class', entry: byName } : { kind: 'type', typeText: byName.typeText };
  }
  // 模块根:链首=配置目录模块名(file basename),零步直接 target 由
  // resolveTarget 处理(attr 目标在模块上=取该模块内同名条目)
  return { kind: 'type', typeText: `#module:${root}` };
}

function rootBindingEntry(root: string, entries: readonly ChainSchemaEntry[]): ChainSchemaEntry | null {
  return entries.find(e => e.name === root) ?? moduleProxyEntry(root, entries, '');
}

function moduleProxyEntry(root: string, entries: readonly ChainSchemaEntry[], attr: string): ChainSchemaEntry | null {
  const inModule = entries.filter(e => basenameOf(e.file) === root);
  if (inModule.length === 0) {
    return null;
  }
  if (attr) {
    return inModule.find(e => e.name === attr) ?? null;
  }
  // 模块根本身:展示位取该模块首个条目(定义文件指引)
  return inModule[0];
}

function walkStep(
  node: ChainNode,
  step: MemberChainStep,
  entries: readonly ChainSchemaEntry[],
  path: string[]
): ChainNode | null {
  if (step.kind === 'subscript') {
    path.push(`[${step.key ?? ''}]`);
    if (node.kind === 'class') {
      return null;
    }
    const shape = parseTypeShape(node.typeText);
    if (shape.shape === 'list') {
      return { kind: 'type', typeText: shape.elem };
    }
    if (shape.shape === 'dict') {
      return { kind: 'type', typeText: shape.value };
    }
    return null;
  }
  // attr 步
  path.push(`.${step.name}`);
  if (node.kind === 'class') {
    const fieldType = parseClassFieldTypes(node.entry.typeText).get(step.name!);
    if (fieldType === undefined) {
      return null;
    }
    const asClass = entries.find(e => e.kind === 'class' && e.name === fieldType);
    return asClass ? { kind: 'class', entry: asClass } : { kind: 'type', typeText: fieldType };
  }
  const text = node.typeText;
  if (text.startsWith('#module:')) {
    // 模块.attr=该模块内同名条目
    const mod = text.slice('#module:'.length);
    const attrEntry = moduleProxyEntry(mod, entries, step.name!);
    if (!attrEntry) {
      return null;
    }
    return attrEntry.kind === 'class'
      ? { kind: 'class', entry: attrEntry }
      : { kind: 'type', typeText: attrEntry.typeText };
  }
  const shape = parseTypeShape(text);
  if (shape.shape === 'name') {
    const asClass = entries.find(e => e.kind === 'class' && e.name === shape.name);
    if (asClass) {
      const fieldType = parseClassFieldTypes(asClass.typeText).get(step.name!);
      if (fieldType === undefined) {
        return null;
      }
      return { kind: 'type', typeText: fieldType };
    }
  }
  // excel 生成物属性风格访问:dict[str, V] 上的 `.attr` → V(键名不在
  // typeText 里,类型直读;容器方法名排除,dict.get 不假命中)
  if (shape.shape === 'dict' && !CONTAINER_METHOD_NAMES.has(step.name!)) {
    return { kind: 'type', typeText: shape.value };
  }
  // list/set/标量上的属性访问不支持——零产出
  return null;
}

function resolveTarget(
  node: ChainNode,
  target: MemberChainQuery['target'],
  entries: readonly ChainSchemaEntry[],
  path: string[]
): string | null {
  if (target.kind === 'dict-key') {
    path.push(`["${target.key}"]`);
    if (node.kind === 'class') {
      return null;
    }
    const shape = parseTypeShape(node.typeText);
    return shape.shape === 'dict' ? shape.value : null;
  }
  const pseudo: MemberChainStep = { kind: 'attr', name: target.name };
  const walked = walkStep(node, pseudo, entries, path);
  if (!walked) {
    return null;
  }
  if (walked.kind === 'class') {
    return `${walked.entry.name}(${walked.entry.typeText})`;
  }
  return walked.typeText;
}
