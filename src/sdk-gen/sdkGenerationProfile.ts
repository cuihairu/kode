/**
 * SDK 生成绑定目标 profile(IDE-SDK-003):SDK 生成的输入面(实体注册
 * 清单与类型数据)全部取自所选 profile 根——注册顺序=该根 entities.xml
 * 的登记序(解析复用 definitionWorkspace.getRegisteredEntities,含分节
 * 与首条保留口径),类型原文=该根 types.xml;其他根的同名实体绝不覆盖
 * 所选根(逐个点名拒收),其他根独有的实体也不混入注册。IO 全注入,装
 * 配在 extension.ts。
 */

/** 单实体注册:名字+在所选根 entities.xml 中的登记序(0 起) */
export interface EntityRegistration {
  name: string;
  order: number;
}

export interface SdkGenerationBinding {
  /** 注册清单:只来自所选根,按 entities.xml 登记序 */
  registrations: EntityRegistration[];
  /** 所选根 types.xml 原文;null=该根缺 types.xml(如实,不猜) */
  typesXml: string | null;
  /** 其他根与所选根同名的实体名(拒收不覆盖,逐个点名);字典序 */
  skippedSameNameFromOtherRoots: string[];
}

export interface SdkGenerationProfileDeps {
  /** 所选根 entities.xml 的登记序(装配=getRegisteredEntities,缺文件=[]) */
  listRegistrations(profileRoot: string): Array<{ name: string }>;
  /** 读所选根 types.xml 原文;null=缺失 */
  readTypesXml(profileRoot: string): string | null;
  /** 其他根登记的实体名(用于同名覆盖检测) */
  listOtherRootEntityNames(profileRoot: string): string[];
}

export function bindSdkGenerationToProfile(
  profileRoot: string,
  deps: SdkGenerationProfileDeps
): SdkGenerationBinding {
  const registrations: EntityRegistration[] = deps
    .listRegistrations(profileRoot)
    .map((registration, order) => ({ name: registration.name, order }));
  const registeredNames = new Set(registrations.map(reg => reg.name));
  const skippedSameNameFromOtherRoots = [
    ...new Set(deps.listOtherRootEntityNames(profileRoot))
  ]
    .filter(name => registeredNames.has(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    registrations,
    typesXml: deps.readTypesXml(profileRoot),
    skippedSameNameFromOtherRoots
  };
}
