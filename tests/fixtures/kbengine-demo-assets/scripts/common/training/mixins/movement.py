class BoundsMixin:
    def can_move(self, dx, dz):
        x, _, z = self.position
        return 0 <= x + dx < 7 and 0 <= z + dz < 5


class MovementMixin:
    def step(self, dx, dz):
        if not self.can_move(dx, dz):  # nav: sibling-bounds
            return False
        x, y, z = self.position
        self.position = (x + dx, y, z + dz)
        return True
