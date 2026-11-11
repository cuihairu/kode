// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as fs from 'fs';
import * as vscode from 'vscode';
import { EntityMappingManager, pythonScriptDomain } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
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
 * x 的副本——赋值行与裸访问处渲染淡色小字「复制属性 x: <type> · cell」;
 * self.cellData["key"] 处渲染 key 的 def 面(key: <type> · cell,域位不含
 * cell 追加「不在 cellData」)。标签只显 cell 面(2026-11-11 用户令:base
 * 侧读到的就是 cell 侧那份,裸并集是噪音),完整域位并集留悬停全文。
 * 分析核与方向违规诊断同源(propertyDirectionDiagnostics,预解析去重同
 * 口径);提示流永不下划线(用户令「不要下划线,很容易以为是错误」),
 * 颜色=主题 inlay 色(淡);带 def 落点的 hint 经 InlayHintLabelPart.location
 * 出导航(Ctrl+点击直达 def 声明行,与非复制提示一致,用户令「复制属性
 * 提示也是导航保持和非复制一致」)。开关 kbengine.inlayHints.propertyShadow(默认开)且受
 * 总闸 kbengine.propertyDirectionDiagnostics 双控(分析关即无提示),
 * provider 现读配置下一次渲染即生效。
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
        // 导航面与非复制提示一致(用户令「复制属性提示也是导航保持和非复制
        // 一致」):vscode.InlayHint 类无 location 字段,扩展 API 的导航惯用
        // 法是 label part——part.location 让 Ctrl+点击直达 def 声明行。
        if (item.location) {
          const part = new vscode.InlayHintLabelPart(item.label);
          part.location = new vscode.Location(
            vscode.Uri.file(item.location.uri),
            new vscode.Position(item.location.line, 0)
          );
          hint.label = [part];
        }
        return hint;
      });
  }
}

/**
 * Proxy 内部属性提示(批 ③,用户令 2026-11-11:「proxy 的 __ACCOUNT_NAME__
 * __ACCOUNT_PASSWORD__ 没有作为内部属性提示…需要提示为内部属性之类的,跳转
 * 到 对应的pyi中」):实体脚本内 `self.__ACCOUNT_NAME__`/`self.__ACCOUNT_PASSWORD__`
 * 访问处其后渲染「内部属性 · Proxy」淡色小字;项目桩包 KBEngine/Proxy.pyi 在
 * 盘时经 InlayHintLabelPart.location 出导航(Ctrl+点击直达属性声明行,与复制
 * 属性提示同一惯用法)。内部属性本身已在模板 Proxy.pyi 声明(名字表
 * entitydef/common.h:142-143,注入点 server/baseapp/baseapp.cpp:4241-4246),
 * Pylance 补全由桩面承担;本 provider 补的是「这是内部属性」的现场标识与
 * 跳转。行号现场扫描项目副本——副本可被用户魔改,钉死行号必漂。开关
 * kbengine.python.proxyInternalAttrHints(默认开),provider 现读配置下一次
 * 渲染即生效。
 */
export const PROXY_INTERNAL_ATTR_HINTS_SETTING = 'python.proxyInternalAttrHints';
const PROXY_INTERNAL_ATTR_NAMES = ['__ACCOUNT_NAME__', '__ACCOUNT_PASSWORD__'] as const;
export const PROXY_INTERNAL_PYE_FILE_NAME = 'Proxy.pyi';

export interface ProxyInternalAttrHintDeps {
  /** 项目内桩包 Proxy.pyi 绝对路径;null=桩未复制(只出标签,不出导航) */
  resolveProxyPyiPath: (document: vscode.TextDocument) => string | null;
  /** 读项目副本(测试注入;缺省真 fs) */
  readFile?: (path: string) => string;
}

export class KBEngineProxyInternalAttrHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly deps?: ProxyInternalAttrHintDeps) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (document.languageId !== 'python') {
      return [];
    }
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>(PROXY_INTERNAL_ATTR_HINTS_SETTING, true)) {
      return [];
    }
    // 只在 demo 资产脚本域(scripts/base|cell|client|bots)内提示;目录按资产
    // 层认,引擎进程名不是目录名(2026-11-11 用户令两层名不得混称)
    if (pythonScriptDomain(document.uri.fsPath) === null) {
      return [];
    }
    // 项目副本在盘才出导航;副本是用户可改面,声明行现场扫描,钉死必漂
    const pyiPath = this.deps?.resolveProxyPyiPath(document) ?? null;
    const declarationLines: Partial<Record<typeof PROXY_INTERNAL_ATTR_NAMES[number], number>> = {};
    if (pyiPath) {
      try {
        const content = (this.deps?.readFile ?? ((candidate: string): string => fs.readFileSync(candidate, 'utf8')))(pyiPath);
        const lines = content.split('\n');
        for (const attr of PROXY_INTERNAL_ATTR_NAMES) {
          const index = lines.findIndex(line => line.trim() === `${attr}: str`);
          if (index >= 0) {
            declarationLines[attr] = index;
          }
        }
      } catch {
        // 副本读不到(权限等):导航面缺位,标签照出
      }
    }
    const regex = /\bself\.(__ACCOUNT_NAME__|__ACCOUNT_PASSWORD__)\b/g;
    const text = document.getText();
    const hints: vscode.InlayHint[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const attr = match[1] as typeof PROXY_INTERNAL_ATTR_NAMES[number];
      const position = document.positionAt(match.index + match[0].length);
      // inlay 按可视区要:视图口外的行不出 hint(同属性影提示口径)
      if (position.line < range.start.line || position.line > range.end.line) {
        continue;
      }
      const part = new vscode.InlayHintLabelPart(`${l10nText('internal attribute')} · Proxy`);
      const declarationLine = declarationLines[attr];
      if (pyiPath && declarationLine !== undefined) {
        part.location = new vscode.Location(
          vscode.Uri.file(pyiPath),
          new vscode.Position(declarationLine, 0)
        );
      }
      part.tooltip = new vscode.MarkdownString(
        '由 baseapp 在登录成功后注入的内部属性,脚本只读,勿赋值。\n' +
        'Internal attribute injected by baseapp on successful login; read-only from scripts.'
      );
      const hint = new vscode.InlayHint(position, [part]);
      hints.push(hint);
    }
    return hints;
  }
}
