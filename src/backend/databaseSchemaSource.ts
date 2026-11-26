// R2-F24 (IDE-AUD-051): source-access adapter layer for pure schema
// derivation -- the vscode-coupled surface. databaseSchemaCore is
// self-sufficient plain Node (with SchemaSourcePorts injected); this module
// wraps definitionWorkspace file discovery / entity registration and
// sharedFileSnapshot snapshot reads into ports, wired in by
// databaseSchema/entityFlowWebView.
import {
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getRegisteredEntities
} from '../definitionWorkspace';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import type { SchemaSourcePorts } from './databaseSchemaCore';

export function buildSchemaSourcePorts(): SchemaSourcePorts {
  return {
    findDefinitionFileByCategory,
    findEntityDefinitionFile,
    getRegisteredEntities,
    readInputFile: filePath => {
      const snapshot = readSharedFileSnapshot(filePath);
      return snapshot
        ? { content: snapshot.content, source: snapshot.source, version: snapshot.version }
        : null;
    }
  };
}
