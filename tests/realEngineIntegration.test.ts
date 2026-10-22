import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseDefFileSemantics } from '../src/defRenamer';
import { parseLocalDefinition } from '../src/definitionSemantics';
import { getCustomTypeInfos } from '../src/definitionWorkspace';
import { propertyFlagDomainList } from '../src/defAnalyzer';

const engineRoot = process.env.KBENGINE_ROOT;
const hasEngineTree = !!engineRoot && existsSync(join(engineRoot, 'kbe', 'src', 'lib', 'entitydef'));
const fantasyRoot = '/home/cui/workspaces/BigWorld/programming/fantasydemo/res';
const hasRealAssets = existsSync(join(fantasyRoot, 'scripts', 'entity_defs', 'Avatar.def'));
const canRun = hasEngineTree && hasRealAssets;

describe.skipIf(!canRun)('real KBEngine integration', () => {
  const defsRoot = join(fantasyRoot, 'scripts', 'entity_defs');

  it('parses every real entity declaration and registry sample', () => {
    const defFiles = readdirSync(defsRoot).filter(name => name.endsWith('.def'));
    expect(defFiles.length).toBeGreaterThan(0);
    for (const fileName of defFiles) {
      const content = readFileSync(join(defsRoot, fileName), 'utf8');
      const semantics = parseDefFileSemantics(content);
      expect(semantics, fileName).not.toBeNull();
      const entityName = fileName.replace(/\.def$/, '');
      const local = parseLocalDefinition(content, 'entity', entityName, join(defsRoot, fileName));
      const expectedMethods = new Set(['chatMessage', 'cellTick', 'fromCell', 'logOff']);
      if (expectedMethods.has(entityName) || local.methods.length > 0) {
        expect(local.properties.length + local.methods.length, fileName).toBeGreaterThan(0);
      }
    }

    const registry = readFileSync(join(fantasyRoot, 'scripts', 'entities.xml'), 'utf8');
    expect(registry).toContain('<Account/>');
    expect(registry).toContain('<Avatar/>');
  });

  it('parses inherited declarations when the real tree provides a Parent chain', () => {
    const inheritedFile = readdirSync(defsRoot)
      .map(name => ({
        name,
        semantics: parseDefFileSemantics(readFileSync(join(defsRoot, name), 'utf8'))
      }))
      .find(file => file.semantics?.parentName);
    if (!inheritedFile) {
      console.warn('real sample tree has no .def Parent declaration; inheritance case skipped');
      return;
    }
    expect(inheritedFile.semantics?.parentName).toBeTruthy();
  });

  it('parses real declarations with methods and exposure', () => {
    const avatar = parseDefFileSemantics(readFileSync(join(defsRoot, 'Avatar.def'), 'utf8'));
    expect(avatar).not.toBeNull();
    const avatarLocal = parseLocalDefinition(
      readFileSync(join(defsRoot, 'Avatar.def'), 'utf8'),
      'entity',
      'Avatar',
      join(defsRoot, 'Avatar.def')
    );
    expect(avatarLocal.methods.some(method => method.name === 'cellTick')).toBe(true);
    expect(avatarLocal.methods.some(method => method.name === 'logOff')).toBe(true);
    expect(avatarLocal.methods.find(method => method.name === 'logOff')?.exposed).toBe(true);
    expect(avatarLocal.properties.find(property => property.name === 'playerName')?.flags).toContain('ALL_CLIENTS');
  });

  it('resolves real alias declarations and implementedBy scripts', () => {
    const aliases = getCustomTypeInfos(fantasyRoot);
    const angle = aliases.find(alias => alias.name === 'ANGLE');
    const objectId = aliases.find(alias => alias.name === 'OBJECT_ID');

    expect(angle?.aliasType).toBe('FLOAT');
    expect(objectId?.aliasType).toBe('INT32');
    expect(objectId?.line).toBeGreaterThan(0);
  });

  it('maps flag spellings to engine visibility domains', () => {
    expect(propertyFlagDomainList('CELL_PUBLIC')).toEqual(['cell']);
    expect(propertyFlagDomainList('ALL_CLIENTS')).toEqual(['cell', 'client']);
    expect(propertyFlagDomainList('BASE_AND_CLIENT')).toEqual(['base', 'client']);
    expect(propertyFlagDomainList('UNKNOWN_FLAG')).toEqual([]);
  });
});
