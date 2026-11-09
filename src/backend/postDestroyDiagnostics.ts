// IDE-LINT-010:Entity 销毁后访问 lint(KBE-PY-010)——同一函数内可确定的
// `self.destroy()` 之后直接访问 `self.<成员>` 报 Warning;跨回调/异常/动态
// 分派/跨块标注未分析,不做全文件误报。
//
// 纯逻辑层,不 import vscode。引擎事实:
//   - `destroy` 是各面实体宏公共方法(entity_macro.h:20 `SCRIPT_METHOD_DECLARE
//     ("destroy", pyDestroyEntity, ...)`),`self.destroy()` 销毁自身;
//   - 销毁后各 getter(如 Entity::pyGetCellEntityCall)检查 destroyed,访问
//     即异常——故销毁后的任何成员访问都是错用。
//
// 判定(最小、可靠、同块直进):
//   - 非实体脚本(路径面无 def 归属)→ 不接管(普通 Python 类不猜);
//   - 角色不明(路径面 null 且 def 归属空/多面歧义)→ 不猜;
//   - 同一函数体同一块(同一缩进,中间无 dedent)内,销毁语句(整句
//     `self.destroy()` 或 `x = self.destroy()`)先于访问语句,且两者间无
//     同层 `return`/`break`/`continue`/`raise`(无条件早退,访问为死码)→
//     报 Warning;
//   - 成员集:排除 `id`/`isDestroyed`/`className`(销毁后仍可读的身份/
//     状态项,读 `isDestroyed` 正是确认销毁)与 `destroy`(重复销毁非本
//     lint 面向的访问错用)——其余任何成员(属性/方法/EntityCall)访问都报;
//   - 销毁语句在访问语句之后、销毁条件执行(if/while 内)、或与访问不同块
//     (销毁在祖先块/嵌套块/回调)→ 不报(未分析,见下)。
//
// 已知边界(与同族 self-属性 lint 一致):销毁在祖先块、访问在嵌套块、跨
// 函数/跨回调(回调里销毁,另一回调访问)、异常路径(销毁抛错未完成)、
// 动态分派(def 声明 `destroy` 方法/属性 → `self.destroy()` 可能非引擎销毁)
// ——均不分析,不冒充已实现;`self.<prop>` 仅 `self.` 单段前缀(`other.destroy`
// 与 `self.cell.destroy` 非销毁自身,不参与)。

import { pythonCodeLines, pythonStatements } from './pythonParser';
import { l10nText } from '../nlsRuntime';
import { resolveEntityComponentFaceFromPath, type EntityComponentFace } from './entityBuiltinProperties';

export const POST_DESTROY_DIAGNOSTIC_CODE = 'kbengine.postDestroy';
export const POST_DESTROY_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 销毁后仍可读/无碍的成员(身份、状态、重复销毁);其余访问都报 */
const SAFE_MEMBERS = new Set(['id', 'isDestroyed', 'className', 'destroy']);

const DESTROY_STATEMENT = /^(?:[A-Za-z_]\w*\s*=\s*)?self\.destroy\s*\(/;
const EARLY_EXIT_STATEMENT = /^(?:return|break|continue|raise)\b/;
const FUNCTION_HEADER = /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;
const ACCESS_PATTERN = /\bself\.(\w+)/g;

/** 一处销毁后访问 */
export interface PostDestroyFinding {
  line: number;
  character: number;
  length: number;
  member: string;
  /** 销毁语句位置(取证) */
  destroyLine: number;
  destroyColumn: number;
  message: string;
}

interface Statement {
  text: string;
  line: number;
  endLine: number;
  indent: number;
}

/** 同一函数体同一块:同缩进,且两者间无 dedent(缩进 < 本层) */
function sameBlock(from: Statement, to: Statement, all: readonly Statement[]): boolean {
  if (from.indent !== to.indent) {
    return false;
  }
  for (const stmt of all) {
    if (stmt.line <= from.line) { continue; }
    if (stmt.line >= to.line) { break; }
    if (stmt.indent < from.indent) {
      return false;
    }
  }
  return true;
}

/**
 * 销毁后访问判定(纯函数)。pathFace 与 defFaces 由调用方提供(与内建属性
 * hover 同源面判定);isDestroyDeclared 为 def 是否声明 `destroy`(动态分派
 * 边界,声明则 `self.destroy()` 可能非引擎销毁 → 整文件不分析)。
 */
export function findPostDestroyFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  isDestroyDeclared: boolean
): PostDestroyFinding[] {
  // 动态分派边界:def 声明 destroy → 不冒充引擎销毁
  if (isDestroyDeclared) {
    return [];
  }
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return [];
  }
  const face = pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  if (face === null) {
    return [];
  }

  const statements = pythonStatements(text);
  const maskedLines = pythonCodeLines(text);
  const findings: PostDestroyFinding[] = [];

  // 只分析函数体内(模块/类体无 self;顶层匹配不成立)
  for (let s = 0; s < statements.length; s += 1) {
    const header = statements[s];
    if (!FUNCTION_HEADER.test(header.text)) {
      continue;
    }
    // 函数体 = 其后缩进 > def 缩进的语句
    const bodyStart = s + 1;
    let bodyEnd = statements.length;
    for (let t = bodyStart; t < statements.length; t += 1) {
      if (statements[t].indent <= header.indent) {
        bodyEnd = t;
        break;
      }
    }
    const body = statements.slice(bodyStart, bodyEnd);

    // 同块内查找每个访问语句前面的销毁语句
    for (let a = 0; a < body.length; a += 1) {
      const access = body[a];
      if (!/\bself\./.test(access.text)) {
        continue;
      }
      // 找到本块内先于 access 的销毁语句(同块,无同层早退)
      let destroy: Statement | null = null;
      for (let d = 0; d < a; d += 1) {
        const candidate = body[d];
        if (!DESTROY_STATEMENT.test(candidate.text.trimStart())) {
          continue;
        }
        if (!sameBlock(candidate, access, body)) {
          continue;
        }
        // 同层早退(return/break/continue/raise)在销毁与访问之间 → 访问死码
        let dead = false;
        for (let k = d + 1; k < a; k += 1) {
          const mid = body[k];
          if (mid.indent === access.indent && EARLY_EXIT_STATEMENT.test(mid.text.trimStart())) {
            dead = true;
            break;
          }
        }
        if (!dead) {
          destroy = candidate;
          break;
        }
      }
      if (destroy === null) {
        continue;
      }
      // 逐个命中 `self.<member>`(member 非安全集):直接扫掩码行找位置
      // (掩码保留源位置,且字符串/注释内的伪访问不命中)
      for (let ln = access.line; ln <= access.endLine; ln += 1) {
        const masked = maskedLines[ln];
        ACCESS_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ACCESS_PATTERN.exec(masked)) !== null) {
          const member = match[1];
          if (SAFE_MEMBERS.has(member)) {
            continue;
          }
          const destroyColumn = Math.max(0, maskedLines[destroy.line].indexOf('self.destroy'));
          findings.push({
            line: ln,
            character: match.index,
            length: match[0].length,
            member,
            destroyLine: destroy.line,
            destroyColumn,
            message: l10nText(
              'self.{member} accessed after self.destroy() (destroyed at line {line}): the entity is dead after destruction; {member} access triggers the engine destroyed check',
              { member, line: destroy.line + 1 }
            )
          });
        }
      }
    }
  }
  // 去重:嵌套函数体既随外层函数分析、又作自身函数分析,同一命中会重复
  const seen = new Set<string>();
  return findings.filter(finding => {
    const key = `${finding.line}:${finding.character}:${finding.member}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface PostDestroyDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/**
 * 异步入口:pathFace 按目录域定面;判不出经 fetchDefFaces 取 def 归属面
 * (与内建属性 inlay provider 同源);isDestroyDeclared 由调用方经
 * getMappingForPythonFile 判 def 是否声明 destroy(动态分派边界)。
 */
export async function postDestroyDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  isDestroyDeclared: () => boolean,
  enabled: boolean
): Promise<PostDestroyDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return findPostDestroyFindings(text, pathFace, defFaces, isDestroyDeclared()).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: POST_DESTROY_DIAGNOSTIC_CODE
  }));
}
