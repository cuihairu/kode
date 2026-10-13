/**
 * RPC 方法标记(批126 用户令:Python 实现里看不出哪些函数是 def 声明的 RPC)
 *
 * 纯逻辑层,不 import vscode。Python 实现脚本里每个 def 声明行交给外部
 * 解析器判定是否命中实体 def 的方法声明(数据源 EntityMappingManager 的
 * owner-aware 方法索引,与 F12 反向跳转同源);命中才产出一行 CodeLens,
 * 未在 def 声明的普通函数不出 lens——这就是"哪些是 RPC"的视觉分界。
 * 解析回包与 lens 规格交 languageProviders 装配成 vscode.CodeLens。
 *
 * 已知边界:同名命中不分实现归属。闭包脚本(父类/接口实现)里恰好与某实体
 * def 声明同名的辅助函数也会出 lens;解析器只回答"该名字是不是 def 声明的
 * 方法",不回答"这一行是不是它的实现"。
 */

import { DefMethodSection } from './defParser';

/** def 声明行解析结果(不依赖 vscode 的位置口径) */
export interface PythonMethodDeclaration {
  /** 文档行(0 起) */
  line: number;
  /** 方法名在声明行内的起始列(0 起) */
  character: number;
  methodName: string;
}

/** 一个 def 方法声明命中(CodeLens 展示与跳转所需的最小面) */
export interface RpcMethodHit {
  methodName: string;
  section: DefMethodSection;
  /** 声明所在 def 文件 */
  defFile: string;
  /** 声明行(1 起,与 entityMapping 的 EntityMethodDefinitionLocation 同口径) */
  defLine: number;
  /** 声明为 Exposed(客户端可请求) */
  exposed: boolean;
}

/** 一行 CodeLens 的装配规格(provider 层据此构造 vscode.CodeLens) */
export interface RpcCodeLensSpec {
  declaration: PythonMethodDeclaration;
  hit: RpcMethodHit;
  title: string;
}

/** Python 方法声明:`def name(` 与 `async def name(`,行首允许任意缩进 */
export const METHOD_DECLARATION_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

export function findPythonMethodDeclarations(text: string): PythonMethodDeclaration[] {
  const declarations: PythonMethodDeclaration[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = METHOD_DECLARATION_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const methodName = match[1];
    declarations.push({ line: index, character: line.indexOf(methodName), methodName });
  }

  return declarations;
}

/** lens 标题:`RPC · <区块>`,声明为 Exposed 与来源 def 名分列其后 */
export function defaultRpcCodeLensTitle(hit: RpcMethodHit): string {
  const exposure = hit.exposed ? ' · Exposed' : '';
  // def 路径可能来自 Windows 工程(`\` 分隔),按两种分隔符取 basename
  const segments = hit.defFile.split(/[\\/]/);
  return `RPC · ${hit.section}${exposure} · ${segments[segments.length - 1]}`;
}

export function buildRpcCodeLenses(
  declarations: PythonMethodDeclaration[],
  resolve: (methodName: string) => RpcMethodHit | null | undefined
): RpcCodeLensSpec[] {
  const specs: RpcCodeLensSpec[] = [];

  for (const declaration of declarations) {
    const hit = resolve(declaration.methodName);
    if (!hit) {
      continue;
    }
    specs.push({ declaration, hit, title: defaultRpcCodeLensTitle(hit) });
  }

  return specs;
}
