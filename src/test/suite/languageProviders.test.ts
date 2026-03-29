import * as assert from 'assert';
import {
  getPythonSelfAccessAtPosition,
  getPythonSelfCompletionContext,
  getPythonSelfSymbolAtPosition
} from '../../pythonLanguageUtils';

describe('Python language helpers', () => {
  it('returns the symbol under the cursor for self access', () => {
    const line = 'value = self.health + self.mana';

    assert.strictEqual(getPythonSelfSymbolAtPosition(line, line.indexOf('health')), 'health');
    assert.strictEqual(getPythonSelfSymbolAtPosition(line, line.indexOf('mana')), 'mana');
  });

  it('returns null when cursor is not on a self symbol', () => {
    const line = 'value = self.health + other.mana';

    assert.strictEqual(getPythonSelfSymbolAtPosition(line, line.indexOf('value')), null);
    assert.strictEqual(getPythonSelfSymbolAtPosition(line, line.indexOf('other')), null);
  });

  it('keeps the root symbol for chained self access', () => {
    const line = 'return self.inventory.weapon.damage';

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('inventory')),
      {
        rootSymbol: 'inventory',
        currentSymbol: 'inventory',
        fullPath: 'inventory.weapon.damage'
      }
    );

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('weapon')),
      {
        rootSymbol: 'inventory',
        currentSymbol: 'weapon',
        fullPath: 'inventory.weapon.damage'
      }
    );

    assert.strictEqual(
      getPythonSelfSymbolAtPosition(line, line.indexOf('damage')),
      'inventory'
    );
  });

  it('supports method calls on self', () => {
    const line = 'self.attack(target)';

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('attack')),
      {
        rootSymbol: 'attack',
        currentSymbol: 'attack',
        fullPath: 'attack'
      }
    );
  });

  it('resolves the correct self access when multiple accesses exist on one line', () => {
    const line = 'value = self.inventory + self.mana';

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('inventory')),
      {
        rootSymbol: 'inventory',
        currentSymbol: 'inventory',
        fullPath: 'inventory'
      }
    );

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('mana')),
      {
        rootSymbol: 'mana',
        currentSymbol: 'mana',
        fullPath: 'mana'
      }
    );
  });

  it('returns the current nested segment while keeping the root symbol', () => {
    const line = 'return self.inventory.weapon.damage';

    assert.deepStrictEqual(
      getPythonSelfAccessAtPosition(line, line.indexOf('damage')),
      {
        rootSymbol: 'inventory',
        currentSymbol: 'damage',
        fullPath: 'inventory.weapon.damage'
      }
    );
  });

  it('detects completion context for direct and chained self access', () => {
    assert.deepStrictEqual(
      getPythonSelfCompletionContext('self.'),
      {
        rootSymbol: null,
        parentPath: '',
        fullPath: '',
        partialSymbol: ''
      }
    );

    assert.deepStrictEqual(
      getPythonSelfCompletionContext('self.inv'),
      {
        rootSymbol: 'inv',
        parentPath: '',
        fullPath: 'inv',
        partialSymbol: 'inv'
      }
    );

    assert.deepStrictEqual(
      getPythonSelfCompletionContext('self.inventory.'),
      {
        rootSymbol: 'inventory',
        parentPath: 'inventory',
        fullPath: 'inventory',
        partialSymbol: ''
      }
    );

    assert.deepStrictEqual(
      getPythonSelfCompletionContext('self.inventory.wea'),
      {
        rootSymbol: 'inventory',
        parentPath: 'inventory',
        fullPath: 'inventory.wea',
        partialSymbol: 'wea'
      }
    );
  });
});
