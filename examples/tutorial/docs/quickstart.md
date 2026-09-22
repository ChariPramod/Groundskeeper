# Send a message

These steps use the same explicitly named Python session. Each step replays its
earlier setup in a fresh container before checking its own output.

```python groundskeeper:run groundskeeper:session=messaging
from client import Client

client = Client()
```

```python groundskeeper:run groundskeeper:session=messaging
message = "hello"
print(client.send(message))
```

```output
sent: hello
```

```python groundskeeper:run groundskeeper:session=messaging
print(message.upper())
```

```output
HELLO
```
