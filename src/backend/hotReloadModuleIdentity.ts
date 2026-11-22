/**
 * 热更模块身份纯面(HR-PR-02,书 docs/kode2/KODE_2_COMPLETE_TODO.md §19.3):
 * - HR-MOD-001 `HotReloadModuleIdentity` 九字段 DTO(workspaceId/rootId/
 *   fileUri/fullModule/requestModule/fileStem/parentName/language/sourceVersion);
 * - HR-MOD-002 纯解析器:输入 URI、明确资源根(单根或多根候选)、workspace
 *   身份、user override、single-level fallback 开关;输出 Result + 结构化
 *   diagnostics;零 IO、零 vscode 导入——所有输入都由调用方显式给,本面
 *   绝不隐式读盘/读配置;
 * - HR-MOD-005 字符串语义唯一来源=hotReloadTempEdit.resolveModuleDualName
 *   (角色目录剥段/`.py` 尾缀/`__init__`/穿越拒绝全部复用,本面只做根候选
 *   选择、URI 词法规范化、诊断码映射与 override,不另写一套模块名推导);
 * - HR-MOD-009 URI 词法规范化:file:// 解码、反斜杠、UNC(WSL `//wsl$`、
 *   `//wsl.localhost`、Remote SSH 挂载形)、重复斜杠、`.`/`..` 词法消解、
 *   盘符大写、大小写保留。符号链接消解与 fs 级大小写语义需 realpath/平台
 *   判定,属 IO 专项,纯面不做(与 crates/kode-vfs VFS-001 同边界)。
 */

import {
  resolveModuleDualName,
  type ModuleDualNameUnsupportedReason
} from './hotReloadTempEdit';

/** HR-MOD-001:热更模块身份九字段 DTO。记录唯一化=targetId(通道侧)+rootId+fileUri */
export interface HotReloadModuleIdentity {
  /** 工作区身份(多根工作区归属);未给为空串,不猜 */
  readonly workspaceId: string;
  /** 脚本资源根身份(命中哪个候选根);未给为空串 */
  readonly rootId: string;
  /** 规范化后的本地形态路径(HR-MOD-009 canonicalizeScriptFilePath 产物) */
  readonly fileUri: string;
  /** 完整模块名(UI 展示名,书 §19.1):entities.fight.FightAI */
  readonly fullModule: string;
  /** 请求模块名(实际发送名,书 §19.1):fight.FightAI */
  readonly requestModule: string;
  /** 文件名去结尾 .py:FightAI */
  readonly fileStem: string;
  /** 直接父目录名:fight;根下单层 fallback 时为空串 */
  readonly parentName: string;
  /** 目前唯一支持 python(非 .py 在解析器即拒) */
  readonly language: 'python';
  /** 文档版本(调用方透传,防旧版本结果覆盖新版本) */
  readonly sourceVersion?: number;
}

/** 结构化诊断码(与 core 的 ModuleDualNameUnsupportedReason 一一映射,另加身份面三码) */
export type HotReloadModuleDiagnosticCode =
  | 'no-root'
  | 'out-of-root'
  | 'ambiguous-root'
  | 'invalid-override'
  | 'invalid-stem'
  | 'not-python'
  | 'traversal'
  | 'empty-stem'
  | 'init-file'
  | 'root-level';

export interface HotReloadModuleDiagnostic {
  readonly code: HotReloadModuleDiagnosticCode;
  readonly message: string;
}

export type HotReloadModuleResolution =
  | { readonly ok: true; readonly identity: HotReloadModuleIdentity }
  | { readonly ok: false; readonly diagnostics: readonly HotReloadModuleDiagnostic[] };

export interface HotReloadModuleIdentityInput {
  /** file:// URI 或本地路径(反斜杠/正斜杠均可,经词法规范化) */
  readonly fileUri: string;
  /** 工作区身份;缺省空串(如实未给,不猜) */
  readonly workspaceId?: string;
  /** 资源根身份标签;缺省空串 */
  readonly rootId?: string;
  /** 单根便捷形态(与既有 scriptRoot 设置同形);与 scriptRoots 并入同一候选集 */
  readonly scriptRoot?: string;
  /** 多根候选集(HR-MOD-006:未唯一确定根则拒绝,不猜) */
  readonly scriptRoots?: readonly string[];
  /** HR-MOD-006 显式优先级(索引小=优先):只在多根命中>1 时生效,唯一最小秩
   * 候选才赢(用户显式排序=配置,非猜测);未给/空=既有不猜拒绝;不在清单里
   * 的根秩=+∞,绝不因优先级被提升。 */
  readonly rootPriority?: readonly string[];
  /** 用户显式指定模块名:合法则替换 fullModule/requestModule,非法则拒绝(不静默回落) */
  readonly userOverrideModule?: string;
  /** HR-MOD-008 显式 single-level fallback;默认关=根下单层脚本 unresolved */
  readonly allowRootLevelStem?: boolean;
  /** 文档版本透传 */
  readonly sourceVersion?: number;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

/**
 * 词法规范化(HR-MOD-009,纯字符串,零 IO):
 * file:// URI 剥 scheme(file://server/share 保留 `//` UNC 形)+ 有守卫的
 * percent 解码(解码失败原样保留,不抛);反斜杠转正斜杠;重复斜杠折叠
 * (行首 `//` UNC 保留);`.` 段删除、`..` 段词法上卷(绝对路径根处 `..`
 * 落根;相对路径无基底时 `..` 保留,交由上层穿越拒绝);Windows 盘符统一
 * 大写;其余大小写一律保留(HR-MOD-003)。
 */
export function canonicalizeScriptFilePath(input: string): string {
  let value = input.trim();
  if (value.length === 0) {
    return '';
  }
  if (value.toLowerCase().startsWith('file://')) {
    const rest = value.slice('file://'.length);
    // file:///c:/x → /c:/x;file://server/share → //server/share(UNC)
    value = rest.startsWith('/') ? rest : `//${rest}`;
  }
  value = toPosix(value);
  // percent 解码只对路径体做,UNC 前缀 `//` 不受影响;坏转义原样保留不抛
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非法 percent 序列(如裸 %):保留原样,后续按字面路径判定
  }
  const unc = value.startsWith('//');
  const body = unc ? value.slice(2) : value;
  const collapsed = body.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/');
  const stack: string[] = [];
  const absolute = collapsed.startsWith('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop();
      } else if (!absolute) {
        stack.push(segment); // 相对路径无基底,`..` 保留待上层拒
      }
      continue;
    }
    stack.push(segment);
  }
  let result = (absolute ? '/' : '') + stack.join('/');
  if (unc) {
    result = `//${result.startsWith('/') ? result.slice(1) : result}`;
  }
  // Windows 盘符统一大写:/c:/x → /C:/x;c:/x → C:/x(仅盘符,其余大小写不动)
  result = result.replace(/^\/([a-z]):/, (_m, drive: string) => `/${drive.toUpperCase()}:`);
  result = result.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  return result.replace(/\/+$/, '');
}

/** 供诊断映射:core 不支持原因 → 身份面诊断码 */
const REASON_TO_CODE: Record<ModuleDualNameUnsupportedReason, HotReloadModuleDiagnosticCode> = {
  'no-root': 'no-root',
  'not-python': 'not-python',
  'out-of-root': 'out-of-root',
  traversal: 'traversal',
  'empty-stem': 'empty-stem',
  'init-file': 'init-file',
  'root-level': 'root-level'
};

/** user override 校验:非空、无空白、无点段边界问题;非法返回 null(调用方拒绝,不静默回落) */
const validateOverrideModule = (value: string): string | null => {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /\s/.test(trimmed) ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.split('.').some(segment => segment.length === 0)
  ) {
    return null;
  }
  return trimmed;
};

/** 短名健壮性(HR-MOD-015 URL encoding/Unicode 面):空白与点不入模块名;Unicode 字母合法(PEP 3130) */
const stemIsRepresentable = (stem: string): boolean => !/[\s.]/.test(stem);

/** 根候选选择产物:唯一根 / 三拒绝态(不猜,列全候选) */
export type ScriptRootSelection =
  | { readonly kind: 'root'; readonly root: string }
  | { readonly kind: 'no-root' }
  | { readonly kind: 'out-of-root' }
  | { readonly kind: 'ambiguous-root'; readonly candidates: readonly string[] };

/**
 * 根候选选择(HR-MOD-002/006 纯核,零 IO):roots 须已规范化+保序去重。
 * 多根命中>1 且给了显式优先级时,唯一有限最小秩候选才赢(索引小=优先,
 * 用户显式排序=配置非猜测);未给优先级/全未排/并列一律拒绝列全候选
 * (既有不猜口径)。不在清单里的根秩=+∞,绝不因优先级被提升。单根命中
 * 恒赢(与是否配置优先级无关)。
 */
export function selectScriptRoot(
  canonical: string,
  roots: readonly string[],
  priority?: readonly string[]
): ScriptRootSelection {
  if (roots.length === 0) {
    return { kind: 'no-root' };
  }
  const candidates = roots.filter(root => canonical !== root && canonical.startsWith(`${root}/`));
  if (candidates.length === 0) {
    return { kind: 'out-of-root' };
  }
  if (candidates.length === 1) {
    return { kind: 'root', root: candidates[0] };
  }
  // >1 命中:显式优先级裁决(唯一最小秩才赢;否则既有拒绝)
  const ranked = priority
    ? [...new Set(priority.map(canonicalizeScriptFilePath).filter(root => root.length > 0))]
    : [];
  if (ranked.length > 0) {
    const rankOf = (root: string): number => {
      const index = ranked.indexOf(root);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    };
    let minRank = Number.POSITIVE_INFINITY;
    let winner: string | null = null;
    let tied = false;
    for (const candidate of candidates) {
      const rank = rankOf(candidate);
      if (rank < minRank) {
        minRank = rank;
        winner = candidate;
        tied = false;
      } else if (rank === minRank) {
        tied = true;
      }
    }
    if (minRank !== Number.POSITIVE_INFINITY && !tied && winner !== null) {
      return { kind: 'root', root: winner };
    }
  }
  return { kind: 'ambiguous-root', candidates };
}

/**
 * 纯解析器(HR-MOD-002):根候选选择 → 委托 resolveModuleDualName →
 * 诊断映射/override/DTO 组装。多根歧义(>1 候选含此文件)一律拒绝并
 * 列出全部命中根,绝不猜唯一根(HR-MOD-006);歧义拒绝同时从源头挡住
 * 跨根同名 fight.FightAI 误映射(HR-MOD-010 的解析器侧)。
 */
export function resolveHotReloadModuleIdentity(
  input: HotReloadModuleIdentityInput
): HotReloadModuleResolution {
  const canonical = canonicalizeScriptFilePath(input.fileUri);
  if (canonical.length === 0) {
    return {
      ok: false,
      diagnostics: [{ code: 'not-python', message: 'fileUri 为空,拒绝解析' }]
    };
  }
  // RUST-424 重复根矩阵:同一规范化根出现多次(scriptRoots 重复项或 scriptRoot
  // 与 scriptRoots 同根)只算一个候选——重复配置是用户侧同一根,≠HR-MOD-006
  // 的多根歧义,必须去重后再判命中(否则同一根自造假 ambiguous)。保序去重。
  const roots = [
    ...(input.scriptRoots ?? []).map(canonicalizeScriptFilePath),
    ...(input.scriptRoot !== undefined ? [canonicalizeScriptFilePath(input.scriptRoot)] : [])
  ]
    .filter(root => root.length > 0)
    .filter((root, index, self) => self.indexOf(root) === index);
  const selection = selectScriptRoot(canonical, roots, input.rootPriority);
  if (selection.kind === 'no-root') {
    return {
      ok: false,
      diagnostics: [
        { code: 'no-root', message: '未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)' }
      ]
    };
  }
  if (selection.kind === 'out-of-root') {
    return {
      ok: false,
      diagnostics: [
        { code: 'out-of-root', message: `文件不在任何脚本资源根内: ${canonical} ∉ [${roots.join(', ')}]` }
      ]
    };
  }
  if (selection.kind === 'ambiguous-root') {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'ambiguous-root',
          message: `文件命中多个脚本资源根,未唯一确定前拒绝解析(HR-MOD-006 不猜): ${canonical} ∈ [${selection.candidates.join(', ')}]`
        }
      ]
    };
  }
  const root = selection.root;
  const dual = resolveModuleDualName(canonical, root, { allowRootLevelStem: input.allowRootLevelStem });
  if ('unsupported' in dual) {
    const code = REASON_TO_CODE[dual.reason];
    return {
      ok: false,
      diagnostics: [
        {
          code,
          message:
            dual.reason === 'root-level'
              ? `${dual.unsupported};或显式开启 allowRootLevelStem(HR-MOD-008)`
              : dual.unsupported
        }
      ]
    };
  }
  if (!stemIsRepresentable(dual.fileStem)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'invalid-stem',
          message: `文件短名含空白或点,不可能成为合法模块名: ${dual.fileStem}`
        }
      ]
    };
  }
  let fullModule = dual.fullModule;
  let requestModule = dual.requestModule;
  if (input.userOverrideModule !== undefined) {
    const override = validateOverrideModule(input.userOverrideModule);
    if (override === null) {
      return {
        ok: false,
        diagnostics: [
          { code: 'invalid-override', message: `user override 非法(空/含空白/点段为空): ${input.userOverrideModule}` }
        ]
      };
    }
    fullModule = override;
    requestModule = override;
  }
  return {
    ok: true,
    identity: {
      workspaceId: input.workspaceId ?? '',
      rootId: input.rootId ?? '',
      fileUri: canonical,
      fullModule,
      requestModule,
      fileStem: dual.fileStem,
      parentName: dual.parentName,
      language: 'python',
      sourceVersion: input.sourceVersion
    }
  };
}
