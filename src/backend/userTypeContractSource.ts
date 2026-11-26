// GEN-DEF-1e data-collection half (read types.xml/alias.xml + scan impl files).
//
// Pure logic (judgment/locating) lives in userTypeContract; this module only does
// I/O and registry resolution: getCustomTypeInfos → custom types carrying
// implementedBy → impl files → the triple-contract method presence snapshot. The
// serialization-contract descriptions (semantics ①②) are here too, reused by
// hover/stub documentation.
// KSEM-STRUCT-06: the implementedBy real-shape collection (candidate discovery +
// source reading) is also here; the judgment lives in the implementedByBinding
// pure core.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  getCustomTypeInfos,
  getDefinitionWorkspaceLayout,
  findImplementedBySymbolLine,
  readWorkspaceTextFile
} from '../definitionWorkspace';
import {
  USER_TYPE_CONTRACT_METHODS,
  USER_TYPE_CONTRACT_CONSEQUENCE,
  type UserTypeContractMethod,
  type UserTypeContractStatus,
  implFileHasContractMethod
} from './userTypeContract';
import { resolveImplementedByBinding, type ImplementedByBinding, type ImplementedByCandidate } from './implementedByBinding';

/**
 * Collect all user_type contract snapshots (custom types carrying implementedBy;
 * pure FIXED_DICT/ARRAY aliases have no impl and do not enter the index — they do
 * not go through the object contract, they serialize in dict form). When the impl
 * file fails to parse or is missing, implFile is empty (the missing-method
 * diagnostic stays silent, backed up by the "python file not found" diagnostic).
 */
export function collectUserTypeContractStatuses(
  workspaceRoot: string
): UserTypeContractStatus[] {
  const statuses: UserTypeContractStatus[] = [];
  for (const info of getCustomTypeInfos(workspaceRoot)) {
    if (!info.implementedBy) {
      continue;
    }
    const implFile = info.pythonFilePath;
    const methods: Record<UserTypeContractMethod, boolean> = {
      createObjFromDict: false,
      getDictFromObj: false,
      isSameType: false
    };
    let implLine: number | undefined;
    if (implFile) {
      const source = readWorkspaceTextFile(implFile);
      for (const method of USER_TYPE_CONTRACT_METHODS) {
        methods[method] = implFileHasContractMethod(source, method);
      }
      implLine = findImplementedBySymbolLine(implFile, info.implementedBy) ?? 1;
    }
    statuses.push({
      name: info.name,
      implementedBy: info.implementedBy,
      implFile,
      implLine,
      methods
    });
  }
  return statuses;
}

/**
 * One-sentence serialization-contract description (semantics ①): wire/db→mem =
 * createObjFromDict (the deserialization entry), mem→wire/db = getDictFromObj
 * (the serialization exit). Used by the hover of user_type / PYTHON properties
 * carrying an impl, and by stub documentation.
 */
export function userTypeSerializationContractDoc(
  implementedBy?: string,
  missing?: ReadonlySet<UserTypeContractMethod>
): string {
  const implNote = implementedBy ? `实现类 \`${implementedBy}\`` : '带实现的自定义类型';
  const lines: string[] = [];
  lines.push(`${implNote} 的双向序列化契约:`);
  lines.push(
    `wire/db→mem = \`createObjFromDict(dict)\`(反序列化入口)${missing?.has('createObjFromDict') ? '(缺)' : ''}`
  );
  lines.push(
    `mem→wire/db = \`getDictFromObj(obj)\`(序列化出口)${missing?.has('getDictFromObj') ? '(缺)' : ''}`
  );
  return lines.join('\n');
}

/** Semantics ②: the annotation for PYTHON without an impl (whole-value pickle in/out, no dict conversion). */
export function pythonPickleContractDoc(): string {
  return '裸 PYTHON 属性走整值 pickle 进出,不走 dict 转换,无 createObjFromDict/getDictFromObj 契约。';
}

/**
 * The contract snapshot of a single user_type (for the hover completion face): only
 * that type's impl file is scanned, not a full registry sweep (avoids reading every
 * impl file on each hover).
 * No implementedBy / type not registered → null.
 */
export function userTypeContractStatusForName(
  workspaceRoot: string,
  name: string
): UserTypeContractStatus | null {
  const info = getCustomTypeInfos(workspaceRoot).find(candidate => candidate.name === name);
  if (!info?.implementedBy) {
    return null;
  }
  const implFile = info.pythonFilePath;
  const methods: Record<UserTypeContractMethod, boolean> = {
    createObjFromDict: false,
    getDictFromObj: false,
    isSameType: false
  };
  let implLine: number | undefined;
  if (implFile) {
    const source = readWorkspaceTextFile(implFile);
    for (const method of USER_TYPE_CONTRACT_METHODS) {
      methods[method] = implFileHasContractMethod(source, method);
    }
    implLine = findImplementedBySymbolLine(implFile, info.implementedBy) ?? 1;
  }
  return {
    name: info.name,
    implementedBy: info.implementedBy,
    implFile,
    implLine,
    methods
  };
}

/**
 * The hover contract completion face (② + semantics ①): when a user_type carries an
 * impl, gives the triple-contract method completion status and the bidirectional
 * serialization contract. Each missing-method line states its consequence direction;
 * when all are present, a "complete" line is given.
 */
export function renderUserTypeContractHoverSection(
  status: UserTypeContractStatus
): string {
  const lines: string[] = [];
  lines.push('**user_type 契约(引擎装载要求三方法齐备)**:');
  for (const method of USER_TYPE_CONTRACT_METHODS) {
    const present = status.methods[method];
    lines.push(
      `- \`${method}()\`: ${present ? '✓ 有' : `✗ 缺 —— ${USER_TYPE_CONTRACT_CONSEQUENCE[method]}`}`
    );
  }
  lines.push('');
  lines.push(userTypeSerializationContractDoc(status.implementedBy));
  return lines.join('\n');
}

/**
 * KSEM-STRUCT-06: implementedBy real-shape binding collection (the judgment lives in
 * the implementedByBinding pure core). Candidate discovery follows the real import
 * order: when `module.py` and `module/__init__.py` coexist under the same name, the
 * **package directory wins** (CPython FileFinder prefers packages, settled by local
 * python3 testing); each user_type root produces at most one candidate; coexisting
 * same-named modules across roots are left to the pure core's ruling
 * (ambiguous-module; the in-workspace sys.path order is undecidable).
 * Empty implementedBy → null (no binding face, same threshold as the contract section).
 */
export function implementedByBindingForWorkspace(
  workspaceRoot: string,
  implementedBy?: string
): ImplementedByBinding | null {
  if (!implementedBy?.trim()) {
    return null;
  }
  const moduleName = implementedBy.trim().split('.')[0];
  if (!moduleName) {
    // Malformed values such as non-two-segment ones: no candidates to speak of; hand to the pure core to report malformed honestly
    return resolveImplementedByBinding(implementedBy, []);
  }
  const moduleRel = moduleName.replace(/\./g, '/');
  const candidates: ImplementedByCandidate[] = [];
  for (const root of getDefinitionWorkspaceLayout(workspaceRoot).userTypeRoots) {
    const packageInitPath = nodePath.join(root, moduleRel, '__init__.py');
    if (fs.existsSync(packageInitPath)) {
      candidates.push({ filePath: packageInitPath, source: readWorkspaceTextFile(packageInitPath), kind: 'package' });
      continue; // package wins (a same-root package directory beats a same-named file)
    }
    const filePath = nodePath.join(root, `${moduleRel}.py`);
    if (fs.existsSync(filePath)) {
      candidates.push({ filePath, source: readWorkspaceTextFile(filePath), kind: 'module' });
    }
  }
  return resolveImplementedByBinding(implementedBy, candidates);
}
