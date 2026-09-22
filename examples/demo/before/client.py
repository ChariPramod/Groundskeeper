DEFAULT_TIMEOUT = 30


class Client:
    def send(self, message: str) -> str:
        return f"sent: {message}"


def health() -> str:
    return "ok"
