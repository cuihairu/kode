// Cross-file semantic graph for .def properties and methods.
// Reuses the engine-aligned rename parser so graph consumers and F2 edits
// share one definition of declarations, references and inheritance edges.
import * as fs from 'fs';
import * as path from 'path';
import {
  collectRenameEditsInText,
  DefRenameSymbolKind,
  findEntityDefsRootFromFile,
  getTagNameRangeForGraph,
  parseDefFileSemantics
} from './defRenamer';
import {
  DefMethodSection,
  DefDocument,
  DefElementNode,
  getDirectChildElements,
  getLineNumberAt,
  parseDefDocument
} from './defParser';

export interface DefSymbolDeclaration {
  readonly filePath: string;
  readonly ownerName: string;
  readonly ownerCategory: 'entity' | 'interface' | 'component';
  readonly kind: DefRenameSymbolKind;
  readonly name: string;
  readonly section: DefMethodSection | null;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface DefSymbolReference {
  readonly filePath: string;
  readonly sourceOwner: string;
  readonly targetOwner: string;
  readonly relation: 'inherit' | 'interface' | 'component';
  readonly kind: DefRenameSymbolKind;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface DefSymbolEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: DefSymbolReference['relation'];
  readonly references: DefSymbolReference[];
}

export interface DefReferenceGraph {
  readonly definitions: DefSymbolDeclaration[];
  readonly edges: DefSymbolEdge[];
  readonly references: DefSymbolReference[];
  readonly issues: DefSemanticIssue[];
}

export type DefSemanticSeverity = 'error' | 'warning' | 'info';
export type DefSemanticIssueCode =
  | 'dangling-parent'
  | 'dangling-interface'
  | 'dangling-component'
  | 'duplicate-symbol';

export interface DefSemanticIssue {
  readonly code: DefSemanticIssueCode;
  readonly severity: DefSemanticSeverity;
  readonly filePath: string;
  readonly line: number;
  readonly name: string;
  readonly message: string;
}

interface FileEntry {
  readonly filePath: string;
  readonly ownerName: string;
  readonly category: 'entity' | 'interface' | 'component';
  readonly content: string;
  readonly document: DefDocument;
  readonly semantics: NonNullable<ReturnType<typeof parseDefFileSemantics>>;
}

interface Link {
  readonly source: FileEntry;
  readonly target: FileEntry;
  readonly relation: DefSymbolReference['relation'];
}

const METHOD_SECTIONS = new Set(['BaseMethods', 'CellMethods', 'ClientMethods']);

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseDef(content: string): DefDocument | null {
  try {
    return parseDefDocument(content);
  } catch {
    return null;
  }
}

function classify(defsRoot: string, filePath: string): FileEntry['category'] {
  const relative = path.relative(defsRoot, filePath).split(path.sep);
  if (relative.includes('interfaces')) return 'interface';
  if (relative.includes('components')) return 'component';
  return 'entity';
}

function listDefFiles(defsRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(fullPath);
      else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.def')) files.push(fullPath);
    }
  };
  walk(defsRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function declarationNodes(
  document: DefDocument
): Array<{ node: DefElementNode; kind: DefRenameSymbolKind; section: DefMethodSection | null }> {
  const root = document.root;
  if (!root) return [];
  const result: Array<{ node: DefElementNode; kind: DefRenameSymbolKind; section: DefMethodSection | null }> = [];
  for (const section of getDirectChildElements(root)) {
    if (section.name === 'Properties') {
      for (const node of getDirectChildElements(section)) {
        result.push({ node, kind: 'property', section: null });
      }
    } else if (METHOD_SECTIONS.has(section.name)) {
      for (const node of getDirectChildElements(section)) {
        result.push({ node, kind: 'method', section: section.name as DefMethodSection });
      }
    }
  }
  return result;
}

function buildFileIndex(defsRoot: string): FileEntry[] | null {
  const entries: FileEntry[] = [];
  for (const filePath of listDefFiles(defsRoot)) {
    const content = readFile(filePath);
    if (content === null) continue;
    const document = parseDef(content);
    if (!document?.root) continue;
    const semantics = parseDefFileSemantics(content);
    if (!semantics) continue;
    entries.push({
      filePath: path.resolve(filePath),
      ownerName: path.basename(filePath, '.def'),
      category: classify(defsRoot, filePath),
      content,
      document,
      semantics
    });
  }
  return entries.length > 0 ? entries : null;
}

function resolveLinks(entries: FileEntry[], defsRoot: string): { links: Link[]; issues: DefSemanticIssue[] } {
  const byPath = new Map(entries.map(entry => [entry.filePath, entry]));
  const links: Link[] = [];
  const issues: DefSemanticIssue[] = [];

  for (const source of entries) {
    const candidates: Array<{
      target: string;
      relation: Link['relation'];
      category: FileEntry['category'];
    }> = [];
    if (source.semantics.parentName) {
      candidates.push({
        target: source.semantics.parentName,
        relation: 'inherit',
        category: 'entity'
      });
    }
    for (const target of source.semantics.interfaceNames) {
      candidates.push({ target, relation: 'interface', category: 'interface' });
    }
    for (const target of source.semantics.componentTypeNames) {
      candidates.push({ target, relation: 'component', category: 'component' });
    }

    for (const candidate of candidates) {
      const directory = candidate.category === 'entity'
        ? defsRoot
        : path.join(defsRoot, candidate.category === 'interface' ? 'interfaces' : 'components');
      const target = byPath.get(path.resolve(directory, `${candidate.target}.def`));
      if (!target) {
        issues.push({
          code: candidate.relation === 'inherit'
            ? 'dangling-parent'
            : candidate.relation === 'interface'
              ? 'dangling-interface'
              : 'dangling-component',
          severity: 'error',
          filePath: source.filePath,
          line: 1,
          name: candidate.target,
          message: `Unresolved ${candidate.relation} reference: ${candidate.target}.def`
        });
        continue;
      }
      if (target !== source) links.push({ source, target, relation: candidate.relation });
    }
  }
  return { links, issues };
}

function connectedComponents(links: Link[]): Array<Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links) {
    for (const [left, right] of [[link.source.filePath, link.target.filePath], [link.target.filePath, link.source.filePath]]) {
      if (!adjacency.has(left)) adjacency.set(left, new Set());
      adjacency.get(left)!.add(right);
    }
  }
  const components: Array<Set<string>> = [];
  const visited = new Set<string>();
  for (const filePath of adjacency.keys()) {
    if (visited.has(filePath)) continue;
    const component = new Set([filePath]);
    visited.add(filePath);
    const queue = [filePath];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          component.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function collectDuplicateIssues(entries: FileEntry[], definitions: DefSymbolDeclaration[]): DefSemanticIssue[] {
  const declarationsByFile = new Map<string, DefSymbolDeclaration[]>();
  for (const declaration of definitions) {
    if (!declarationsByFile.has(declaration.filePath)) declarationsByFile.set(declaration.filePath, []);
    declarationsByFile.get(declaration.filePath)!.push(declaration);
  }
  const issues: DefSemanticIssue[] = [];
  for (const entry of entries) {
    for (const declaration of declarationsByFile.get(entry.filePath) ?? []) {
      const edits = collectRenameEditsInText(entry.content, {
        kind: declaration.kind,
        name: declaration.name,
        section: declaration.section,
        wordStart: declaration.start,
        wordEnd: declaration.end
      });
      if (edits.length > 1) {
        issues.push({
          code: 'duplicate-symbol',
          severity: 'warning',
          filePath: entry.filePath,
          line: declaration.line,
          name: declaration.name,
          message: `${declaration.kind} "${declaration.name}" is declared more than once in ${entry.ownerName}.def.`
        });
      }
    }
  }
  return issues;
}

function collectReferences(
  definitions: DefSymbolDeclaration[],
  entries: FileEntry[],
  links: Link[]
): { references: DefSymbolReference[]; edges: DefSymbolEdge[] } {
  const references: DefSymbolReference[] = [];
  const edges: DefSymbolEdge[] = [];
  const declarationsBySource = new Map<string, DefSymbolDeclaration>();
  const ancestorsByFile = new Map<string, Set<string>>();
  for (const entry of entries) {
    ancestorsByFile.set(entry.filePath, new Set([entry.filePath]));
  }
  for (const link of links) {
    ancestorsByFile.get(link.source.filePath)?.add(link.target.filePath);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      const ancestors = ancestorsByFile.get(link.source.filePath)!;
      for (const ancestor of ancestorsByFile.get(link.target.filePath) ?? []) {
        if (!ancestors.has(ancestor)) {
          ancestors.add(ancestor);
          changed = true;
        }
      }
    }
  }

  for (const link of links) {
    const ancestors = new Set([link.source.filePath, ...ancestorsByFile.get(link.source.filePath)!]);

    for (const declaration of definitions.filter(item => ancestors.has(item.filePath))) {
      if (declaration.filePath === link.source.filePath) continue;
      const edits = collectRenameEditsInText(link.source.content, {
        kind: declaration.kind,
        name: declaration.name,
        section: declaration.section,
        wordStart: declaration.start,
        wordEnd: declaration.end
      });
      if (edits.length === 0) continue;
      for (const edit of edits) {
        declarationsBySource.set(`${link.source.filePath}:${edit.start}`, declaration);
        references.push({
          filePath: link.source.filePath,
          sourceOwner: link.source.ownerName,
          targetOwner: link.target.ownerName,
          relation: link.relation,
          kind: declaration.kind,
          name: declaration.name,
          start: edit.start,
          end: edit.end,
          line: getLineNumberAt(link.source.document, edit.start) + 1
        });
      }
    }

    edges.push({
      source: link.source.filePath,
      target: link.target.filePath,
      relation: link.relation,
      references: references
        .filter(reference =>
          reference.filePath === link.source.filePath &&
          declarationsBySource.get(`${reference.filePath}:${reference.start}`)?.ownerName === reference.targetOwner &&
          reference.relation === link.relation)
        .sort((left, right) => left.start - right.start)
    });
  }
  return { references: references.sort((left, right) => left.start - right.start), edges };
}

export function buildDefReferenceGraphFromFile(filePath: string): DefReferenceGraph | null {
  const resolved = path.resolve(filePath);
  const defsRoot = findEntityDefsRootFromFile(resolved);
  if (!defsRoot) return null;

  const entries = buildFileIndex(defsRoot);
  if (!entries) return null;
  const { links, issues: linkIssues } = resolveLinks(entries, defsRoot);
  const definitions: DefSymbolDeclaration[] = [];
  for (const entry of entries) {
    for (const declaration of declarationNodes(entry.document)) {
      const nameRange = getTagNameRangeForGraph(entry.content, declaration.node, 'open');
      if (!nameRange) continue;
      definitions.push({
        filePath: entry.filePath,
        ownerName: entry.ownerName,
        ownerCategory: entry.category,
        kind: declaration.kind,
        name: declaration.node.name,
        section: declaration.section,
        start: nameRange.start,
        end: nameRange.end,
        line: getLineNumberAt(entry.document, nameRange.start) + 1
      });
    }
  }

  const reachableFiles = new Set(connectedComponents(links).flatMap(component => [...component]));
  const reachableDefinitions = definitions.filter(definition => reachableFiles.has(definition.filePath));
  const duplicateIssues = collectDuplicateIssues(entries, reachableDefinitions);
  const { references, edges } = collectReferences(reachableDefinitions, entries, links);

  return {
    definitions: reachableDefinitions.sort((left, right) =>
      `${left.filePath}:${left.start}`.localeCompare(`${right.filePath}:${right.start}`)),
    references,
    edges,
    issues: [...linkIssues, ...duplicateIssues].sort((left, right) =>
      `${left.filePath}:${left.line}`.localeCompare(`${right.filePath}:${right.line}`))
  };
}

export interface ProjectDoctorReport {
  readonly checkedDefinitions: number;
  readonly checkedFiles: number;
  readonly edges: number;
  readonly errors: DefSemanticIssue[];
  readonly warnings: DefSemanticIssue[];
}

export function buildProjectDoctorReport(graph: DefReferenceGraph): ProjectDoctorReport {
  const checkedFiles = new Set(graph.definitions.map(definition => definition.filePath));
  const errors = graph.issues.filter(issue => issue.severity === 'error');
  const warnings = graph.issues.filter(issue => issue.severity === 'warning');
  return {
    checkedDefinitions: graph.definitions.length,
    checkedFiles: checkedFiles.size,
    edges: graph.edges.length,
    errors,
    warnings
  };
}

export function formatProjectDoctorReport(report: ProjectDoctorReport): string {
  const lines = [
    `Project Doctor: ${report.checkedDefinitions} symbols, ${report.checkedFiles} files, ${report.edges} edges.`,
    `Errors: ${report.errors.length}; warnings: ${report.warnings.length}.`
  ];
  for (const issue of [...report.errors, ...report.warnings]) {
    lines.push(`${issue.severity.toUpperCase()} ${issue.filePath}:${issue.line} ${issue.message}`);
  }
  return lines.join('\n');
}
