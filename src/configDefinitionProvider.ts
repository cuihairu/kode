/**
 * KSEM-CFG-06 配置来源跳转 provider(vscode 适配层)。
 *
 * 纯核心在 src/backend/configSourceFace.ts(路径解析/行定位);本壳把配置
 * XML 文档里的配置 key 跳转到两处:
 *  - schema/默认声明:kbengine_defaults.xml 里该路径的首现开标签行;
 *  - 生效值:最终配置虚拟文档(kbengine-config:/kbengine-final.xml,defaults
 *    与元件 kbengine.xml 合成)里该路径的行。
 *
 * 选择器与配置补全/悬停同源(kbengine*.xml,含虚拟文档);纯读,无开关
 * (跟随 kbengine.hover.serverConfig 的文档面语义,不新增设置)。当前文档
 * 即目标时不重复给自身位置。
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CONFIG_COMPLETION_SELECTORS } from './configCompletionProvider';
import { configPathAtText, configDeclarationLine } from './backend/configSourceFace';
import { buildConfigTreePair, buildFinalServerConfig, KBE_CONFIG_SCHEME, KBE_CONFIG_VIRTUAL_PATH } from './serverConfigMerge';

const FINAL_CONFIG_URI = vscode.Uri.parse(`${KBE_CONFIG_SCHEME}:${KBE_CONFIG_VIRTUAL_PATH}`);

export class ConfigDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Definition> {
    const path = configPathAtText(document.getText(), document.offsetAt(position));
    if (path === null) {
      return null;
    }
    const locations: vscode.Location[] = [];
    const pair = buildConfigTreePair();

    // schema/默认声明:defaults 原文行(找不到/读不到则不给,不猜)
    if (pair.defaultsPath !== null) {
      try {
        const defaultsText = fs.readFileSync(pair.defaultsPath, 'utf8');
        const line = configDeclarationLine(defaultsText, path);
        if (line !== null) {
          const target = vscode.Uri.file(pair.defaultsPath);
          if (target.fsPath !== document.uri.fsPath) {
            locations.push(new vscode.Location(target, new vscode.Range(line - 1, 0, line - 1, 0)));
          }
        }
      } catch {
        // defaults 读不到:跳过该目标
      }
    }

    // 生效值:最终配置虚拟文档行(合成渲染文)
    const finalText = buildFinalServerConfig().text;
    if (finalText.length > 0 && document.uri.toString() !== FINAL_CONFIG_URI.toString()) {
      const line = configDeclarationLine(finalText, path);
      if (line !== null) {
        locations.push(new vscode.Location(FINAL_CONFIG_URI, new vscode.Range(line - 1, 0, line - 1, 0)));
      }
    }

    return locations.length > 0 ? locations : null;
  }
}

/** 注册选择器(与补全同源的配置 XML 文档面) */
export const CONFIG_DEFINITION_SELECTORS = CONFIG_COMPLETION_SELECTORS;
