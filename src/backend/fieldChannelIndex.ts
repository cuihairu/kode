// IDX-REL-003: serialization round-trip index — def property fields and
// FIXED_DICT fields mapped to the concrete encode/decode points of the three
// serialization channels (wire encode, wire decode, DB persistence).
//
// Channel model (SER-02 evidence; engine anchors verified in datatype.cpp):
// - wire encode: the engine addToStreamEx (datatype.cpp:2592-2642). When a
//   FIXED_DICT type carries a user impl, getDictFromObj's returned literal
//   dict keys ARE the encode points (the impl replaces the engine write);
//   otherwise the engine serializes the declared structure (engine cite).
// - wire decode: the engine createFromStreamEx (datatype.cpp:2673). The
//   createObjFromDict input-dict key reads are the decode points; else the
//   engine cite.
// - DB: persistent def properties are stored as one blob in the entity table
//   in the same stream order (engine cite); non-persistent properties are
//   not persisted (honest arm). FIXED_DICT keys persist by default and only
//   <Persistent>false</Persistent> disables them (databaseSchemaCore rule).
//
// Incremental contract (acceptance: a field rename invalidates correctly):
// - def rows: per-file content identity (same text = no reparse).
// - serializer shapes: per-python-file content identity, cached by impl
//   class symbol (python-side identity, stable across type renames). A
//   types.xml field rename therefore never reparses python — projections
//   are joined at query time against the live declaration snapshot, so the
//   renamed field correctly loses its impl anchor (engine cite) and the old
//   spelling surfaces as a stale anchor.
//
// Pure logic, no vscode/fs dependency (same contract as typeImpactIndex).

import {
  implBindingsForDocument,
  resolveImplMethodInputs
} from './createObjFromDictInput';
import { decodeShapeOf, encodeShapeOf } from './roundTripFields';
import { extractDefPropertyEdges } from './typeImpactIndex';
import { pythonCodeLines } from './pythonParser';
import type { CustomTypeInfo } from '../definitionWorkspace';

/** Engine-side citations for the channels without a user impl anchor. */
export const WIRE_ENCODE_ENGINE_CITE = 'datatype.cpp:2592-2642 addToStreamEx';
export const WIRE_DECODE_ENGINE_CITE = 'datatype.cpp:2673 createFromStreamEx';
export const DB_BLOB_CITE = 'entity_table blob (stream order)';

export type FieldChannelKind = 'wire-encode' | 'wire-decode' | 'db';

/** One concrete serialization point of a field (user impl or engine). */
export interface FieldChannelAnchor {
  channel: FieldChannelKind;
  /** impl = user python anchor; engine = engine-internal cite; none = not persisted */
  origin: 'impl' | 'engine' | 'none';
  /** Impl file (absolute), for impl anchors */
  file?: string;
  /** 1-based line of the impl key position, for impl anchors */
  line?: number;
  /** 0-based character of the impl key position, for impl anchors */
  character?: number;
  /** Engine citation text, for engine/none anchors */
  cite?: string;
}

export interface FieldChannelAnchorList {
  target: string;
  anchors: FieldChannelAnchor[];
  /**
   * Impl keys cached for the queried type that no longer match a declared
   * field (renamed or removed in types.xml) — the rename-invalidation
   * surface for the wire channels.
   */
  stale: Array<{
    channel: 'encode' | 'decode';
    key: string;
    file: string;
    line: number;
    character: number;
  }>;
}

/** Per-symbol serializer shapes derived from one python file. */
interface SerializerShape {
  encodeKeys: Map<string, { line: number; character: number }>;
  /** open returns (spread/derivation/dynamic keys): no impl encode anchor claimable */
  encodeUnknown: boolean;
  decodeReads: Map<string, { line: number; character: number }>;
  /** passthrough (returns the input dict): reads are not enumerable */
  decodePassthrough: boolean;
  getDefLine: number | null;
  createDefLine: number | null;
}

interface PythonFileCache {
  text: string;
  symbols: Map<string, SerializerShape>;
}

/** One def property's field row (reuses the def walk, adds persistence) */
export interface DefFieldRow {
  entity: string;
  filePath: string;
  property: string;
  declaredType: string | null;
  ofRef: string | null;
  persistent: boolean;
  line: number;
}

export class FieldChannelIndex {
  private readonly declByName = new Map<string, CustomTypeInfo>();
  private readonly defEdges = new Map<string, { text: string; rows: DefFieldRow[] }>();
  private readonly pythonFiles = new Map<string, PythonFileCache>();
  private shapeComputes = 0;

  /**
   * Replace the declaration snapshot (types.xml + alias.xml entries). Must
   * be called before the python files whose bindings are resolved against
   * it.
   */
  setCustomTypes(entries: readonly CustomTypeInfo[]): void {
    this.declByName.clear();
    for (const info of entries) {
      if (!this.declByName.has(info.name)) {
        this.declByName.set(info.name, info);
      }
    }
  }

  /** Ingest one def file; returns true when the parse set changed */
  setDefFile(filePath: string, entity: string, text: string): boolean {
    const cached = this.defEdges.get(filePath);
    if (cached && cached.text === text) {
      return false;
    }
    const edges = extractDefPropertyEdges(text, entity, filePath);
    const rows: DefFieldRow[] = edges.map(edge => ({
      entity: edge.entity,
      filePath: edge.filePath,
      property: edge.property,
      declaredType: edge.declaredType,
      ofRef: edge.ofRef,
      persistent: edge.persistent,
      line: edge.line
    }));
    this.defEdges.set(filePath, { text, rows });
    return true;
  }

  /** Drop cached rows for files no longer on disk (def file deleted) */
  retainDefFiles(keep: ReadonlySet<string>): void {
    for (const filePath of [...this.defEdges.keys()]) {
      if (!keep.has(filePath)) {
        this.defEdges.delete(filePath);
      }
    }
  }

  /** Drop cached serializer shapes for impl files no longer in the snapshot */
  retainPythonFiles(keep: ReadonlySet<string>): void {
    for (const filePath of [...this.pythonFiles.keys()]) {
      if (!keep.has(filePath)) {
        this.pythonFiles.delete(filePath);
      }
    }
  }

  /**
   * Ingest one python impl file. Bindings resolve against the current
   * declaration snapshot (implBindingsForDocument), so a declaration change
   * (e.g. implementedBy moved to another file) is picked up here. Python
   * content identity: unchanged text = no shape recompute.
   */
  setPythonFile(filePath: string, text: string): boolean {
    const cached = this.pythonFiles.get(filePath);
    if (cached && cached.text === text) {
      return false;
    }
    const bindings = implBindingsForDocument([...this.declByName.values()], filePath);
    const symbols = this.computeShapes(text, bindings);
    this.pythonFiles.set(filePath, { text, symbols });
    this.shapeComputes += 1;
    return true;
  }

  private computeShapes(text: string, bindings: readonly {
    container: CustomTypeInfo;
    symbol: string;
  }[]): Map<string, SerializerShape> {
    const shapes = new Map<string, SerializerShape>();
    if (bindings.length === 0) {
      return shapes;
    }
    const realLines = text.split(/\r?\n/);
    const maskedLines = pythonCodeLines(text);
    for (const binding of bindings) {
      if (!binding.symbol || shapes.has(binding.symbol)) {
        continue;
      }
      const getInput = resolveImplMethodInputs(text, bindings, 'getDictFromObj')
        .find(candidate => candidate.symbol === binding.symbol);
      const createInput = resolveImplMethodInputs(text, bindings, 'createObjFromDict')
        .find(candidate => candidate.symbol === binding.symbol);
      const shape: SerializerShape = {
        encodeKeys: new Map(),
        encodeUnknown: false,
        decodeReads: new Map(),
        decodePassthrough: false,
        getDefLine: null,
        createDefLine: null
      };
      if (getInput) {
        shape.getDefLine = getInput.defLine;
        const encode = encodeShapeOf(maskedLines, realLines, getInput);
        if (encode.kind === 'literal') {
          shape.encodeKeys = encode.keys;
        } else {
          shape.encodeUnknown = true;
        }
      }
      if (createInput) {
        shape.createDefLine = createInput.defLine;
        const decode = decodeShapeOf(maskedLines, realLines, createInput);
        shape.decodePassthrough = decode.passthrough;
        shape.decodeReads = decode.reads;
      }
      shapes.set(binding.symbol, shape);
    }
    return shapes;
  }

  getDefFileCount(): number {
    return this.defEdges.size;
  }

  /** Field rows of one ingested def file (empty when not ingested) */
  getDefFileRows(filePath: string): readonly DefFieldRow[] {
    return this.defEdges.get(filePath)?.rows ?? [];
  }

  getPythonFileCount(): number {
    return this.pythonFiles.size;
  }

  /** Shape recompute count (incremental proof for tests/budget audits) */
  getShapeComputeCount(): number {
    return this.shapeComputes;
  }

  /** Declared field names of one custom type (FD container fields) */
  declaredFields(typeName: string): string[] {
    const info = this.declByName.get(typeName);
    return info ? info.properties.map(property => property.name) : [];
  }

  private shapeFor(info: CustomTypeInfo): { shape: SerializerShape; implFile: string } | null {
    if (!info.implementedBy || !info.pythonFilePath) {
      return null;
    }
    const symbol = info.implementedBy.split('.').pop() ?? '';
    const cache = this.pythonFiles.get(info.pythonFilePath);
    if (!cache) {
      return null;
    }
    const shape = cache.symbols.get(symbol);
    return shape ? { shape, implFile: info.pythonFilePath } : null;
  }

  /**
   * Channels of one FIXED_DICT field. Wire channels: impl anchors where the
   * type's impl enumerates the field, engine cites otherwise. DB: engine
   * cite (FD keys persist by default, per databaseSchemaCore). Stale impl
   * keys (renamed/removed) are reported alongside.
   */
  channelsForField(typeName: string, fieldName: string): FieldChannelAnchorList | null {
    const info = this.declByName.get(typeName);
    if (!info) {
      return null;
    }
    const anchors: FieldChannelAnchor[] = [];
    const stale: FieldChannelAnchorList['stale'] = [];
    const binding = info ? this.shapeFor(info) : null;

    if (binding) {
      const { shape, implFile } = binding;
      if (!shape.encodeUnknown && shape.encodeKeys.has(fieldName)) {
        const at = shape.encodeKeys.get(fieldName)!;
        anchors.push({
          channel: 'wire-encode',
          origin: 'impl',
          file: implFile,
          line: at.line + 1,
          character: at.character
        });
      } else {
        anchors.push({ channel: 'wire-encode', origin: 'engine', cite: WIRE_ENCODE_ENGINE_CITE });
      }
      if (!shape.decodePassthrough && shape.decodeReads.has(fieldName)) {
        const at = shape.decodeReads.get(fieldName)!;
        anchors.push({
          channel: 'wire-decode',
          origin: 'impl',
          file: implFile,
          line: at.line + 1,
          character: at.character
        });
      } else {
        anchors.push({ channel: 'wire-decode', origin: 'engine', cite: WIRE_DECODE_ENGINE_CITE });
      }
      for (const [key, at] of shape.encodeKeys) {
        if (!info!.properties.some(property => property.name === key)) {
          stale.push({ channel: 'encode', key, file: implFile, line: at.line + 1, character: at.character });
        }
      }
      for (const [key, at] of shape.decodeReads) {
        if (!info!.properties.some(property => property.name === key)) {
          stale.push({ channel: 'decode', key, file: implFile, line: at.line + 1, character: at.character });
        }
      }
    } else {
      anchors.push({ channel: 'wire-encode', origin: 'engine', cite: WIRE_ENCODE_ENGINE_CITE });
      anchors.push({ channel: 'wire-decode', origin: 'engine', cite: WIRE_DECODE_ENGINE_CITE });
    }
    anchors.push({ channel: 'db', origin: 'engine', cite: DB_BLOB_CITE });
    return { target: `${typeName}.${fieldName}`, anchors, stale };
  }

  /**
   * Channels of one def property. The property's type conversion anchors
   * at the impl function site (whole-dict conversion); builtin-typed
   * properties are engine-cited on both wire channels. DB: persistent
   * properties keep the blob cite; non-persistent get the honest arm.
   */
  channelsForProperty(filePath: string, propertyName: string): FieldChannelAnchorList | null {
    const cached = this.defEdges.get(filePath);
    const row = cached ? cached.rows.find(candidate => candidate.property === propertyName) : null;
    if (!row) {
      return null;
    }
    const anchors: FieldChannelAnchor[] = [];
    const typeToken = row.ofRef && row.declaredType === 'ARRAY' ? row.ofRef : row.declaredType;
    const info = typeToken ? this.declByName.get(typeToken) : null;
    const binding = info ? this.shapeFor(info) : null;

    if (binding) {
      const { shape, implFile } = binding;
      anchors.push({
        channel: 'wire-encode',
        origin: 'impl',
        file: implFile,
        line: (shape.getDefLine ?? 0) + 1
      });
      anchors.push({
        channel: 'wire-decode',
        origin: 'impl',
        file: implFile,
        line: (shape.createDefLine ?? 0) + 1
      });
    } else {
      anchors.push({ channel: 'wire-encode', origin: 'engine', cite: WIRE_ENCODE_ENGINE_CITE });
      anchors.push({ channel: 'wire-decode', origin: 'engine', cite: WIRE_DECODE_ENGINE_CITE });
    }
    if (row.persistent) {
      anchors.push({ channel: 'db', origin: 'engine', cite: DB_BLOB_CITE });
    } else {
      anchors.push({ channel: 'db', origin: 'none', cite: 'not persisted' });
    }
    return { target: `${row.entity}.${propertyName}`, anchors, stale: [] };
  }
}
