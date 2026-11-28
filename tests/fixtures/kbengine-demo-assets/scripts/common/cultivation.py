# -*- coding: utf-8 -*-
"""Cultivation MMO demo rules (pure functions, zero KBEngine imports).

DEMO-GAME-008: rule/decision surface split from engine scripts so python3
unit tests can exercise the full rule set directly (same pattern as
monster_ai.py). Engine scripts (base/cell) only gather state and act on
these results. Keep this module importable on any Python 3 without deps.
"""

import math

# ---- Realms (cultivation stages) ----

REALM_NAMES = ("QiRefining", "Foundation", "GoldenCore", "NascentSoul", "SpiritTransform")

# Cumulative experience required to ENTER realm i (index 0 starts at 0).
REALM_EXP = (0, 100, 300, 900, 2700)

MAX_REALM = len(REALM_NAMES) - 1

# Experience gained per practice call (reqPractice on the base side).
PRACTICE_EXP_GAIN = 20


def realm_of(experience):
    """Map cumulative experience -> (realm_index, gained_in_realm, next_need).

    next_need is the experience still required for the next breakthrough,
    or None at the final realm.
    """
    realm = 0
    for i in range(MAX_REALM, -1, -1):
        if experience >= REALM_EXP[i]:
            realm = i
            break
    if realm >= MAX_REALM:
        return (realm, experience - REALM_EXP[realm], None)
    return (realm, experience - REALM_EXP[realm], REALM_EXP[realm + 1] - experience)


def exp_to_breakthrough(experience):
    """Experience still required for the next realm (0 at final realm)."""
    next_need = realm_of(experience)[2]
    return 0 if next_need is None else next_need


# ---- Five spirit roots (wu xing) ----

ROOT_NONE = 0
ROOT_METAL = 1
ROOT_WOOD = 2
ROOT_WATER = 3
ROOT_FIRE = 4
ROOT_EARTH = 5

ROOT_NAMES = {
    ROOT_NONE: "none",
    ROOT_METAL: "metal",
    ROOT_WOOD: "wood",
    ROOT_WATER: "water",
    ROOT_FIRE: "fire",
    ROOT_EARTH: "earth",
}

# Dict keys in ROOT_KEYS[i] correspond to root index i + 1.
ROOT_KEYS = ("metal", "wood", "water", "fire", "earth")

# Generating cycle (xiang sheng): metal->water->wood->fire->earth->metal.
GENERATES = {ROOT_METAL: ROOT_WATER, ROOT_WATER: ROOT_WOOD, ROOT_WOOD: ROOT_FIRE,
             ROOT_FIRE: ROOT_EARTH, ROOT_EARTH: ROOT_METAL}
# Overcoming cycle (xiang ke): metal->wood->earth->water->fire->metal.
OVERCOMES = {ROOT_METAL: ROOT_WOOD, ROOT_WOOD: ROOT_EARTH, ROOT_EARTH: ROOT_WATER,
             ROOT_WATER: ROOT_FIRE, ROOT_FIRE: ROOT_METAL}

# Damage multipliers applied on the cell attack path (DEMO-GAME-012).
AFFINITY_OVERCOME = 1.5    # attacker's root overcomes the defender's
AFFINITY_GENERATE = 1.1    # attacker's root generates the defender's
AFFINITY_OVERCOME_BY = 0.8  # attacker's root is overcome by the defender's
AFFINITY_NEUTRAL = 1.0


def affinity(attacker_root, defender_root):
    """Damage multiplier of attacker root vs defender root (pure wu xing)."""
    if attacker_root == ROOT_NONE or defender_root == ROOT_NONE:
        return AFFINITY_NEUTRAL
    if OVERCOMES.get(attacker_root) == defender_root:
        return AFFINITY_OVERCOME
    if OVERCOMES.get(defender_root) == attacker_root:
        return AFFINITY_OVERCOME_BY
    if GENERATES.get(attacker_root) == defender_root:
        return AFFINITY_GENERATE
    return AFFINITY_NEUTRAL


def roll_spirit_roots(rng):
    """Roll five spirit-root values (ints) summing to 100, dominant 40-60.

    rng is a random.Random-like object (randrange). Returns a dict keyed by
    ROOT_KEYS so engine scripts can store it straight into a FIXED_DICT
    property. The dominant root is picked uniformly; its share is 40-60 and
    the remainder is spread over the other four roots.
    """
    dominant = rng.randrange(0, 5)
    dominant_share = 40 + rng.randrange(0, 21)
    rest = 100 - dominant_share
    values = [0, 0, 0, 0, 0]
    values[dominant] = dominant_share
    # Spread the remainder round-robin from a random starting offset so the
    # split is not always front-loaded.
    order = [(dominant + 1 + k) % 5 for k in range(4)]
    base = rest // 4
    leftover = rest - base * 4
    for k, idx in enumerate(order):
        values[idx] = base + (1 if k < leftover else 0)
    return {ROOT_KEYS[i]: values[i] for i in range(5)}


def dominant_root(roots):
    """Dominant root index from a roots dict (ties resolve to lower index)."""
    best_key, best_value = None, -1
    for key in ROOT_KEYS:
        value = roots.get(key, 0)
        if value > best_value:
            best_key, best_value = key, value
    return ROOT_KEYS.index(best_key) + 1 if best_key is not None else ROOT_NONE


def creation_props(name, rng):
    """Avatar creation props for Account.reqCreateAvatar (DEMO-GAME-009).

    The engine applies each key of the props dict to the matching entity
    property, so "spiritRoots" here lands straight on the SPIRIT_ROOTS
    FIXED_DICT property declared in Avatar.def.
    """
    return {"name": name, "spiritRoots": roll_spirit_roots(rng)}


# ---- Item stacking ----

STACK_MAX = 99


def merge_stack(stacks, item_id, count, capacity):
    """Merge count of item_id into a stack list; returns (stacks, added).

    stacks is a list of {"itemId": int, "count": int} dicts (ITEM_INFO
    FIXED_DICT shape). Existing same-id stacks fill to STACK_MAX first, then
    a new slot opens if capacity allows. Overflow beyond capacity/STACK_MAX
    is dropped and reported through `added`.
    """
    added = 0
    result = [dict(s) for s in stacks]
    for slot in result:
        if added >= count:
            break
        if slot.get("itemId") == item_id and slot.get("count", 0) < STACK_MAX:
            take = min(count - added, STACK_MAX - slot["count"])
            slot["count"] += take
            added += take
    while added < count and len(result) < capacity:
        take = min(count - added, STACK_MAX)
        result.append({"itemId": item_id, "count": take})
        added += take
    return (result, added)


# ---- Equip rules ----

EQUIP_SLOTS = ("weapon", "armor", "accessory")


def can_equip(slot, item_slot, realm, realm_req):
    """Equip gate: slot match + realm requirement. Returns (ok, reason)."""
    if item_slot not in EQUIP_SLOTS:
        return (False, "unknown-item-slot")
    if slot != item_slot:
        return (False, "slot-mismatch")
    if realm < realm_req:
        return (False, "realm-too-low")
    return (True, "")


# ---- Talisman ----

def consume_talisman(charges):
    """Use one charge; returns (remaining, destroyed)."""
    remaining = max(0, charges - 1)
    return (remaining, remaining == 0)


# ---- Formations ----

# type -> (radius, effect param): heal per tick for "gather",
# movement slow factor for "bind".
FORMATION_TYPES = {
    "gather": (8.0, 5),
    "bind": (10.0, 0.5),
}

FORMATION_DURATION = 30.0


def formation_expired(elapsed, duration=None):
    """True once the formation lifetime is spent (None duration = default)."""
    return elapsed >= (FORMATION_DURATION if duration is None else duration)


# ---- Pet follow ----

PET_FOLLOW_DIST = 4.0


def pet_follow_point(owner_pos, pet_pos):
    """Return the owner position tuple when the pet should catch up, else None.

    Positions are (x, y, z) tuples. Keeps the pet from jittering once inside
    the follow radius.
    """
    dist = math.sqrt(sum((a - b) ** 2 for a, b in zip(owner_pos, pet_pos)))
    if dist > PET_FOLLOW_DIST:
        return tuple(owner_pos)
    return None
