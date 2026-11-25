"""Small helpers shared by the server tests."""


def drain(client):
    """Everything the client received since the last call, as (event, first_argument) pairs."""
    return [(m['name'], m['args'][0] if m['args'] else None) for m in client.get_received()]


def only(messages, event):
    """From a drain() result, keep just the arguments of one kind of event."""
    return [arg for name, arg in messages if name == event]