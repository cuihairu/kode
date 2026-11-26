/**
 * RPC method CodeLens (batch 126 user order: one cannot tell from a Python
 * implementation which functions are RPCs declared in the .def)
 *
 * Pure logic layer, does not import vscode. Each def declaration line in a
 * Python implementation script is handed to the external resolver to decide
 * whether it hits an entity-def method declaration (the data source is
 * EntityMappingManager's owner-aware method index, same source as the F12
 * reverse jump); only hits produce a CodeLens line, plain functions not declared
 * in the def produce no lens — that is the visual boundary of "which are RPCs".
 * The resolver reply and lens specs are assembled into vscode.CodeLens by
 * languageProviders.
 *
 * Known boundaries (post-narrowing contract): the historical problem of
 * name-only hits not attributing the implementation is mostly contained by the
 * parameter gate — when the def declares <Arg>, the python def line carrying the
 * lens must have the same number of parameters and matching annotated types
 * (the gate itself is
 * EntityMappingManager.pythonSignatureMatchesDeclaredArgs, same source as the
 * project-wide fallback scan); otherwise the line gets no lens; helper functions
 * inside closure scripts that share a name and coincidentally the same signature
 * with some entity def declaration still get a lens (methods without a declared
 * <Arg> keep the name-only match status quo).
 */

import { DefMethodSection } from './defParser';

/** Parsed def declaration line (position contract without a vscode dependency) */
export interface PythonMethodDeclaration {
  /** Document line (0-based) */
  line: number;
  /** Start column of the method name within the declaration line (0-based) */
  character: number;
  methodName: string;
}

/** One def method declaration hit (the minimum face CodeLens display and jump need) */
export interface RpcMethodHit {
  methodName: string;
  section: DefMethodSection;
  /** The def file where it is declared */
  defFile: string;
  /** Declaration line (1-based, same contract as entityMapping's EntityMethodDefinitionLocation) */
  defLine: number;
  /** Declared Exposed (requestable by the client) */
  exposed: boolean;
}

/** Assembly spec of one CodeLens line (the provider layer builds vscode.CodeLens from it) */
export interface RpcCodeLensSpec {
  declaration: PythonMethodDeclaration;
  hit: RpcMethodHit;
  title: string;
}

/** Python method declaration: `def name(` and `async def name(`, arbitrary leading indent allowed */
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

/** Lens title: `RPC · <section>`, followed by the Exposed flag and the source def name */
export function defaultRpcCodeLensTitle(hit: RpcMethodHit): string {
  const exposure = hit.exposed ? ' · Exposed' : '';
  // The def path may come from a Windows project (`\` separators); take the basename by both separators
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
