"""Names and colors."""
import server
from tests.helpers import drain, only


def test_names_are_cleaned(make_client):
    assert make_client('r', '  Priya   K  ').info['name'] == 'Priya K'
    assert make_client('r', 'x' * 40).info['name'] == 'x' * 20
    assert make_client('r', '').info['name'] == 'Guest'
    assert make_client('r', None).info['name'] == 'Guest'


def test_markup_in_a_name_is_just_text(make_client):
    evil = make_client('r', '<script>alert(1)</script>')
    assert evil.info['name'] == '<script>alert(1)</sc'    # cut to 20 chars, stays plain text


def test_everyone_in_a_room_gets_a_different_color(make_client):
    clients = [make_client('r', f'U{i}') for i in range(len(server.COLORS))]
    colors = {c.info['color'] for c in clients}
    assert len(colors) == len(server.COLORS)


def test_a_ninth_user_still_gets_a_valid_color(make_client):
    clients = [make_client('r', f'U{i}') for i in range(len(server.COLORS) + 1)]
    assert clients[-1].info['color'] in server.COLORS


def test_different_rooms_can_reuse_colors(make_client):
    a = make_client('r1', 'A')
    b = make_client('r2', 'B')
    assert a.info['color'] == b.info['color'] == server.COLORS[0]


def test_users_update_lists_id_name_and_color(make_client):
    a = make_client('r', 'Anna')
    drain(a)
    b = make_client('r', 'Ben')

    users = only(drain(a), 'users_update')[-1]
    assert {(u['name'], u['color']) for u in users} == {('Anna', a.info['color']), ('Ben', b.info['color'])}
    assert {u['id'] for u in users} == {a.sid, b.sid}


def test_rename_updates_everyone(make_client):
    a = make_client('r', 'Anna')
    b = make_client('r', 'Ben')
    drain(a), drain(b)

    b.emit('set_name', {'name': '  Benny   Boy '})

    users = only(drain(a), 'users_update')[-1]
    assert [u['name'] for u in users if u['id'] == b.sid] == ['Benny Boy']
    assert only(drain(b), 'your_info')[-1]['name'] == 'Benny Boy'


def test_leaving_removes_the_cursor_and_the_avatar(make_client):
    a = make_client('r', 'Anna')
    b = make_client('r', 'Ben')
    drain(a)

    b_sid = b.sid
    b.disconnect()

    messages = drain(a)
    assert only(messages, 'user_disconnected') == [{'id': b_sid}]
    assert [u['id'] for u in only(messages, 'users_update')[-1]] == [a.sid]