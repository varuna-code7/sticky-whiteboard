import os
import random
import re
import time
from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# --- Serve the web page itself ---
# Open http://127.0.0.1:5000 and the whole app loads from here, so you
# don't need Live Server. Only these files are shared, nothing else in the
# folder (server.py, .venv, .git and so on stay private).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_FILES = {'index.html', 'app.js', 'call.js', 'style.css', 'socket.io.min.js', 'camtest.html'}


@app.route('/')
def serve_index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_public_file(filename):
    if filename in PUBLIC_FILES:
        return send_from_directory(BASE_DIR, filename)
    return 'Not found', 404

# --- Rooms ---
# Every board lives in its own "room". A room has its own notes and its own
# tombstones (the "this note was deleted" markers, see is_tombstoned).
# Socket.IO rooms make sure an update is only sent to people in that room.
boards = {}  # room_id -> {'notes': {...}, 'deleted': {...}}

# Colors for cursors. Inside one room each user gets a DIFFERENT color
# (first one nobody in the room is using), so "which color is who" in the
# top bar is never ambiguous.
COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#8338ec',
          '#fb5607', '#3a86ff', '#ff006e', '#06d6a0']
connected_users = {}  # socket_id -> {name, color, room}


def pick_color(room, sid):
    used = {u['color'] for s, u in connected_users.items()
            if u['room'] == room and s != sid}
    free = [c for c in COLORS if c not in used]
    return free[0] if free else random.choice(COLORS)  # >8 users: reuse


def clean_name(raw):
    # Names come from the browser, so never trust them: trim, collapse
    # spaces, max 20 characters. (The client shows names as plain text,
    # never as HTML.)
    name = ' '.join(str(raw or '').split())[:20]
    return name or 'Guest'

# --- Voice/video calls ---
# The audio and video do NOT go through this server. Browsers send them
# directly to each other (WebRTC). This server only passes the small
# "hello, here's how to reach me" messages between them (called signaling),
# and keeps track of who is in each room's call.
MAX_CALL = 4  # everyone connects to everyone, so keep calls small
call_members = {}  # room -> set of socket ids currently in the call


def remove_from_call(sid, room):
    members = call_members.get(room)
    if members and sid in members:
        members.discard(sid)
        emit('call_peer_left', {'id': sid}, to=room)
        if not members:
            call_members.pop(room, None)


ROOM_PATTERN = re.compile(r'[^a-z0-9_-]')


def clean_room_id(raw):
    # Room ids come from the URL, so never trust them: lowercase letters,
    # digits, - and _ only, max 32 characters.
    room = ROOM_PATTERN.sub('', str(raw or '').lower())[:32]
    return room or 'main'


def get_board(room):
    if room not in boards:
        boards[room] = {'notes': {}, 'deleted': {}}
    return boards[room]


def current_room():
    user = connected_users.get(request.sid)
    return user['room'] if user else None


def is_tombstoned(board, note_id, incoming_time):
    # An edit that is NOT newer than the delete is stale -> ignore it
    deleted = board['deleted']
    return note_id in deleted and incoming_time <= deleted[note_id]


def broadcast_user_list(room):
    users = [
        {'id': sid, 'name': u['name'], 'color': u['color']}
        for sid, u in connected_users.items() if u['room'] == room
    ]
    emit('users_update', users, to=room)


@socketio.on('connect')
def handle_connect():
    sid = request.sid
    connected_users[sid] = {'name': 'Guest', 'color': COLORS[0], 'room': None}
    print('A user connected:', sid)
    # Name, color and board are sent later, when the user tells us WHICH
    # room they want and WHO they are ('join').


@socketio.on('join')
def handle_join(data):
    sid = request.sid
    user = connected_users.get(sid)
    if not user:
        return

    room = clean_room_id((data or {}).get('room'))

    # Switching rooms: leave the old one first
    old_room = user['room']
    if old_room and old_room != room:
        remove_from_call(sid, old_room)
        leave_room(old_room)
        user['room'] = None
        emit('user_disconnected', {'id': sid}, to=old_room)
        broadcast_user_list(old_room)

    join_room(room)
    user['name'] = clean_name((data or {}).get('name'))
    user['color'] = pick_color(room, sid)
    user['room'] = room
    board = get_board(room)
    print(f'{user["name"]} ({sid}) joined room "{room}"')

    # Tell this user their own id, name and color
    emit('your_info', {'id': sid, 'name': user['name'], 'color': user['color']})
    # Send the room's current board to the newly joined user
    emit('board_state', {'notes': board['notes'], 'deleted': board['deleted']})
    broadcast_user_list(room)


@socketio.on('set_name')
def handle_set_name(data):
    # A user renamed themselves: update and tell the whole room
    user = connected_users.get(request.sid)
    if not user or not user['room']:
        return
    user['name'] = clean_name((data or {}).get('name'))
    emit('your_info', {'id': request.sid, 'name': user['name'], 'color': user['color']})
    broadcast_user_list(user['room'])


@socketio.on('note_created')
def handle_note_created(data):
    room = current_room()
    if not room:
        return
    board = get_board(room)
    note_id = data['id']
    if is_tombstoned(board, note_id, data.get('updatedAt', 0)):
        return  # an old copy of a deleted note, ignore it
    board['deleted'].pop(note_id, None)  # newer than the delete -> note is back (undo)
    board['notes'][note_id] = data
    emit('note_created', data, to=room, include_self=False)


@socketio.on('note_moved')
def handle_note_moved(data):
    room = current_room()
    if not room:
        return {'status': 'no_room'}
    board = get_board(room)
    notes = board['notes']
    note_id = data['id']
    incoming_time = data.get('updatedAt', 0)

    if is_tombstoned(board, note_id, incoming_time):
        return  # a late move for a note that was already deleted

    if note_id in notes:
        existing_time = notes[note_id].get('updatedAt', 0)
        # LWW rule: only apply this edit if it's newer than what we already have.
        # If an older/delayed message arrives after a newer one, we silently
        # drop it — this is what makes conflicting edits converge correctly.
        if incoming_time < existing_time:
            return  # stale update, ignore it

        notes[note_id]['x'] = data['x']
        notes[note_id]['y'] = data['y']
        notes[note_id]['updatedAt'] = incoming_time
    else:
        board['deleted'].pop(note_id, None)
        notes[note_id] = data

    emit('note_moved', data, to=room, include_self=False)
    return {'status': 'ok'}  # ack, used for latency measurement in load tests


@socketio.on('note_text_changed')
def handle_note_text_changed(data):
    room = current_room()
    if not room:
        return
    board = get_board(room)
    notes = board['notes']
    note_id = data['id']
    incoming_time = data.get('updatedAt', 0)

    if is_tombstoned(board, note_id, incoming_time):
        return  # late edit for a note that was already deleted

    if note_id in notes:
        existing_time = notes[note_id].get('updatedAt', 0)
        if incoming_time < existing_time:
            return  # stale edit, drop it (same LWW rule as note_moved)
        notes[note_id]['text'] = data['text']
        notes[note_id]['updatedAt'] = incoming_time

    emit('note_text_changed', data, to=room, include_self=False)


@socketio.on('note_deleted')
def handle_note_deleted(data):
    room = current_room()
    if not room:
        return
    board = get_board(room)
    notes, deleted = board['notes'], board['deleted']
    note_id = data['id']
    deleted_at = data.get('deletedAt') or int(time.time() * 1000)

    # LWW again: if someone edited the note AFTER this delete happened
    # (e.g. while the deleter was offline), the newer edit wins.
    if note_id in notes and notes[note_id].get('updatedAt', 0) > deleted_at:
        return

    notes.pop(note_id, None)
    deleted[note_id] = max(deleted.get(note_id, 0), deleted_at)
    data['deletedAt'] = deleted_at
    emit('note_deleted', data, to=room, include_self=False)


@socketio.on('clear_board')
def handle_clear_board():
    room = current_room()
    if not room:
        return
    board = get_board(room)
    now = int(time.time() * 1000)
    for note_id, note in board['notes'].items():
        board['deleted'][note_id] = max(now, note.get('updatedAt', 0))
    board['notes'].clear()
    # Everyone in THIS room (including the sender) sees the board clear.
    # Other rooms are not touched.
    emit('board_cleared', to=room)


@socketio.on('cursor_move')
def handle_cursor_move(data):
    sid = request.sid
    user = connected_users.get(sid)
    if not user or not user['room']:
        return
    emit('cursor_move', {
        'id': sid,
        'x': data['x'],
        'y': data['y'],
        'color': user['color'],
        'name': user['name']
    }, to=user['room'], include_self=False)


@socketio.on('call_join')
def handle_call_join():
    sid = request.sid
    user = connected_users.get(sid)
    if not user or not user['room']:
        return
    room = user['room']
    members = call_members.setdefault(room, set())

    if sid in members:
        return
    if len(members) >= MAX_CALL:
        emit('call_full', {'max': MAX_CALL})
        return

    # Tell the newcomer who is already in the call. The newcomer is the one
    # who starts the connection to each of them.
    existing = [
        {'id': m, 'name': connected_users[m]['name'], 'color': connected_users[m]['color']}
        for m in members if m in connected_users
    ]
    members.add(sid)
    print(f'{user["name"]} joined the CALL in room "{room}" ({len(members)} in call)')
    emit('call_peers', existing)


@socketio.on('call_signal')
def handle_call_signal(data):
    # Pass a connection message (offer / answer / network candidate) from
    # one person in the call to ONE other person in the same call.
    sid = request.sid
    user = connected_users.get(sid)
    if not user or not user['room'] or not isinstance(data, dict):
        return
    members = call_members.get(user['room'], set())
    target = data.get('to')
    if sid not in members or target not in members:
        return

    if data.get('kind') != 'candidate':  # candidates are too noisy to print
        print(f'call: {data.get("kind")} from {user["name"]} -> {connected_users[target]["name"]}')
    payload = {k: data[k] for k in ('kind', 'sdp', 'candidate') if k in data}
    payload.update({'from': sid, 'name': user['name'], 'color': user['color']})
    emit('call_signal', payload, to=target)


@socketio.on('call_leave')
def handle_call_leave():
    user = connected_users.get(request.sid)
    if user and user['room']:
        print(f'{user["name"]} left the CALL in room "{user["room"]}"')
        remove_from_call(request.sid, user['room'])


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    print('A user disconnected:', sid)
    user = connected_users.pop(sid, None)
    if user and user['room']:
        room = user['room']
        remove_from_call(sid, room)
        # Tell the room to remove this user's cursor and update the avatars
        emit('user_disconnected', {'id': sid}, to=room)
        broadcast_user_list(room)


if __name__ == '__main__':
    socketio.run(app, debug=True, port=5000)