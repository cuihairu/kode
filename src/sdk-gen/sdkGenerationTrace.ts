/**
 * SDK 生成物引擎溯源(IDE-SDK-004):生成文件头部记录输入引擎的版本与
 * git 提交,生成物可追溯到输入版本;探测不到时写 unknown 字面量,不猜
 * 不空缺。探测面复用 engineApiMetadata.readEngineApiMetadata(版本宏
 * +git rev-parse,已有 unknown 兜底),本模块只做 trace 归一与头部行
 * 格式化;装配在 extension.ts(有 profile 面,引擎根取 profile 记录)。
 */

export const SDK_ENGINE_TRACE_UNKNOWN = 'unknown';

/** SDK 生成物的引擎溯源:版本与提交,探测不到=unknown 字面量 */
export interface SdkEngineTrace {
  engineVersion: string;
  engineCommit: string;
}

/** 引擎 metadata(探测面返回)归一为 trace:空/缺字段逐字段写 unknown */
export function makeSdkEngineTrace(
  metadata: { version: string; commit: string } | null | undefined
): SdkEngineTrace {
  const value = (field: string | undefined): string =>
    field && field.length > 0 ? field : SDK_ENGINE_TRACE_UNKNOWN;
  return {
    engineVersion: value(metadata?.version),
    engineCommit: value(metadata?.commit)
  };
}

/** 生成物头部的引擎溯源两行(版本/提交各一行,注释前缀) */
export function formatSdkEngineTraceLines(trace: SdkEngineTrace): string[] {
  return [`// 引擎版本: ${trace.engineVersion}`, `// 引擎提交: ${trace.engineCommit}`];
}
