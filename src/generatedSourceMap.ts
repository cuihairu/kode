import type {
  EntityTypePropertyEntry,
  EntityTypeStubEntry
} from './entityTypeStubs';
import type { PythonTypeStubEntry } from './pythonTypeStubs';

export interface GeneratedSourceLocation {
  origin: string;
  line: number;
}

export function resolvePythonTypeStubSource(
  entries: readonly PythonTypeStubEntry[],
  documentLine: number
): GeneratedSourceLocation | null {
  const locationByDocumentLine = new Map<number, GeneratedSourceLocation>();
  for (const entry of entries) {
    if (entry.kind !== 'class') {
      if (entry.sourceLine !== null) {
        locationByDocumentLine.set(0, { origin: entry.name, line: entry.sourceLine as number });
      }
      continue;
    }
    if (entry.sourceLine !== null) {
      locationByDocumentLine.set(0, { origin: entry.name, line: entry.sourceLine as number });
    }
    const property = entry.properties.find(
      candidate => entry.propertySourceLines?.[candidate.name] !== null
    );
    if (property && entry.sourceLine !== null) {
      locationByDocumentLine.set(2, { origin: entry.name, line: entry.sourceLine as number });
    }
  }
  return locationByDocumentLine.get(documentLine) ?? null;
}

export function resolveEntityTypeStubSource(
  entries: readonly EntityTypeStubEntry[],
  documentLine: number
): GeneratedSourceLocation | null {
  for (const entry of entries) {
    const property: EntityTypePropertyEntry | undefined = documentLine === 0
      ? entry.properties[0]
      : undefined;
    if (property) {
      return {
        origin: entry.entity,
        line: property.customTypeLine ?? property.sourceLine
      };
    }
  }
  return null;
}
