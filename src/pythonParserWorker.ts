import { parentPort } from 'worker_threads';
import { parsePythonFile } from './pythonParser';

interface ParseRequest {
  id: number;
  filePath: string;
  content: string;
  revision: number;
}

parentPort?.on('message', (request: ParseRequest) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      revision: request.revision,
      parsed: parsePythonFile(request.content, request.filePath)
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      revision: request.revision,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
