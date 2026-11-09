// GEN-DEF-1e:user_type 三契约索引与缺方法诊断的纯逻辑半边。
//
// 引擎语义(datatype.cpp FixedDictType::setImplModule L2383-2397):实现对象
// 必须同时具备 createObjFromDict / getDictFromObj / isSameType 三个属性,
// 任一缺失经 PyObject_GetAttrString 取不到 → SCRIPT_ERROR_CHECK + return
// false,模块装载失败(引擎启动/实体加载必炸)。本模块只做判定与定位
// (纯函数,无 vscode 依赖);数据收集(读 types.xml / 扫 impl 文件)在
// userTypeContractSource,诊断接线在 extension。
//
// 口径补充(用户令 2026-11-02 数据流方向具体体现):
//  - 每个契约方法缺失的文案写明后果方向——缺 createObjFromDict = 无法从
//    网络/DB 构造(反序列化入口);缺 getDictFromObj = 无法写网络/持久化
//    (序列化出口);缺 isSameType = 类型判定失效。
//  - 序列化契约(口径①):wire/db→mem = createObjFromDict(反序列化入口),
//    mem→wire/db = getDictFromObj(序列化出口)——文档/hover 侧表述见
//    userTypeContractSource 的序列化契约描述函数。

/** 三个契约方法,引擎 setImplModule 逐个 GetAttrString 取(顺序即声明序)。 */
export const USER_TYPE_CONTRACT_METHODS = [
  'createObjFromDict',
  'getDictFromObj',
  'isSameType'
] as const;

export type UserTypeContractMethod = (typeof USER_TYPE_CONTRACT_METHODS)[number];

/** 诊断 code:user_type 实现类缺契约方法(引擎装载必炸)。惯例 kbengine.<camelCase>。 */
export const USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE =
  'kbengine.userTypeContractMethodMissing';

/**
 * 口径③:每个契约方法缺失的后果方向文案。写入诊断消息与 hover 补全面,
 * 与 datatype.cpp 的调用语义一一对应(impl_createObjFromDict 调用
 * createObjFromDict 后过 isSameType;impl_getDictFromObj 调用 getDictFromObj)。
 */
export const USER_TYPE_CONTRACT_CONSEQUENCE: Record<UserTypeContractMethod, string> = {
  createObjFromDict: '无法从网络/DB 构造该类型(反序列化入口缺失)',
  getDictFromObj: '无法写网络/持久化该类型(序列化出口缺失)',
  isSameType: '类型判定失效(createObjFromDict 结果无法通过校验)'
};

/**
 * 一个 user_type 的契约方法存在性快照。methods 值来自对 impl 文件源码的
 * 静态扫描(implFileHasContractMethod);impl 文件缺失时三项皆 false 且
 * implLine 为 null——该情形另有「user_type 未找到 python 文件」诊断兜底,
 * 此处不再重复报缺方法。
 */
export interface UserTypeContractStatus {
  /** user_type 名(types.xml/alias.xml 注册名)。 */
  name: string;
  /** implementedBy 原文(module.Symbol;引擎按 '.' 拆两段)。 */
  implementedBy?: string;
  /** impl python 文件路径(已按 userTypeRoots 解析到存在文件)。 */
  implFile?: string;
  /** impl 符号定义行(1 基;findImplementedBySymbolLine 口径;找不到为 1)。 */
  implLine?: number;
  /** 各契约方法在 impl 文件是否存在。 */
  methods: Record<UserTypeContractMethod, boolean>;
}

/** 缺方法诊断项(定位在 impl 文件符号行;接线侧转 vscode.Diagnostic)。 */
export interface UserTypeContractMissingItem {
  message: string;
  method: UserTypeContractMethod;
  /** 用户类型名(诊断 message 复用/测试断言)。 */
  typeName: string;
  /** 定位符号名(implementedBy 后段;回退类型名)。 */
  symbolName: string;
  /** 定位符号长度(诊断 range 宽度)。 */
  symbolLength: number;
  /** 关联目标(types.xml 实现声明行)。 */
  related: { targetFile: string; label: string };
}

/** 在 impl 文件原文里查一个契约方法是否定义(file 级扫描;类方法/实例赋值
 *  形态皆覆盖——引擎经模块属性拿对象后取方法,定义在实现模块内即可见)。 */
export function implFileHasContractMethod(source: string, method: string): boolean {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*def[ \\t]+${escaped}[ \\t]*\\(`, 'm').test(source);
}

/** 符号名 = implementedBy 后段(引擎 GetAttrString 取后段);缺省回退类型名。 */
export function contractSymbolName(status: UserTypeContractStatus): string {
  const parts = status.implementedBy?.trim().split('.') ?? [];
  const last = parts.length > 0 ? parts[parts.length - 1] : '';
  return last || status.name;
}

/**
 * 收集单个 user_type 的缺方法记录(纯函数;状态来自快照,无 I/O)。
 * 每个缺失方法产出一条(口径③后果方向各自不同,分开呈现比合并更精确);
 * 实现文件缺失(implFile 为空)时静默——由「user_type 未找到 python 文件」
 * 诊断兜底,不重复报。
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

/** 按 impl 文件聚合缺方法诊断(定位行 1 基;文件路径按 resolve 归一比对)。 */
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
