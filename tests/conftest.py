import pytest

import server
from tests.helpers import drain, only


@pytest.fixture(autouse=True)
def clean_server_state():
    """Every test starts with an empty server: no boards, no users, no calls."""
    server.boards.clear()
    server.connected_users.clear()
    server.call_members.clear()
    yield


@pytest.fixture
def make_client():
    """Create a fake browser. It joins a room with a name unless join=False.

    The client gets .info (its own id/name/color from the server) and .sid.
    Its message queue is emptied after joining, so each test only sees new messages.
    """
    created = []

    def _make(room='room1', name='User', join=True):
        client = server.socketio.test_client(server.app)
        client.info = None
        client.sid = None
        if join:
            client.emit('join', {'room': room, 'name': name})
            infos = only(drain(client), 'your_info')
            if infos:
                client.info = infos[-1]
                client.sid = client.info['id']
        created.append(client)
        return client

    yield _make

    for client in created:
        if client.is_connected():
            client.disconnect()


def note(note_id='n1', updated_at=1000, **extra):
    """A minimal note, like the browser sends it."""
    data = {'id': note_id, 'x': 10, 'y': 20, 'text': 'hello',
            'updatedAt': updated_at, 'rotation': 0, 'colorIndex': 0, 'noteType': 'sticky'}
    data.update(extra)
    return data


def board_of(room='room1'):
    return server.boards[room]