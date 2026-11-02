// GEN-DEF-1e 数据收集半边(读 types.xml/alias.xml + 扫 impl 文件)。
//
// 纯逻辑(判定/定位)在 userTypeContract;本模块只做 I/O 与注册表解析:
// getCustomTypeInfos → 带 implementedBy 的自定义类型 → impl 文件 → 三契约
// 方法存在性快照。序列化契约描述(口径①②)也在此,供 hover/stub 文档复用。

import {
  getCustomTypeInfos,
  findImplementedBySymbolLine,
  readWorkspaceTextFile
} from './definitionWorkspace';
import {
  USER_TYPE_CONTRACT_METHODS,
  USER_TYPE_CONTRACT_CONSEQUENCE,
  type UserTypeContractMethod,
  type UserTypeContractStatus,
  implFileHasContractMethod
} from './userTypeContract';

/**
 * 收集全部 user_type 契约快照(带 implementedBy 的自定义类型;纯 FIXED_DICT/
 * ARRAY 别名无 impl,不进索引——它们不走对象契约,走 dict 形态序列化)。
 * impl 文件解析失败/缺失时 implFile 为空(缺方法诊断静默,由「未找到
 * python 文件」诊断兜底)。
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
 * 序列化契约一句话描述(口径①):wire/db→mem = createObjFromDict(反序列化
 * 入口),mem→wire/db = getDictFromObj(序列化出口)。用于 user_type/带 impl
 * 的 PYTHON 属性 hover 与桩文档。
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

/** 口径②:PYTHON 无 impl 的标注(整值 pickle 进出,不走 dict 转换)。 */
export function pythonPickleContractDoc(): string {
  return '裸 PYTHON 属性走整值 pickle 进出,不走 dict 转换,无 createObjFromDict/getDictFromObj 契约。';
}

/**
 * 单个 user_type 的契约快照(悬停补全面用):只扫该类型的 impl 文件,
 * 不做全量注册表扫描(避免每次 hover 读全部 impl 文件)。
 * 无 implementedBy / 类型未注册 → null。
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
 * 悬停契约补全面(②+口径①):user_type 带 impl 时给出三契约方法补全状态
 * 与双向序列化契约。每个缺方法行标明后果方向;全齐给一行「完整」。
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
