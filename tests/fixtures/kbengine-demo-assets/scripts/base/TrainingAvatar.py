import KBEngine


class TrainingAvatar(KBEngine.Entity):
    def runtime_role(self):
        return "base"

    def describe_role(self):
        return self.runtime_role()  # nav: base-role

    def reqEnterArena(self):
        return "ready"
