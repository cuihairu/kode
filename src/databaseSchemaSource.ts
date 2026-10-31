// R2-F24(IDE-AUD-051):schema 纯推导的源访问适配层——vscode 耦合面。
// databaseSchemaCore 自足普通 Node(经 SchemaSourcePorts 注入),本模块把
// definitionWorkspace 文件发现/实体登记与 sharedFileSnapshot 快照读取包装
// 成端口,由 databaseSchema/entityFlowWebView 装配传入。
import {
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getRegisteredEntities
} from './definitionWorkspace';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
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
