import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveEntityAnnotationType } from '../src/definitionWorkspace';
import { getSemanticIndex, resetSemanticTypeRegistryForTests } from '../src/semanticIndex';
import { workspace } from './fake-vscode/workspaceState';

// IDE-SNP-004:类型注册表接收脏 types.xml 更新——未保存别名修改进注册表,
// 且只使依赖该文件的注册表快照失效(其他根的快照不动)。

const temporaryDirectories: string[] = [];

function makeRegistryRoot(prefix: string, typesXml: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), typesXml, 'utf8');
  return root;
}

const TYPES_XML_WITH_ALIAS = '<root>\n  <GOLD_UID>UINT32</GOLD_UID>\n</root>\n';
const TYPES_XML_EMPTY = '<root>\n</root>\n';

afterEach(() => {
  workspace.textDocuments = [];
  resetSemanticTypeRegistryForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('IDE-SNP-004:类型注册表接收脏 types.xml 更新', () => {
  it('未保存别名修改进注册表:脏缓冲新增别名后查询即解析', () => {
    const root = makeRegistryRoot('kode-snp4-', TYPES_XML_EMPTY);
    // 磁盘版无别名 → 占位回落 Any,并已把磁盘版快照建入注册表
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('Any');

    // 打开的脏缓冲新增别名 GOLD_UID → UINT32
    const typesPath = path.join(root, 'scripts/entity_defs/types.xml');
    workspace.textDocuments = [{
      uri: { toString: () => `file://${typesPath}`, fsPath: typesPath },
      version: 6,
      getText: () => TYPES_XML_WITH_ALIAS
    }];
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('int');
  });

  it('关闭脏文档后下一次查询恢复磁盘版本(不再用脏快照)', () => {
    const root = makeRegistryRoot('kode-snp4-close-', TYPES_XML_EMPTY);
    const typesPath = path.join(root, 'scripts/entity_defs/types.xml');
    workspace.textDocuments = [{
      uri: { toString: () => `file://${typesPath}`, fsPath: typesPath },
      version: 3,
      getText: () => TYPES_XML_WITH_ALIAS
    }];
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('int');
    workspace.textDocuments = [];
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('Any');
  });

  it('只失效依赖该文件的快照:其他根的注册表快照对象原样保留', () => {
    const rootA = makeRegistryRoot('kode-snp4-a-', TYPES_XML_EMPTY);
    const rootB = makeRegistryRoot('kode-snp4-b-', TYPES_XML_EMPTY);
    // 两个根各自建好快照
    resolveEntityAnnotationType(rootA, 'GOLD_UID');
    resolveEntityAnnotationType(rootB, 'GOLD_UID');
    const snapshotBBefore = getSemanticIndex().getTypeRegistrySnapshot(rootB, true);

    const typesPathA = path.join(rootA, 'scripts/entity_defs/types.xml');
    workspace.textDocuments = [{
      uri: { toString: () => `file://${typesPathA}`, fsPath: typesPathA },
      version: 9,
      getText: () => TYPES_XML_WITH_ALIAS
    }];
    expect(resolveEntityAnnotationType(rootA, 'GOLD_UID')).toBe('int');

    // rootB 的快照未被 rootA 的脏更新波及(对象同一,未重建)
    expect(getSemanticIndex().getTypeRegistrySnapshot(rootB, true)).toBe(snapshotBBefore);
  });
});
