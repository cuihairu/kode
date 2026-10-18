#!/usr/bin/env python3
"""Run the demo's actual scripts with a small, explicit KBEngine adapter.

This checks Python gameplay/MRO, not engine networking, persistence or RPC.
No adapter or fake KBEngine module is placed in the engine's scripts path.
"""
import argparse
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import types
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SCRIPTS = ROOT / "scripts"
sys.path[:0] = [str(SCRIPTS / role) for role in ("cell", "common", "user_type")]
sys.dont_write_bytecode = True


def entity_defaults(name, seen=None):
    seen = set() if seen is None else seen
    if name in seen:
        raise ValueError("Cyclic demo definition: " + name)
    seen = seen | {name}
    candidates = [SCRIPTS / "entity_defs" / (name + ".def"),
                  SCRIPTS / "entity_defs/interfaces" / (name + ".def")]
    file = next((file for file in candidates if file.exists()), None)
    if file is None:
        raise ValueError("Missing demo definition: " + name)
    root = ET.parse(file).getroot()
    values = {}
    parent = root.findtext("Parent", "").strip()
    dependencies = ([parent] if parent else []) + [node.text.strip() for node in root.findall("Interfaces/interface")]
    for dependency in dependencies:
        values.update(entity_defaults(dependency, seen))
    for prop in root.findall("Properties/*"):
        value = prop.findtext("Default", "0").strip()
        values[prop.tag] = value if prop.findtext("Type", "").strip() == "STRING" else int(value)
    return values


class LocalEntity:
    def __init__(self):
        self.id = len(engine.entities) + 1
        self.position = (0, 0, 0)
        for key, value in entity_defaults(type(self).__name__).items():
            setattr(self, key, value)
        engine.entities[self.id] = self


engine = types.ModuleType("KBEngine")
engine.Entity = LocalEntity
engine.entities = {}
sys.modules["KBEngine"] = engine
entity_classes = {}


def entity_class(role, name):
    key = (role, name)
    if key not in entity_classes:
        spec = importlib.util.spec_from_file_location("demo_" + role + "_" + name, SCRIPTS / role / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        entity_classes[key] = getattr(module, name)
    return entity_classes[key]


def new_game():
    engine.entities.clear()
    hero = entity_class("cell", "TrainingAvatar")()
    hero.hp = hero.maxHp = 90
    hero.attackPower = 12
    slime = entity_class("cell", "TrainingMonster")()
    slime.hp = slime.maxHp = 24
    slime.attackPower = 5
    elite = entity_class("cell", "EliteMonster")()
    elite.hp = elite.maxHp = 40
    elite.attackPower = 6
    elite.rewardCoins = 12
    elite.rewardXp = 25
    return hero, {"slime": slime, "elite": elite}


def perform_turn(hero, monsters, command):
    words = command.split()
    if hero.hp <= 0 or not any(monster.hp > 0 for monster in monsters.values()):
        return "The battle has ended."
    if words and words[0] == "attack" and len(words) == 2 and words[1] in monsters:
        target = monsters[words[1]]
        if target.hp <= 0:
            return "That monster is already defeated."
        damage = hero.reqAttack(target.id)
        message = "Hit {} for {}.".format(words[1], damage)
    elif words == ["heal"]:
        if hero.potions <= 0:
            return "No potions left."
        hero.drink_potion()
        message = "Used a potion."
    elif len(words) == 2 and words[0] == "move" and words[1] in ("w", "a", "s", "d"):
        dx, dz = {"w": (0, -1), "a": (-1, 0), "s": (0, 1), "d": (1, 0)}[words[1]]
        if not hero.step(dx, dz):
            return "Outside the training ground."
        message = "Moved to {}.".format(hero.position)
    else:
        return "Commands: attack slime, attack elite, heal, move w/a/s/d, status, quit"
    # The arena is a turn-based sparring room; movement tests boundaries, not range.
    for monster in monsters.values():
        monster.tick([hero])
    return message


def snapshot(hero, monsters):
    return {"hp": hero.hp, "coins": hero.coins, "experience": hero.experience,
            "potions": hero.potions, "monsters": {name: monster.hp for name, monster in monsters.items()},
            "won": hero.hp > 0 and all(monster.hp == 0 for monster in monsters.values())}


def runtime_navigation():
    manifest = json.loads((ROOT / "navigation-cases.json").read_text())
    report = []
    for case in manifest["cases"]:
        if not case["runtime"]:
            continue
        actual = set()
        for context in case["runtime"]:
            cls = entity_class(context["role"], context["entity"])
            method = getattr(cls, context["method"])
            file = Path(inspect.getsourcefile(method)).resolve()
            line = inspect.getsourcelines(method)[1] - 1
            actual.add((file.relative_to(ROOT).as_posix(), line))
        expected = set()
        for target in case["targets"]:
            lines = (ROOT / target["file"]).read_text().splitlines()
            matches = [line for line, text in enumerate(lines) if target["needle"] in text]
            if len(matches) != 1:
                raise AssertionError("Ambiguous target: " + case["id"])
            expected.add((target["file"], matches[0]))
        if actual != expected:
            raise AssertionError("{}: Python selected {}, expected {}".format(case["id"], actual, expected))
        report.append({"id": case["id"], "targets": [{"file": file, "line": line} for file, line in sorted(actual)]})
    return report


class GameplayVerification(unittest.TestCase):
    def setUp(self):
        self.hero, self.monsters = new_game()

    def test_diamond_mro_and_overrides(self):
        from training.mixins.damage import DamageMixin
        self.assertEqual(type(self.hero).__mro__.count(DamageMixin), 1)
        self.assertEqual(self.hero.compute_damage(), 16)
        self.assertEqual(self.monsters["slime"].compute_damage(), 5)
        self.assertEqual(self.monsters["elite"].compute_damage(), 12)

    def test_win_and_rewards_cannot_be_farmed(self):
        for command in ["attack slime"] * 2 + ["attack elite"] * 3:
            perform_turn(self.hero, self.monsters, command)
        self.assertTrue(snapshot(self.hero, self.monsters)["won"])
        self.assertEqual((self.hero.coins, self.hero.experience), (17, 35))
        self.hero.reqAttack(self.monsters["slime"].id)
        self.assertEqual(self.hero.coins, 17)

    def test_invalid_target_and_self_damage(self):
        hp = self.hero.hp
        self.assertEqual(self.hero.reqAttack(99999), 0)
        self.assertEqual(self.hero.reqAttack(self.hero.id), 0)
        self.assertEqual(self.hero.hp, hp)

    def test_movement_bounds(self):
        self.assertFalse(self.hero.step(-1, 0))
        self.assertTrue(self.hero.step(1, 0))
        self.assertEqual(self.hero.position, (1, 0, 0))

    def test_heal_limits_and_consumption(self):
        self.hero.take_damage(30)
        self.hero.drink_potion()
        self.hero.drink_potion()
        self.assertEqual((self.hero.hp, self.hero.potions), (80, 0))
        self.hero.drink_potion()
        self.assertEqual(self.hero.hp, 80)
        self.hero.reqHeal(65535)
        self.assertEqual(self.hero.hp, self.hero.maxHp)

    def test_dead_entities_do_not_act(self):
        self.hero.take_damage(9999)
        slime = self.monsters["slime"]
        self.assertEqual(self.hero.attack(slime), 0)
        self.assertEqual(slime.tick([self.hero]), 0)
        self.assertEqual(self.hero.drink_potion(), 0)

    def test_real_python_method_sources_match_navigation_manifest(self):
        self.assertGreaterEqual(len(runtime_navigation()), 14)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Run gameplay assertions and independent Python MRO checks")
    parser.add_argument("--scripted", action="store_true", help="Play a deterministic winning battle")
    parser.add_argument("--navigation-json", action="store_true", help="Print the runtime lookup results for plugin comparison")
    args = parser.parse_args()
    if args.navigation_json:
        print(json.dumps(runtime_navigation(), indent=2))
        return 0
    if args.verify:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(GameplayVerification))
        return 0 if result.wasSuccessful() else 1
    hero, monsters = new_game()
    if args.scripted:
        for command in ["attack slime"] * 2 + ["attack elite"] * 3:
            print(perform_turn(hero, monsters, command))
        result = snapshot(hero, monsters)
        print(json.dumps(result, indent=2))
        return 0 if result["won"] else 1
    print("KBEngine demo training ground (local Python adapter; no engine server).")
    print("Defeat slime and elite. Commands: attack slime, attack elite, heal, move w/a/s/d, status, quit")
    while True:
        print(json.dumps(snapshot(hero, monsters)))
        try:
            command = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if command == "quit":
            break
        if command != "status":
            print(perform_turn(hero, monsters, command))
        if hero.hp <= 0 or snapshot(hero, monsters)["won"]:
            print("Victory!" if hero.hp > 0 else "Defeat.")
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
