// GEN-DEF-1e: the pure logic half of the user_type triple-contract index and the missing-method diagnostic.
//
// Engine semantics (datatype.cpp FixedDictType::setImplModule L2383-2397): the
// implementation object must carry all three of the createObjFromDict /
// getDictFromObj / isSameType attributes; if any is absent, PyObject_GetAttrString
// fails to retrieve it → SCRIPT_ERROR_CHECK + return false, and the module load
// fails (engine startup / entity loading always blows up). This module only makes
// the decision and locates the position (pure functions, no vscode dependency);
// data collection (reading types.xml / scanning impl files) lives in
// userTypeContractSource, and diagnostic wiring lives in the extension.
//
// Semantic supplement (the concrete embodiment of the 2026-11-02 user order on
// data-flow direction):
//  - The text for each missing contract method states the direction of the
//    consequence — missing createObjFromDict = cannot construct from
//    network/DB (the deserialization entry); missing getDictFromObj = cannot write
//    network/persistence (the serialization exit); missing isSameType = type
//    judgment disabled.
//  - The serialization contract (semantics ①): wire/db→mem =
//    createObjFromDict (the deserialization entry), mem→wire/db = getDictFromObj
//    (the serialization exit) — the documentation/hover wording is in
//    userTypeContractSource's serialization-contract description function.

/** The three contract methods, each fetched by GetAttrString in engine setImplModule (the order is the declaration order). */
export const USER_TYPE_CONTRACT_METHODS = [
  'createObjFromDict',
  'getDictFromObj',
  'isSameType'
] as const;

export type UserTypeContractMethod = (typeof USER_TYPE_CONTRACT_METHODS)[number];

/** Diagnostic code: the user_type implementation class is missing a contract method (the engine load always blows up). Convention kbengine.<camelCase>. */
export const USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE =
  'kbengine.userTypeContractMethodMissing';

/**
 * Semantics ③: the consequence-direction wording for each missing contract method.
 * Written into diagnostic messages and the hover completion face, corresponding one
 * to one with the call semantics in datatype.cpp (impl_createObjFromDict calls
 * createObjFromDict and then passes isSameType; impl_getDictFromObj calls
 * getDictFromObj).
 */
export const USER_TYPE_CONTRACT_CONSEQUENCE: Record<UserTypeContractMethod, string> = {
  createObjFromDict: '无法从网络/DB 构造该类型(反序列化入口缺失)',
  getDictFromObj: '无法写网络/持久化该类型(序列化出口缺失)',
  isSameType: '类型判定失效(createObjFromDict 结果无法通过校验)'
};

/**
 * A contract-method presence snapshot for one user_type. The methods values come
 * from a static scan of the impl file source (implFileHasContractMethod); when the
 * impl file is missing all three are false and implLine is null — that case is backed
 * up by the "user_type python file not found" diagnostic, so missing methods are not
 * reported again here.
 */
export interface UserTypeContractStatus {
  /** user_type name (the registered name in types.xml/alias.xml). */
  name: string;
  /** The implementedBy verbatim text (module.Symbol; the engine splits it into two parts on '.'). */
  implementedBy?: string;
  /** The impl python file path (already resolved to an existing file via userTypeRoots). */
  implFile?: string;
  /** The impl symbol definition line (1-based; the findImplementedBySymbolLine semantics; 1 when not found). */
  implLine?: number;
  /** Whether each contract method exists in the impl file. */
  methods: Record<UserTypeContractMethod, boolean>;
}

/** A missing-method diagnostic item (located at the impl file's symbol line; converted to vscode.Diagnostic by the wiring layer). */
export interface UserTypeContractMissingItem {
  message: string;
  method: UserTypeContractMethod;
  /** The user type name (reused by the diagnostic message / asserted in tests). */
  typeName: string;
  /** The symbol name to locate (the trailing segment of implementedBy; falls back to the type name). */
  symbolName: string;
  /** The located symbol's length (the diagnostic range width). */
  symbolLength: number;
  /** The related target (the implementation declaration line in types.xml). */
  related: { targetFile: string; label: string };
}

/** Look up whether a contract method is defined in the impl file's verbatim source (a file-level scan;
 *  both class-method and instance-assignment forms are covered — the engine fetches the
 *  object via the module attribute and then takes the method, so a definition inside the
 *  implementation module is visible). */
export function implFileHasContractMethod(source: string, method: string): boolean {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*def[ \\t]+${escaped}[ \\t]*\\(`, 'm').test(source);
}

/** Symbol name = the trailing segment of implementedBy (the engine's GetAttrString takes the trailing segment); defaults to falling back to the type name. */
export function contractSymbolName(status: UserTypeContractStatus): string {
  const parts = status.implementedBy?.trim().split('.') ?? [];
  const last = parts.length > 0 ? parts[parts.length - 1] : '';
  return last || status.name;
}

/**
 * Collect the missing-method records of a single user_type (pure function; the status
 * comes from the snapshot, no I/O). One record is produced per missing method
 * (the semantics-③ consequence directions differ, so presenting them separately is
 * more precise than merging); silent when the implementation file is missing
 * (implFile empty) — backed up by the "user_type python file not found" diagnostic,
 * not reported twice.
 */
export function collectUserTypeContractMissing(
  status: UserTypeContractStatus
): UserTypeContractMissingItem[] {
  if (!status.implFile) {
    return [];
  }
  const missing: UserTypeContractMissingItem[] = [];
  const symbolName = contractSymbolName(status);
  for (const method of USER_TYPE_CONTRACT_METHODS) {
    if (!status.methods[method]) {
      missing.push({
        message:
          `user_type ${status.name} 的实现 ${status.implementedBy ?? symbolName} ` +
          `缺契约方法 ${method}():${USER_TYPE_CONTRACT_CONSEQUENCE[method]}——` +
          `引擎 setImplModule 取不到该方法,装载实现模块必失败`,
        method,
        typeName: status.name,
        symbolName,
        symbolLength: symbolName.length,
        related: {
          targetFile: status.implFile,
          label: `实现文件 ${status.implFile.split(/[\\/]/).pop() ?? status.implFile}`
        }
      });
    }
  }
  return missing;
}

/** Aggregate missing-method diagnostics by impl file (the located line is 1-based; file paths compared after normalization by resolve). */
export function collectUserTypeContractMissingByImplFile(
  statuses: readonly UserTypeContractStatus[],
  implFile: string,
  pathResolve: (p: string) => string = identityResolve
): Array<UserTypeContractMissingItem & { line: number }> {
  const items: Array<UserTypeContractMissingItem & { line: number }> = [];
  for (const status of statuses) {
    if (!status.implFile || pathResolve(status.implFile) !== pathResolve(implFile)) {
      continue;
    }
    const line = status.implLine ?? 1;
    for (const item of collectUserTypeContractMissing(status)) {
      items.push({ ...item, line });
    }
  }
  return items;
}

function identityResolve(p: string): string {
  return p;
}
