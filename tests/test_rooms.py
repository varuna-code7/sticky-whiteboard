"""Boards (rooms) must be separate from each other."""
import server
from tests.conftest import board_of, note
from tests.helpers import drain, only


def test_new_joiner_gets_the_current_board(make_client):
    a = make_client('r1', 'A')
    a.emit('note_created', note('n1'))

    b = server.socketio.test_client(server.app)
    b.emit('join', {'room': 'r1', 'name': 'B'})
    state = only(drain(b), 'board_state')[0]

    assert 'n1' in state['notes']
    assert state['deleted'] == {}


def test_note_reaches_others_in_the_room_but_not_the_sender(make_client):
    a = make_client('r1', 'A')
    b = make_client('r1', 'B')
    drain(a), drain(b)

    a.emit('note_created', note('n1'))

    assert only(drain(b), 'note_created')[0]['id'] == 'n1'
    assert only(drain(a), 'note_created') == []


def test_other_rooms_never_see_the_note(make_client):
    a = make_client('r1', 'A')
    c = make_client('r2', 'C')
    drain(a), drain(c)

    a.emit('note_created', note('n1'))

    assert only(drain(c), 'note_created') == []
    assert 'n1' not in board_of('r2')['notes']


def test_clear_board_only_clears_its_own_room(make_client):
    a = make_client('r1', 'A')
    c = make_client('r2', 'C')
    a.emit('note_created', note('n1'))
    c.emit('note_created', note('n2'))
    drain(a), drain(c)

    a.emit('clear_board')

    assert board_of('r1')['notes'] == {}
    assert 'n2' in board_of('r2')['notes']
    assert 'board_cleared' in [name for name, _ in drain(a)]   # the sender is told too
    assert 'board_cleared' not in [name for name, _ in drain(c)]


def test_room_names_from_the_url_are_cleaned():
    assert server.clean_room_id('../../Bad Room!!') == 'badroom'
    assert server.clean_room_id('ABC-def_123') == 'abc-def_123'
    assert server.clean_room_id('') == 'main'
    assert server.clean_room_id(None) == 'main'
    assert server.clean_room_id('<script>') == 'script'
    assert len(server.clean_room_id('a' * 100)) == 32


def test_events_before_joining_a_room_are_ignored(make_client):
    lonely = make_client(join=False)

    lonely.emit('note_created', note('n1'))
    lonely.emit('note_deleted', {'id': 'n1'})
    lonely.emit('clear_board')
    lonely.emit('cursor_move', {'x': 1, 'y': 2})

    assert server.boards == {}


def test_cursor_goes_to_the_room_with_name_and_color(make_client):
    a = make_client('r1', 'Anna')
    b = make_client('r1', 'Ben')
    c = make_client('r2', 'Cleo')
    drain(a), drain(b), drain(c)

    a.emit('cursor_move', {'x': 5, 'y': 6})

    cursor = only(drain(b), 'cursor_move')[0]
    assert cursor == {'id': a.sid, 'x': 5, 'y': 6, 'color': a.info['color'], 'name': 'Anna'}
    assert only(drain(c), 'cursor_move') == []
    assert only(drain(a), 'cursor_move') == []


def test_switching_rooms_leaves_the_old_one(make_client):
    a = make_client('r1', 'A')
    b = make_client('r1', 'B')
    drain(a), drain(b)

    a.emit('join', {'room': 'r2', 'name': 'A'})
    messages = drain(b)
    assert only(messages, 'user_disconnected') == [{'id': a.sid}]

    b.emit('note_created', note('n1'))
    assert only(drain(a), 'note_created') == []     # A no longer hears room r1