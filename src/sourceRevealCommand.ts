/**
 * 源码 reveal 命令 id(IDE-ARC-001 抽离):eventApi/generatedSourceLenses
 * 等低层消费者此前为取这一个常量反向 import 整个 languageProviders,
 * 常量搬到本模块切断该依赖边。命令语义(自建打开链,showTextDocument 带
 * selection 后显式 revealRange,后退后再点也强制滚回——批159)仍在
 * languageProviders 的 revealSourceCommand 实现处。
 */
export const KBENGINE_SOURCE_REVEAL_COMMAND = 'kbengine.source.reveal';
