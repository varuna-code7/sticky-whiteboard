"""Voice/video call signaling. The audio and video itself never touches the server."""
import server
from tests.helpers import drain, only


def join_call(*clients):
    for c in clients:
        c.emit('call_join')


def test_first_person_sees_nobody_second_sees_the_first(make_client):
    a = make_client('r', 'Anna')
    b = make_client('r', 'Ben')
    drain(a), drain(b)

    join_call(a)
    assert only(drain(a), 'call_peers') == [[]]

    join_call(b)
    peers = only(drain(b), 'call_peers')[0]
    assert peers == [{'id': a.sid, 'name': 'Anna', 'color': a.info['color']}]


def test_call_is_limited_to_four_people(make_client):
    clients = [make_client('r', f'U{i}') for i in range(server.MAX_CALL + 1)]
    for c in clients:
        drain(c)
    join_call(*clients)

    assert len(server.call_members['r']) == server.MAX_CALL
    assert only(drain(clients[-1]), 'call_full') == [{'max': server.MAX_CALL}]


def test_calling_twice_does_not_add_you_twice(make_client):
    a = make_client('r', 'Anna')
    join_call(a, a)
    assert server.call_members['r'] == {a.sid}


def test_signal_goes_only_to_the_target_with_the_senders_details(make_client):
    a, b, c = (make_client('r', n) for n in ('Anna', 'Ben', 'Cleo'))
    join_call(a, b, c)
    drain(a), drain(b), drain(c)

    b.emit('call_signal', {'to': a.sid, 'kind': 'offer', 'sdp': {'type': 'offer', 'sdp': 'x'}})

    got = only(drain(a), 'call_signal')[0]
    assert got['kind'] == 'offer' and got['from'] == b.sid and got['name'] == 'Ben'
    assert got['sdp'] == {'type': 'offer', 'sdp': 'x'}
    assert only(drain(c), 'call_signal') == []


def test_ice_candidates_are_relayed(make_client):
    a, b = make_client('r', 'Anna'), make_client('r', 'Ben')
    join_call(a, b)
    drain(a), drain(b)

    b.emit('call_signal', {'to': a.sid, 'kind': 'candidate', 'candidate': {'c': 1}})

    assert only(drain(a), 'call_signal')[0]['candidate'] == {'c': 1}


def test_outsiders_and_non_members_cannot_signal(make_client):
    a = make_client('r', 'Anna')
    other_room = make_client('other', 'Zed')
    not_in_call = make_client('r', 'Nina')
    join_call(a, other_room)
    drain(a)

    other_room.emit('call_signal', {'to': a.sid, 'kind': 'offer'})     # different room
    not_in_call.emit('call_signal', {'to': a.sid, 'kind': 'offer'})    # same room, never joined the call
    a.emit('call_signal', {'to': not_in_call.sid, 'kind': 'offer'})    # target is not in the call

    assert only(drain(a), 'call_signal') == []
    assert only(drain(not_in_call), 'call_signal') == []


def test_bad_signal_data_is_ignored(make_client):
    a = make_client('r', 'Anna')
    join_call(a)
    a.emit('call_signal', 'not a dict')
    a.emit('call_signal', {})
    assert server.call_members['r'] == {a.sid}


def test_leaving_tells_the_room_and_cleans_up(make_client):
    a, b = make_client('r', 'Anna'), make_client('r', 'Ben')
    join_call(a, b)
    drain(a)

    b.emit('call_leave')

    assert only(drain(a), 'call_peer_left') == [{'id': b.sid}]
    assert server.call_members['r'] == {a.sid}


def test_last_person_leaving_removes_the_call(make_client):
    a = make_client('r', 'Anna')
    join_call(a)
    a.emit('call_leave')
    assert 'r' not in server.call_members


def test_closing_the_tab_leaves_the_call(make_client):
    a, b = make_client('r', 'Anna'), make_client('r', 'Ben')
    join_call(a, b)
    drain(a)
    b_sid = b.sid

    b.disconnect()

    assert b_sid not in server.call_members['r']
    assert only(drain(a), 'call_peer_left') == [{'id': b_sid}]


def test_switching_boards_leaves_the_call(make_client):
    a, b = make_client('r1', 'Anna'), make_client('r1', 'Ben')
    join_call(a, b)
    drain(b)

    a.emit('join', {'room': 'r2', 'name': 'Anna'})

    assert server.call_members['r1'] == {b.sid}
    assert only(drain(b), 'call_peer_left') == [{'id': a.sid}]