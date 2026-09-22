# Quickstart

Create a `Client` and call `Client.send` to deliver a message.

The `DEFAULT_TIMEOUT` is 30 seconds.

Use `connect` to open the TypeScript transport.

Call `health` to check readiness.

```python groundskeeper:run
from client import Client

print(Client().send("hello"))
```

```output
sent: hello
```

Runnable Python blocks can be checked with the verification CLI.
