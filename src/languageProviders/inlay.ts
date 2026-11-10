// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { EntityMappingManager } from '../entityMapping';
import { getDocumentLines } from '../backend/documentStore';
import { hasKnownEntityBuiltinPropertyType, resolveEntityComponentFaceFromPath, collectEntityBuiltinPropertyInlayTargets, type EntityComponentFace } from '../backend/entityBuiltinProperties';
import { getLanguageFeatureConfig } from './shared';
import { diffInferredAnnotations } from '../backend/inferredEnrichment';
import { readInferredMirrorText } from '../inferredMirrorLookup';
import {
  PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT,
  propertyDirectionShadowHintItemsAsync,
  type PropertyDirectionHit
} from '../backend/propertyDirectionDiagnostics';
import { buildPropertyDirectionScanBundleWithRust } from '../backend/propertyDirectionRust';
/**
 * 内建属性行内类型提示(用户令 2026-10-21 形态升级单 ③):实体脚本内单段
 * `self.<内建属性>` 访问处在其 range 之后渲染 `: <type>` 右对齐提示
 * (kind=Type);面判定与命中集合和 hover 同一底座
 * (resolveEntityComponentFaceFromPath / getEntityComponentFacesForPythonFile /
 * resolveEntityBuiltinPropertyHit)。开关 kbengine.python.builtinTypeInlayHints
 * (默认开)且受总闸 kbengine.entity.builtinProperties 双控,false 即不给
 * 提示;provider 每次现读配置,下一次渲染即生效(inlay 无变更事件可 fire)。
 */
export class KBEngineBuiltinTypeInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    const featureConfig = getLanguageFeatureConfig();
    if (!featureConfig.entityBuiltinProperties || !featureConfig.entityBuiltinTypeInlayHints) {
      return [];
    }
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    let defFaces: readonly EntityComponentFace[] | null = null;
    if (!pathFace) {
      if (!this.entityMappingManager) {
        return [];
      }
      try {
        defFaces = await this.entityMappingManager.getEntityComponentFacesForPythonFile(
          document.fileName
        );
      } catch {
        defFaces = null;
      }
    }
    // PR2 快照接入:行数组走 documentStore(同版本复用,不再逐次全文拆行)
    const lines = getDocumentLines(document);
    return collectEntityBuiltinPropertyInlayTargets(lines, pathFace, defFaces)
      // inlay 按可视区要:视图口外的访问行不出 hint(批154 同口径);
      // Any 位(未知)按「能推才显」闸整个不出 hint(无提示降级)
      .filter(target => hasKnownEntityBuiltinPropertyType(target.property))
      .filter(target => target.line >= range.start.line && target.line <= range.end.line)
      .map(
        target =>
          new vscode.InlayHint(
            new vscode.Position(target.line, target.endCharacter),
            `: ${target.property.type}`,
            vscode.InlayHintKind.Type
          )
      );
  }
}

/**
 * KODE-CFG-017-R 推断镜像行内提示：源行缺注解而 `.kbengine/inferred` 副本
 * 同行有 pyrefly 注解处（形参/返回/赋值）原位渲染 `: <type>` / `-> <type>`
 * (kind=Type)。开关复用 kbengine.infer.enabled（镜像生产总闸——停管线即无
 * 新鲜镜像,提示随之关）；副本缺失/读失败/行数漂移整批静默空(diffInferred-
 * Annotations 宁缺毋错)。副本只读,绝不进 extraPaths/导入解析(T-04)。
 */
export class InferredMirrorTypeInlayHintsProvider implements vscode.InlayHintsProvider {
  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.InlayHint[] {
    if (document.languageId !== 'python') {
      return [];
    }
    const inferEnabled = vscode.workspace
      .getConfiguration('kbengine')
      .get<boolean>('infer.enabled', true);
    if (!inferEnabled) {
      return [];
    }
    const mirrorText = readInferredMirrorText(document.fileName);
    if (!mirrorText) {
      return [];
    }
    return diffInferredAnnotations(document.getText(), mirrorText)
      .filter(hint => hint.line >= range.start.line && hint.line <= range.end.line)
      .map(
        hint =>
          new vscode.InlayHint(
            new vscode.Position(hint.line, hint.character),
            hint.label,
            vscode.InlayHintKind.Type
          )
      );
  }
}

/**
 * cellData 复制属性提示(2026-11-10 用户报障收编):base 侧
 * self.y = self.cellData["x"](__init__ 里取值)声明的 y 是 cell 侧 def 字段
 * x 的副本——赋值行与裸访问处渲染淡色小字「复制属性 x: <type> · <domains>」;
 * self.cellData["key"] 处渲染 key 的 def 面(key: <type> · <domains>,域位
 * 不含 cell 追加「不在 cellData」)。分析核与方向违规诊断同源
 * (propertyDirectionDiagnostics,预解析去重同口径);提示流永不下划线
 * (用户令「不要下划线,很容易以为是错误」),颜色=主题 inlay 色(淡)。
 * 开关 kbengine.inlayHints.propertyShadow(默认开)且受总闸
 * kbengine.propertyDirectionDiagnostics 双控(分析关即无提示),provider
 * 现读配置下一次渲染即生效。
 */
export class KBEnginePropertyShadowInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (document.languageId !== 'python') {
      return [];
    }
    const config = vscode.workspace.getConfiguration('kbengine');
    if (!config.get<boolean>('propertyDirectionDiagnostics', PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT)) {
      return [];
    }
    if (!config.get<boolean>('inlayHints.propertyShadow', true)) {
      return [];
    }
    const resolve = async (
      propertyPath: string,
      rootSymbol: string
    ): Promise<PropertyDirectionHit | null | undefined> => {
      if (!this.entityMappingManager) {
        return null;
      }
      try {
        const info = await this.entityMappingManager.resolvePropertyDefinitionInfo(
          document.uri.fsPath,
          propertyPath,
          rootSymbol
        );
        if (!info) {
          return null;
        }
        return {
          propertyName: info.identity.symbolName,
          domains: info.domains,
          defFile: info.defFile,
          defLine: info.line,
          typeName: info.typeName
        };
      } catch {
        return null;
      }
    };
    const items = await propertyDirectionShadowHintItemsAsync(
      document.getText(),
      document.uri.fsPath,
      resolve,
      true,
      // AUDIT-005 B2 批 7:Rust-first 三扫描束(与诊断流同一判定核),束不可用回本地扫描
      (await buildPropertyDirectionScanBundleWithRust(document.getText())) ?? undefined
    );
    return items
      // inlay 按可视区要:视图口外的行不出 hint(批154 同口径)
      .filter(item => item.position.line >= range.start.line && item.position.line <= range.end.line)
      .map(item => {
        const hint = new vscode.InlayHint(
          new vscode.Position(item.position.line, item.position.character),
          item.label,
          vscode.InlayHintKind.Type
        );
        hint.tooltip = new vscode.MarkdownString(item.tooltip);
        hint.paddingLeft = true;
        return hint;
      });
  }
}
