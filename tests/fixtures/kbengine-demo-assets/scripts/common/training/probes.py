class Unrelated:
    def phantom_hit(self):
        raise RuntimeError("Not a member of NavigationProbe or its helper")


class NavigationProbe:
    def closure(self):
        def local_only():
            return True
        return local_only()

    def broken_receiver(self):
        return self.helper.phantom_hit()  # nav: unknown-receiver

    def missing_method(self):
        return self.local_only()  # nav: closure-is-not-method

    def text_only(self):
        # self.phantom_hit()  # nav: ignore-comment
        return "self.phantom_hit()"  # nav: ignore-string
