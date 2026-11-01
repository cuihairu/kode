import { parentPort } from 'worker_threads';
import { parseDefDocument, type DefDocument } from './defParser';

// IDE-REV-039:def XML 解析 worker 入口——宿主线程之外解析单文件大 def
// (vendor fast-xml-parser 整块 opaque 不可内部 yield,≥12k 行实测 95-185ms)。
// worker 独立 bundle 持有自己的 parsedDocumentCache 实例(module-level,
// defParser.ts:32),宿主导出缓存不参与;回传的 DefDocument 是纯 plain object
// 图(parent/document 回引成环),structured clone 支持环与共享引用,内部同一性
// (node.document === document)克隆后保持。

interface ParseRequest {
  id: number;
  text: string;
}

export interface DefParseReply {
  id: number;
  document?: DefDocument;
  error?: string;
}

parentPort?.on('message', (request: ParseRequest) => {
  try {
    parentPort?.postMessage({ id: request.id, document: parseDefDocument(request.text) });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
