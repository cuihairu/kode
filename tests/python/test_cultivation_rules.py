"""Cultivation demo rule core tests (DEMO-GAME-008). No external dependencies."""
import importlib.util
import random
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('kode_cultivation', str(ROOT / 'templates/assets/scripts/common/cultivation.py'))
XX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(XX)


class RealmTests(unittest.TestCase):
    def test_realm_progression_table(self):
        self.assertEqual(XX.realm_of(0), (0, 0, 100))
        self.assertEqual(XX.realm_of(99), (0, 99, 1))
        self.assertEqual(XX.realm_of(100), (1, 0, 200))
        self.assertEqual(XX.realm_of(300), (2, 0, 600))
        self.assertEqual(XX.realm_of(900), (3, 0, 1800))
        self.assertEqual(XX.realm_of(5000), (4, 2300, None))
        self.assertEqual(XX.exp_to_breakthrough(0), 100)
        self.assertEqual(XX.exp_to_breakthrough(5000), 0)

    def test_realm_names_aligned_with_table(self):
        self.assertEqual(len(XX.REALM_NAMES), len(XX.REALM_EXP))

    def test_practice_gain_constant(self):
        # DEMO-GAME-011: reqPractice adds this much experience per call.
        # Pinned so a silent rebalance is noticed; with 20/step, five calls
        # (exp=100) enter realm 1, four calls (exp=80) still fall short.
        self.assertEqual(XX.PRACTICE_EXP_GAIN, 20)
        self.assertEqual(XX.realm_of(XX.PRACTICE_EXP_GAIN * 5)[0], 1)
        self.assertGreater(XX.exp_to_breakthrough(XX.PRACTICE_EXP_GAIN * 4), 0)


class AffinityTests(unittest.TestCase):
    def test_wuxing_cycles(self):
        # generating: metal->water->wood->fire->earth->metal
        self.assertEqual(XX.GENERATES[XX.ROOT_METAL], XX.ROOT_WATER)
        self.assertEqual(XX.GENERATES[XX.ROOT_WATER], XX.ROOT_WOOD)
        self.assertEqual(XX.GENERATES[XX.ROOT_WOOD], XX.ROOT_FIRE)
        self.assertEqual(XX.GENERATES[XX.ROOT_FIRE], XX.ROOT_EARTH)
        self.assertEqual(XX.GENERATES[XX.ROOT_EARTH], XX.ROOT_METAL)
        # overcoming: metal->wood->earth->water->fire->metal
        self.assertEqual(XX.OVERCOMES[XX.ROOT_METAL], XX.ROOT_WOOD)
        self.assertEqual(XX.OVERCOMES[XX.ROOT_WOOD], XX.ROOT_EARTH)
        self.assertEqual(XX.OVERCOMES[XX.ROOT_EARTH], XX.ROOT_WATER)
        self.assertEqual(XX.OVERCOMES[XX.ROOT_WATER], XX.ROOT_FIRE)
        self.assertEqual(XX.OVERCOMES[XX.ROOT_FIRE], XX.ROOT_METAL)

    def test_affinity_multipliers(self):
        # metal overcomes wood -> strong; wood vs metal -> weak
        self.assertEqual(XX.affinity(XX.ROOT_METAL, XX.ROOT_WOOD), 1.5)
        self.assertEqual(XX.affinity(XX.ROOT_WOOD, XX.ROOT_METAL), 0.8)
        # metal generates water -> small bonus
        self.assertEqual(XX.affinity(XX.ROOT_METAL, XX.ROOT_WATER), 1.1)
        # water vs metal: not generating, not overcoming -> neutral
        self.assertEqual(XX.affinity(XX.ROOT_WATER, XX.ROOT_METAL), 1.0)
        # same root and none root both neutral
        self.assertEqual(XX.affinity(XX.ROOT_FIRE, XX.ROOT_FIRE), 1.0)
        self.assertEqual(XX.affinity(XX.ROOT_NONE, XX.ROOT_FIRE), 1.0)
        self.assertEqual(XX.affinity(XX.ROOT_FIRE, XX.ROOT_NONE), 1.0)


class RollTests(unittest.TestCase):
    def test_roll_sums_to_100_with_dominant_range(self):
        rng = random.Random(20261128)
        for _ in range(200):
            roots = XX.roll_spirit_roots(rng)
            self.assertEqual(sum(roots.values()), 100)
            self.assertEqual(set(roots), set(XX.ROOT_KEYS))
            dominant = max(roots.values())
            self.assertTrue(40 <= dominant <= 60)

    def test_dominant_root_resolves_index_and_ties(self):
        self.assertEqual(XX.dominant_root({"metal": 50, "wood": 20, "water": 10, "fire": 10, "earth": 10}), XX.ROOT_METAL)
        # tie -> lower index wins
        self.assertEqual(XX.dominant_root({"metal": 20, "wood": 20, "water": 20, "fire": 20, "earth": 20}), XX.ROOT_METAL)


class StackTests(unittest.TestCase):
    def test_merge_into_existing_stack(self):
        stacks, added = XX.merge_stack([{"itemId": 7, "count": 90}], 7, 20, 10)
        self.assertEqual(added, 20)
        self.assertEqual(stacks, [{"itemId": 7, "count": 99}, {"itemId": 7, "count": 11}])

    def test_capacity_and_overflow(self):
        full = [{"itemId": i, "count": 99} for i in range(10)]
        stacks, added = XX.merge_stack(full, 42, 50, 10)
        self.assertEqual(added, 0)
        self.assertEqual(len(stacks), 10)
        stacks, added = XX.merge_stack([{"itemId": 1, "count": 1}], 1, 500, 8)
        # existing slot fills 1->99 (added 98), remaining 402 opens
        # ceil(402/99) = 5 new slots -> 6 slots total
        self.assertEqual(added, 500)
        self.assertEqual(len(stacks), 6)

    def test_partial_capacity(self):
        stacks, added = XX.merge_stack([], 5, 300, 3)
        self.assertEqual(added, 297)  # 3 slots * 99
        self.assertEqual(len(stacks), 3)


class EquipTests(unittest.TestCase):
    def test_slot_and_realm_gates(self):
        ok, reason = XX.can_equip("weapon", "weapon", 2, 1)
        self.assertTrue(ok)
        ok, reason = XX.can_equip("weapon", "armor", 2, 1)
        self.assertFalse(ok)
        self.assertEqual(reason, "slot-mismatch")
        ok, reason = XX.can_equip("weapon", "weapon", 0, 1)
        self.assertFalse(ok)
        self.assertEqual(reason, "realm-too-low")
        ok, reason = XX.can_equip("weapon", "orb", 3, 0)
        self.assertFalse(ok)
        self.assertEqual(reason, "unknown-item-slot")


class TalismanTests(unittest.TestCase):
    def test_consume_and_destroy(self):
        self.assertEqual(XX.consume_talisman(3), (2, False))
        self.assertEqual(XX.consume_talisman(1), (0, True))
        self.assertEqual(XX.consume_talisman(0), (0, True))


class FormationPetTests(unittest.TestCase):
    def test_formation_expiry(self):
        self.assertFalse(XX.formation_expired(10.0))
        self.assertTrue(XX.formation_expired(30.0))
        self.assertTrue(XX.formation_expired(5.0, duration=5.0))

    def test_formation_table_shapes(self):
        radius, heal = XX.FORMATION_TYPES["gather"]
        self.assertGreater(radius, 0)
        self.assertGreater(heal, 0)
        radius, slow = XX.FORMATION_TYPES["bind"]
        self.assertEqual(slow, 0.5)

    def test_pet_follow_point(self):
        self.assertEqual(XX.pet_follow_point((10.0, 0.0, 10.0), (0.0, 0.0, 0.0)), (10.0, 0.0, 10.0))
        self.assertIsNone(XX.pet_follow_point((1.0, 0.0, 1.0), (1.0, 0.0, 0.5)))


class CreationPropsTests(unittest.TestCase):
    # DEMO-GAME-009: Account.reqCreateAvatar injects these props; the engine
    # applies each key to the matching entity property.
    def test_creation_props_shape(self):
        props = XX.creation_props("hero", random.Random(7))
        self.assertEqual(set(props), {"name", "spiritRoots"})
        self.assertEqual(props["name"], "hero")
        roots = props["spiritRoots"]
        self.assertEqual(sum(roots.values()), 100)
        self.assertEqual(set(roots), set(XX.ROOT_KEYS))


class DemoConstsTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            'kode_democonsts',
            str(ROOT / 'templates/assets/scripts/common/DemoConsts.py'))
        self.DC = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.DC)

    def test_cultivation_combat_constants(self):
        self.assertEqual(self.DC.CULTIVATION_OVERCOME_RATIO, 1.5)
        self.assertEqual(self.DC.CULTIVATION_GENERATED_RATIO, 0.5)
        self.assertGreater(self.DC.CULTIVATION_SPELL_DAMAGE, 0)
        self.assertGreater(self.DC.CULTIVATION_SPELL_COOLDOWN, 0)

    def test_pet_follow_constants(self):
        self.assertGreater(self.DC.PET_TELEPORT_DISTANCE, self.DC.PET_FOLLOW_DISTANCE)

    def test_talisman_constants(self):
        self.assertGreater(self.DC.TALISMAN_BASE_POWER, 0)
        self.assertGreater(self.DC.TALISMAN_DURATION_SECS, 0)

    def test_formation_constants(self):
        self.assertGreaterEqual(self.DC.FORMATION_MAX_MEMBERS, 2)
        self.assertGreater(self.DC.FORMATION_RADIUS, 0)
        self.assertGreater(self.DC.FORMATION_BUFF_RATIO, 0)

    def test_sect_constants(self):
        self.assertGreaterEqual(self.DC.SECT_MAX_MEMBERS, 2)
        self.assertGreater(self.DC.SECT_CREATE_COST_GOLD, 0)
        self.assertGreater(self.DC.SECT_DONATE_EXP_RATIO, 0)


if __name__ == '__main__':
    unittest.main()
