"""Last-Writer-Wins and tombstones: the rules that keep every screen the same."""
import server
from tests.conftest import board_of, note
from tests.helpers import drain, only


def two_users(make_client, **note_kwargs):
    a = make_client('room1', 'A')
    b = make_client('room1', 'B')
    a.emit('note_created', note(**note_kwargs))
    drain(a), drain(b)
    return a, b


# ---------- Last-Writer-Wins ----------

def test_newer_move_is_applied_and_forwarded(make_client):
    a, b = two_users(make_client)
    a.emit('note_moved', {'id': 'n1', 'x': 99, 'y': 88, 'updatedAt': 2000})

    saved = board_of()['notes']['n1']
    assert (saved['x'], saved['y'], saved['updatedAt']) == (99, 88, 2000)
    assert only(drain(b), 'note_moved')[0]['x'] == 99


def test_stale_move_is_ignored(make_client):
    a, b = two_users(make_client, updated_at=5000)
    a.emit('note_moved', {'id': 'n1', 'x': 1, 'y': 1, 'updatedAt': 4000})

    saved = board_of()['notes']['n1']
    assert (saved['x'], saved['y']) == (10, 20)           # unchanged
    assert only(drain(b), 'note_moved') == []             # and not forwarded


def test_newer_text_wins_and_stale_text_loses(make_client):
    a, b = two_users(make_client, updated_at=1000)

    a.emit('note_text_changed', {'id': 'n1', 'text': 'newer', 'updatedAt': 3000})
    a.emit('note_text_changed', {'id': 'n1', 'text': 'older', 'updatedAt': 2000})

    assert board_of()['notes']['n1']['text'] == 'newer'
    forwarded = only(drain(b), 'note_text_changed')
    assert [m['text'] for m in forwarded] == ['newer']


def test_move_is_acknowledged(make_client):
    a, _ = two_users(make_client)
    ack = a.emit('note_moved', {'id': 'n1', 'x': 1, 'y': 1, 'updatedAt': 2000}, callback=True)
    assert ack == {'status': 'ok'}


# ---------- Tombstones ----------

def test_delete_removes_the_note_and_leaves_a_tombstone(make_client):
    a, b = two_users(make_client)
    a.emit('note_deleted', {'id': 'n1', 'deletedAt': 2000})

    assert 'n1' not in board_of()['notes']
    assert board_of()['deleted'] == {'n1': 2000}
    assert only(drain(b), 'note_deleted') == [{'id': 'n1', 'deletedAt': 2000}]
    assert only(drain(a), 'note_deleted') == []           # sender is not echoed


def test_delete_without_a_time_uses_the_server_clock(make_client):
    a, _ = two_users(make_client)
    a.emit('note_deleted', {'id': 'n1'})
    assert board_of()['deleted']['n1'] > 0


def test_late_messages_cannot_bring_a_deleted_note_back(make_client):
    a, b = two_users(make_client)
    a.emit('note_deleted', {'id': 'n1', 'deletedAt': 2000})
    drain(b)

    a.emit('note_moved', {'id': 'n1', 'x': 5, 'y': 5, 'updatedAt': 1500})
    a.emit('note_text_changed', {'id': 'n1', 'text': 'ghost', 'updatedAt': 1500})
    a.emit('note_created', note('n1', updated_at=1000))     # old copy from an offline device

    assert 'n1' not in board_of()['notes']
    assert only(drain(b), 'note_created') == []


def test_a_newer_create_brings_the_note_back_like_undo(make_client):
    a, b = two_users(make_client)
    a.emit('note_deleted', {'id': 'n1', 'deletedAt': 2000})
    drain(b)

    a.emit('note_created', note('n1', updated_at=3000, text='back'))

    assert board_of()['notes']['n1']['text'] == 'back'
    assert 'n1' not in board_of()['deleted']
    assert only(drain(b), 'note_created')[0]['id'] == 'n1'


def test_an_edit_newer_than_the_delete_wins(make_client):
    a, b = two_users(make_client)
    a.emit('note_moved', {'id': 'n1', 'x': 1, 'y': 1, 'updatedAt': 5000})
    drain(b)

    a.emit('note_deleted', {'id': 'n1', 'deletedAt': 4000})   # the delete happened earlier

    assert 'n1' in board_of()['notes']
    assert only(drain(b), 'note_deleted') == []


def test_clear_board_leaves_tombstones_for_every_note(make_client):
    a, b = two_users(make_client)
    a.emit('note_created', note('n2', updated_at=2000))

    a.emit('clear_board')

    deleted = board_of()['deleted']
    assert set(deleted) == {'n1', 'n2'}
    a.emit('note_moved', {'id': 'n1', 'x': 7, 'y': 7, 'updatedAt': 1500})   # late move
    assert board_of()['notes'] == {}


def test_new_joiner_receives_the_tombstones(make_client):
    a, _ = two_users(make_client)
    a.emit('note_deleted', {'id': 'n1', 'deletedAt': 2000})

    late = server.socketio.test_client(server.app)
    late.emit('join', {'room': 'room1', 'name': 'Late'})
    state = only(drain(late), 'board_state')[0]

    assert state['deleted'] == {'n1': 2000}
    assert state['notes'] == {}