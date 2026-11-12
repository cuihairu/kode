/**
 * cellData 回调入口访问检查(KSEM-CELL-12):onGetCell 中读 self.cellData 必抛。
 *
 * 引擎依据(base 侧 kbe/src/server/baseapp/entity.cpp,kbengine@3082ab5):
 * - onGetCell 先跑 destroyCellData()(:1024,PyObject_DelAttrString 删属性 :564),
 *   **之后**才调脚本回调(:1030-1032)——回调内任何对 self.cellData 的求值都抛
 *   AttributeError(属性表无 type 级 cellData getter,纯实例属性,删除后无回退)。
 * - cellData 只有构建时(:252)与 onBackupCellData 的 isDirty 分支(:1122)两处装回,
 *   onGetCell 内不会重装——本方法体内「引擎删了」是确定事实。
 * - 判据只覆盖 onGetCell 这个**明确回调入口**;onLoseCell/onRestore/任意方法的
 *   调用时机与 cellData 在场性的关系不做确定结论(验收原句),本面一律沉默。
 *
 * 求值/赋值分类(行内,括号深度感知):
 * - `self.cellData = <dict>` 是属性存储,合法不抛——**不报**,且其后本方法体内
 *   的读取因属性已被重建同样不报(两态流:absent/present,存储→present,
 *   del→absent,absent 态读→报);
 * - `self.cellData[k] = v`、`.get(...)`、迭代、别名绑定、del——都要先求值属性,
 *   absent 态一律报;
 * - 注释与字符串由掩码剔除(字符串里的 "self.cellData" 不是访问)。
 *
 * 范围:类体内名为 onGetCell 的方法(模块级同名函数引擎从不调用,不报)。
 * 角色闸在装配面(base 脚本);纯逻辑无 vscode/无键宇宙/无 RPC,直接可测。
 */
import { parsePythonFile, pythonCodeLines } from './pythonParser';

/** 本面产出的诊断码(与 lintRuleRegistry 锁步)。 */
export const CELL_DATA_CALLBACK_CODE = 'kbengine.cellDataLifecycle';

/** 一条回调入口访问发现(纯数据;extension 侧转 vscode.Diagnostic)。 */
export interface CellDataCallbackFinding {
  /** 0 基行。 */
  line: number;
  /** `self.cellData` 起点(0 基行内字符列)。 */
  character: number;
  /** `self.cellData` 长度(提示区间 = 接收者表达式本体)。 */
  length: number;
  message: string;
}

/** 诊断项(纯数据;与 CELL-08/10 的 item 形状同形,便于共用装配面)。 */
export interface CellDataCallbackDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** 开关默认值(与 CELL-08/10 同口径:默认开)。 */
export const CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT = true;

const ACCESS_RE = /\bself\.cellData\b/g;

/** onGetCell 体(0 基,含 def 行,不含收窄行)。缩进闸:首个非空行缩进 ≤ def 缩进即止。 */
function methodBodySpan(lines: string[], defLine: number): { start: number; end: number } {
  const defIndent = lines[defLine].match(/^\s*/)![0].length;
  let end = lines.length;
  for (let i = defLine + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') {
      continue;
    }
    if (raw.match(/^\s*/)![0].length <= defIndent) {
      end = i;
      break;
    }
  }
  return { start: defLine, end };
}

/**
 * 行内存储判定:`self.cellData` 之后、同行内是否存在深度 0 的纯赋值 `=`。
 * `[`/`(` 在赋值号之前出现 → 下标/调用已先求值属性,不是存储。
 * `==`/`<=`/`>=`/`!=`/增广(`+=` 等)/walrus(`:=`) 的 `=` 不算存储。
 */
function isAttributeStore(maskedLine: string, tokenEnd: number): boolean {
  let depth = 0;
  let previous = '';
  for (let i = tokenEnd; i < maskedLine.length; i += 1) {
    const ch = maskedLine[i];
    if (ch === '[' || ch === '(' || ch === '{') {
      if (depth === 0 && ch === '[') {
        return false; // self.cellData[k] = v:下标先求值属性 → 读
      }
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '=' && depth === 0) {
      if (maskedLine[i + 1] === '=') {
        continue; // ==
      }
      if (previous !== '' && '=+-*/%<>&|^:!'.includes(previous)) {
        continue; // == <= >= != += -= … :=
      }
      return true;
    }
    if (ch !== ' ' && ch !== '\t') {
      previous = ch;
    }
  }
  return false;
}

/** 行内是否 `del self.cellData`(token 之前最近非空 token 是 del 关键字)。 */
function isDelStatement(maskedLine: string, tokenStart: number): boolean {
  return /\bdel\s+$/.test(maskedLine.slice(0, tokenStart));
}

/** cellData 属性态:absent=引擎已删(onGetCell 入口即此态);present=脚本在本方法体内重建过。 */
type AttrState = 'absent' | 'present';

/** onGetCell 中的 self.cellData 访问检查(纯函数)。 */
export function cellDataCallbackFindings(text: string): CellDataCallbackFinding[] {
  const parsed = parsePythonFile(text, 'virtual.py');
  const spans: Array<{ line: number; character: number }> = [];
  for (const cls of parsed.classes) {
    const loc = cls.methods.get('onGetCell');
    if (loc) {
      spans.push(loc);
    }
  }
  if (spans.length === 0) {
    return [];
  }

  const maskedLines = pythonCodeLines(text);
  const findings: CellDataCallbackFinding[] = [];
  for (const span of spans) {
    const body = methodBodySpan(maskedLines, span.line);
    let state: AttrState = 'absent';
    for (let lineNo = body.start; lineNo < body.end; lineNo += 1) {
      const masked = maskedLines[lineNo];
      ACCESS_RE.lastIndex = 0;
      let match = ACCESS_RE.exec(masked);
      while (match) {
        const tokenStart = match.index;
        const tokenEnd = tokenStart + match[0].length;
        if (isAttributeStore(masked, tokenEnd)) {
          state = 'present';
        } else if (isDelStatement(masked, tokenStart)) {
          // 引擎依据写进文案:删除在回调前(cellapp/entity.cpp 同族结论不混用,
          // 本面只谈 base 侧 onGetCell)。del 与读在 absent 态同抛 AttributeError。
          if (state === 'absent') {
            findings.push({
              line: lineNo,
              character: tokenStart,
              length: match[0].length,
              message: 'onGetCell 触发时 self.cellData 已被引擎删除(cell 建成即删属性,baseapp/entity.cpp:1024 在脚本回调 :1030 之前),此处 del 同样抛 AttributeError'
            });
          }
          state = 'absent';
        } else if (state === 'absent') {
          findings.push({
            line: lineNo,
            character: tokenStart,
            length: match[0].length,
            message: 'onGetCell 触发时 self.cellData 已被引擎删除(cell 建成即删属性,baseapp/entity.cpp:1024 在脚本回调 :1030 之前),此处读取必然抛 AttributeError;需要的数据请在请求 cell 前存入 base 自有属性'
          });
        }
        match = ACCESS_RE.exec(masked);
      }
    }
  }
  return findings;
}

/** 发现 → 诊断项(区间 = `self.cellData` 本体)。 */
export function cellDataCallbackFindingToItem(
  finding: CellDataCallbackFinding
): CellDataCallbackDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: CELL_DATA_CALLBACK_CODE
  };
}
