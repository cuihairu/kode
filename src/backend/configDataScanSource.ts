import { readFileUtf8Recorded } from './fileReadMetrics';

/**
 * 配置数据诊断全扫的取文策略(2026-11-24 Navigation 刷屏修复)。
 *
 * 禁止 openTextDocument:逐文件 open 会触发 onDidOpenTextDocument,
 * openWatcher 对每个 py 排单档诊断+导航预热,800ms 防抖又排一轮全扫——
 * 扫描自己给自己供弹(49 文件样本=两轮全扫,Navigation 一次 466 行)。
 * 已开档读缓冲(所见即所诊,含未保存改动),未开档走共享原文缓存直读盘;
 * 盘读剥 BOM(文档面 getText 无 BOM,保持既有行列/正则口径一致)。
 */
interface ScanUri {
  readonly fsPath: string;
  toString(): string;
}

interface ScanDocument {
  readonly uri: { toString(): string };
  getText(): string;
}

export async function readConfigScanSourceText(
  uri: ScanUri,
  textDocuments: readonly ScanDocument[]
): Promise<string> {
  const uriString = uri.toString();
  const opened = textDocuments.find(document => document.uri.toString() === uriString);
  const text = opened ? opened.getText() : await readFileUtf8Recorded(uri.fsPath);
  return text.replace(/^\uFEFF/, '');
}
