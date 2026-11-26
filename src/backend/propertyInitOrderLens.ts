/**
 * Makes "properties load before __init__" visible (IDE-PROP-001).
 *
 * Engine fact (the semantics are already carried by the languageProviders
 * four-tier property landing notes): KBEngine loads the properties declared
 * by Entity.def into the entity before __init__ runs, and the script may not
 * have a same-named assignment — self.hp is directly readable inside
 * __init__. This engine semantics is invisible to a Python-only reader (a
 * property "used before assignment"), so one CodeLens line is emitted at the
 * __init__ declaration of an entity class: "properties load before
 * __init__ · from <entity>.def", clicking back to the def.
 *
 * Pure logic layer, does not import vscode: scans class definitions and
 * __init__ declaration lines + emits lenses via an external resolver
 * (entity name → def path); the provider layer (languageProviders)
 * assembles them into vscode.CodeLens under the independent switch
 * kbengine.codeLens.propertyInitOrder.
 *
 * Known boundary: the class name is the entity name (in the engine's load
 * chain the def base name and the entity class share the name; the first of
 * the four landing tiers follows the same contract); when the class name
 * resolves to no def (the workspace has no such entity) no lens is emitted —
 * non-entity classes are never passed off as "from Entity.def". Whether the
 * def really contains <Properties> is not verified in this layer (the title
 * speaks about loading semantics, not a property inventory).
 */

/** One "properties load first" lens at an entity class's __init__ */
export interface PropertyInitOrderLensSpec {
  /** `def __init__` declaration line (0-based) — the lens anchors on the __init__ line (which is exactly what the title says) */
  line: number;
  /** Start column of the `def` keyword (0-based) */
  character: number;
  /** Entity class name (= the def file's base name) */
  entityName: string;
  /** Absolute path of the resolved def file */
  defPath: string;
  /** Lens title */
  title: string;
}

const PYTHON_CLASS_PATTERN = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PYTHON_INIT_PATTERN = /^(\s*)def\s+__init__\s*\(/;

export function describePropertyInitOrderTitle(entityName: string): string {
  return `属性先于 __init__ 装载 · 来自 ${entityName}.def`;
}

/**
 * Scans Python source to produce "properties load first" lens specs. Class
 * context is kept on a stack by indentation: a class header is pushed
 * (first popping tiers whose indent ≥ its own), and when `def __init__(`
 * appears, tiers with indent ≥ its own are popped before attributing it to
 * the top-of-stack class (a shallower indent = the outer class body
 * continues after the nested class); a lens is emitted only when the class
 * name resolves to a def through resolveDefPath (no resolution, no lens —
 * honestly).
 */
export function buildPropertyInitOrderLensSpecs(
  content: string,
  resolveDefPath: (entityName: string) => string | null
): PropertyInitOrderLensSpec[] {
  const specs: PropertyInitOrderLensSpec[] = [];
  const lines = content.split(/\r?\n/);
  const classStack: Array<{ name: string; indent: number }> = [];
  // Only the first lens per entity class (a duplicate same-named class
  // definition is itself an abnormal shape and is not amplified)
  const seenEntities = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const classMatch = PYTHON_CLASS_PATTERN.exec(line);
    if (classMatch) {
      const indent = classMatch[1].length;
      while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
        classStack.pop();
      }
      classStack.push({ name: classMatch[2], indent });
      continue;
    }

    const initMatch = PYTHON_INIT_PATTERN.exec(line);
    if (initMatch) {
      const indent = initMatch[1].length;
      while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) {
        classStack.pop();
      }
      const owner = classStack[classStack.length - 1];
      if (!owner) {
        continue;
      }
      const entityName = owner.name;
      if (seenEntities.has(entityName)) {
        continue;
      }
      const defPath = resolveDefPath(entityName);
      if (!defPath) {
        continue;
      }
      seenEntities.add(entityName);
      specs.push({
        line: index,
        character: indent,
        entityName,
        defPath,
        title: describePropertyInitOrderTitle(entityName)
      });
    }
  }

  return specs;
}
