# -*- coding: utf-8 -*-
import KBEngine


# Inventory bag component, base-side class (DEMO-GAME-013 component).
# The engine instantiates a component from the script module of the app it
# runs on: cellapp imports scripts/cell/Inventory.py, baseapp imports
# scripts/base/Inventory.py. A missing base-side class leaves the component
# attribute absent on base entities (reqDepotDeposit/reqForgeEquip read
# self.bag on the base side; real-machine finding 2026-11-28, same lesson
# as the per-entity base script import). No behavior lives here: bag writes
# stay on the cell side (killer.bag.addItem in the loot flow); base-side
# depot flows consume the component data.
class Inventory(KBEngine.EntityComponent):
	def __init__(self):
		KBEngine.EntityComponent.__init__(self)
