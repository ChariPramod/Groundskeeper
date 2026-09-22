DEFAULT_TIMEOUT = 60


class Client:
    def deliver(self, message: str) -> str:
        return f"sent: {message}"


def health() -> str:
    return "ok"
