class HealthMixin:
    def take_damage(self, amount):
        raise RuntimeError("Wrong package: legacy health must never be selected")
