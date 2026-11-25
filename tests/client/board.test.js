'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupPages, sleep } = require('./helpers');

const make = setupPages(afterEach);

// A note as the server would send it
const serverNote = (id, extra = {}) => ({
  id, x: 10, y: 20, text: 'hi', updatedAt: 1000, rotation: 0, colorIndex: 0, noteType: 'sticky', ...extra,
});

// ---------------------------------------------------------------- note types

test('sticky notes tilt a little; paper and slide notes stay straight', () => {
  const p = make();
  for (let i = 0; i < 30; i++) p.run(`createNote(0, 0, '', 's${i}')`);
  p.run("createNote(0, 0, '', 'paper1', false, null, null, 'paper')");
  p.run("createNote(0, 0, '', 'slide1', false, null, null, 'slide')");

  const byId = Object.fromEntries(p.notes().map((n) => [n.id, n]));
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(byId[`s${i}`].rotation) <= 3);
  assert.equal(byId.paper1.rotation, 0);
  assert.equal(byId.slide1.rotation, 0);
  assert.ok(p.$('[data-id="paper1"]').classList.contains('type-paper'));
  assert.ok(p.$('[data-id="slide1"]').classList.contains('type-slide'));
});

test('the New Note menu creates the chosen type and tells the server', () => {
  const p = make();
  p.click('#addNoteBtn');
  assert.ok(p.$('#noteTypeMenu').classList.contains('open'));
  p.click('#noteTypeMenu [data-type="slide"]');

  assert.equal(p.noteEls().length, 1);
  assert.ok(!p.$('#noteTypeMenu').classList.contains('open'));
  assert.equal(p.sentOf('note_created')[0].noteType, 'slide');
});

test('the same note id is never shown twice', () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'dup', true)");
  p.run("createNote(2, 2, 'b', 'dup', true)");
  assert.equal(p.noteEls().length, 1);
  assert.equal(p.notes().length, 1);
});

test('notes that came from the server are not sent back to it', () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'fromServer1', true)");
  assert.deepEqual(p.sentOf('note_created'), []);
});

// ---------------------------------------------------------------- delete

test('delete button removes the note, tells the server and leaves a tombstone', () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'n1')");
  p.click('.note-delete');

  assert.equal(p.noteEls().length, 0);
  const sent = p.sentOf('note_deleted')[0];
  assert.equal(sent.id, 'n1');
  assert.equal(typeof sent.deletedAt, 'number');
  assert.ok('n1' in JSON.parse(p.saved('whiteboard_tombstones_testroom')));
});

test('a remote delete removes the note and is remembered', async () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'n1', true)");
  await p.fire('note_deleted', { id: 'n1', deletedAt: 5000 });

  assert.equal(p.noteEls().length, 0);
  assert.equal(p.js('tombstones.n1'), 5000);
});

test('Delete All (board_cleared) empties the board and the undo history', async () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'n1')");
  p.run("createNote(1, 1, 'b', 'n2')");
  await p.fire('board_cleared');

  assert.equal(p.noteEls().length, 0);
  assert.equal(p.js('undoStack.length'), 0);
  assert.ok(p.$('#undoBtn').disabled);
  assert.deepEqual(Object.keys(p.js('tombstones')).sort(), ['n1', 'n2']);
});

// ---------------------------------------------------------------- undo / redo

test('undo and redo buttons start disabled', () => {
  const p = make();
  assert.ok(p.$('#undoBtn').disabled);
  assert.ok(p.$('#redoBtn').disabled);
  p.run('undo()'); p.run('redo()');      // must not crash on empty history
  assert.deepEqual(p.errors, []);
});

test('undo of a delete brings the note back; redo deletes it again', () => {
  const p = make();
  p.click('#addNoteBtn');
  p.click('#noteTypeMenu [data-type="paper"]');
  const id = p.notes()[0].id;
  p.click('.note-delete');
  assert.equal(p.noteEls().length, 0);

  p.clearSent();
  p.run('undo()');
  assert.equal(p.noteEls().length, 1);
  assert.equal(p.sentOf('note_created')[0].id, id);          // others get it back too
  assert.equal(p.js(`tombstones[${JSON.stringify(id)}]`), undefined);   // no longer marked deleted
  assert.ok(p.$('.note').classList.contains('type-paper'));  // same type as before

  p.run('redo()');
  assert.equal(p.noteEls().length, 0);
});

test('undo of a create removes the note; redo restores it with its text', () => {
  const p = make();
  p.click('#addNoteBtn');
  p.click('#noteTypeMenu [data-type="sticky"]');
  p.run("setNoteText(notes[0].id, 'typed after create')");

  p.run('undo()');
  assert.equal(p.noteEls().length, 0);
  p.run('redo()');
  assert.equal(p.noteEls().length, 1);
  assert.equal(p.notes()[0].text, 'typed after create');
});

test('undo and redo a move put the note back and tell the server', () => {
  const p = make();
  p.run("createNote(10, 10, '', 'm1')");
  p.run("pushHistory({ type: 'move', id: 'm1', from: { x: 10, y: 10 }, to: { x: 50, y: 60 } })");
  p.run("setNotePosition('m1', 50, 60)");

  p.clearSent();
  p.run('undo()');
  assert.deepEqual([p.notes()[0].x, p.notes()[0].y], [10, 10]);
  assert.deepEqual(p.sentOf('note_moved').map((m) => [m.x, m.y]), [[10, 10]]);

  p.run('redo()');
  assert.deepEqual([p.notes()[0].x, p.notes()[0].y], [50, 60]);
});

test('a new action clears the redo list', () => {
  const p = make();
  p.run("createNote(1, 1, '', 'a')");
  p.run("pushHistory({ type: 'create', note: snapshotNote('a') })");
  p.run('undo()');
  assert.ok(!p.$('#redoBtn').disabled);

  p.click('#addNoteBtn');
  p.click('#noteTypeMenu [data-type="sticky"]');
  assert.ok(p.$('#redoBtn').disabled);
});

test('typing is sent after a short pause and can be undone', async () => {
  const p = make();
  p.run("createNote(1, 1, '', 't1')");
  const box = p.$('.note textarea');
  box.value = 'hello';
  box.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await sleep(300);

  assert.equal(p.sentOf('note_text_changed').pop().text, 'hello');
  p.run('undo()');
  assert.equal(box.value, '');
  assert.equal(p.sentOf('note_text_changed').pop().text, '');
});

// ---------------------------------------------------------------- reconnect merge

test('reconnect: a delete made by someone else removes our copy', async () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'x1', true)");
  p.run("notes[0].updatedAt = 1000");
  await p.fire('board_state', { notes: {}, deleted: { x1: 2000 } });

  assert.equal(p.noteEls().length, 0);
  assert.equal(p.js('tombstones.x1'), 2000);
});

test('reconnect: our newer edit beats an older delete and is sent back up', async () => {
  const p = make();
  p.run("createNote(1, 1, 'a', 'x1', true)");
  p.run("notes[0].updatedAt = 9000");
  p.clearSent();
  await p.fire('board_state', { notes: {}, deleted: { x1: 2000 } });

  assert.equal(p.noteEls().length, 1);
  assert.equal(p.sentOf('note_created')[0].id, 'x1');
});

test('reconnect: a delete we made while offline is sent and the note stays gone', async () => {
  const p = make({ connected: false });
  p.run("createNote(1, 1, 'a', 'o1', true)");
  p.click('.note-delete');
  p.clearSent();

  p.socket.connected = true;
  await p.fire('board_state', { notes: { o1: serverNote('o1', { updatedAt: 1 }) }, deleted: {} });

  assert.equal(p.noteEls().length, 0);
  assert.equal(p.sentOf('note_deleted')[0].id, 'o1');
});

test('reconnect: someone edited a note after we deleted it, so it comes back', async () => {
  const p = make({ connected: false });
  p.run("createNote(1, 1, 'a', 'o1', true)");
  p.click('.note-delete');
  const deletedAt = p.js('tombstones.o1');
  p.clearSent();

  p.socket.connected = true;
  await p.fire('board_state', { notes: { o1: serverNote('o1', { updatedAt: deletedAt + 5000, text: 'edited' }) }, deleted: {} });

  assert.equal(p.noteEls().length, 1);
  assert.equal(p.notes()[0].text, 'edited');
  assert.deepEqual(p.sentOf('note_deleted'), []);
});

test('reconnect: notes made offline are sent to the server', async () => {
  const p = make({ connected: false });
  p.run("createNote(1, 1, 'made offline', 'off1')");
  p.clearSent();

  p.socket.connected = true;
  await p.fire('board_state', { notes: {}, deleted: {} });

  assert.equal(p.sentOf('note_created')[0].id, 'off1');
});

test('reconnect: notes we do not have yet are created, with their type', async () => {
  const p = make();
  await p.fire('board_state', { notes: { s1: serverNote('s1', { noteType: 'paper', text: 'from server' }) }, deleted: {} });

  assert.equal(p.noteEls().length, 1);
  assert.ok(p.$('.note').classList.contains('type-paper'));
  assert.equal(p.$('.note textarea').value, 'from server');
});

test('reconnect: the newer version wins, in both directions', async () => {
  const p = make();
  p.run("createNote(1, 1, 'local old', 'a', true); createNote(1, 1, 'local new', 'b', true)");
  p.run("notes.find(n => n.id === 'a').updatedAt = 1000; notes.find(n => n.id === 'b').updatedAt = 9000");
  p.clearSent();

  await p.fire('board_state', {
    notes: { a: serverNote('a', { text: 'server new', updatedAt: 5000 }), b: serverNote('b', { text: 'server old', updatedAt: 2000 }) },
    deleted: {},
  });

  const byId = Object.fromEntries(p.notes().map((n) => [n.id, n]));
  assert.equal(byId.a.text, 'server new');                       // server was newer
  assert.equal(byId.b.text, 'local new');                        // we were newer
  assert.ok(p.sentOf('note_text_changed').some((m) => m.id === 'b' && m.text === 'local new'));
});

test('reconnecting twice does not create duplicate notes', async () => {
  const p = make();
  const state = { notes: { s1: serverNote('s1') }, deleted: {} };
  await p.fire('board_state', state);
  await p.fire('board_state', state);
  assert.equal(p.noteEls().length, 1);
});

// ---------------------------------------------------------------- connection status

test('status: Syncing on connect, Connected once the board arrives, Offline on disconnect', async () => {
  const p = make();
  await p.fire('connect');
  assert.match(p.$('#connectionStatus').textContent, /Syncing/);

  await p.fire('board_state', { notes: {}, deleted: {} });
  assert.match(p.$('#connectionStatus').textContent, /Connected/);
  assert.ok(!p.$('#offlineBanner').classList.contains('visible'));

  await p.fire('disconnect');
  assert.match(p.$('#connectionStatus').textContent, /Offline/);
  assert.ok(p.$('#offlineBanner').classList.contains('visible'));
});

test('status still settles to Connected when board data arrives before the connect event', async () => {
  const p = make();
  await p.fire('board_state', { notes: {}, deleted: {} });
  await p.fire('connect');                                  // the "wrong" order
  await sleep(700);
  assert.match(p.$('#connectionStatus').textContent, /Connected/);
});

test('a broken board_state message does not stop the status or crash the app', async () => {
  const p = make();
  await p.fire('board_state', null);
  assert.match(p.$('#connectionStatus').textContent, /Connected/);
});

test('losing the network shows Offline straight away', () => {
  const p = make();
  p.w.dispatchEvent(new p.w.Event('offline'));
  assert.match(p.$('#connectionStatus').textContent, /Offline/);
});

// ---------------------------------------------------------------- rooms and offline copy

test('the board id comes from the link and is cleaned', async () => {
  const p = make({ room: 'ABC def!' });
  assert.equal(p.$('#roomName').textContent, '# abcdef');
  await p.fire('connect');
  assert.deepEqual(p.sentOf('join')[0], { room: 'abcdef', name: 'Muthu' });
});

test('with no board id in the link, a new one is created and put in the address bar', () => {
  const p = make({ room: null });
  const room = new URLSearchParams(p.w.location.search).get('room');
  assert.match(room, /^[a-z0-9]{1,6}$/);
  assert.equal(p.$('#roomName').textContent, '# ' + room);
});

test('offline copies are saved separately for each board', () => {
  const p = make({ room: 'alpha' });
  p.run("createNote(1, 1, 'x', 'n1')");
  assert.ok(p.saved('whiteboard_notes_alpha'));
  assert.equal(p.saved('whiteboard_notes_beta'), null);
});

test('a note you create is saved on this device straight away', () => {
  const p = make({ room: 'alpha' });
  p.click('#addNoteBtn');
  p.click('#noteTypeMenu [data-type="paper"]');            // created, never touched again
  const saved = JSON.parse(p.saved('whiteboard_notes_alpha'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].noteType, 'paper');
});

test('notes saved on this device are shown again after a refresh, with their real timestamps', () => {
  const saved = JSON.stringify([serverNote('keep1', { text: 'remember me', updatedAt: 1234, noteType: 'slide' })]);
  const p = make({ room: 'alpha', storage: { whiteboard_notes_alpha: saved } });

  assert.equal(p.noteEls().length, 1);
  assert.equal(p.$('.note textarea').value, 'remember me');
  assert.ok(p.$('.note').classList.contains('type-slide'));
  assert.equal(p.notes()[0].updatedAt, 1234);                // not replaced by "now"
});

// ---------------------------------------------------------------- names, avatars, cursors

test('first-time visitors are asked for a name and join only after giving one', async () => {
  const p = make({ username: null });
  assert.ok(p.$('#nameDialog').classList.contains('open'));

  await p.fire('connect');
  assert.deepEqual(p.sentOf('join'), []);                   // no name yet, no join

  p.$('#nameInput').value = '  Ravi  ';
  p.click('#nameSaveBtn');
  assert.ok(!p.$('#nameDialog').classList.contains('open'));
  assert.deepEqual(p.sentOf('join')[0], { room: 'testroom', name: 'Ravi' });
  assert.equal(p.saved('whiteboard_username'), 'Ravi');
});

test('returning visitors join straight away with their saved name', async () => {
  const p = make();
  assert.ok(!p.$('#nameDialog').classList.contains('open'));
  await p.fire('connect');
  assert.deepEqual(p.sentOf('join')[0], { room: 'testroom', name: 'Muthu' });
});

test('renaming yourself tells the server', () => {
  const p = make();
  p.run('openNameDialog()');
  p.$('#nameInput').value = 'New Name';
  p.click('#nameSaveBtn');
  assert.deepEqual(p.sentOf('set_name'), [{ name: 'New Name' }]);
});

test('names are cut to 20 characters', () => {
  const p = make({ username: null });
  p.$('#nameInput').value = 'x'.repeat(50);
  p.click('#nameSaveBtn');
  assert.equal(p.saved('whiteboard_username'), 'x'.repeat(20));
});

test('the top bar shows each person with their color, you first', async () => {
  const p = make();
  await p.fire('your_info', { id: 'me', name: 'Muthu', color: '#e63946' });
  await p.fire('users_update', [
    { id: 'p1', name: 'Priya', color: '#2a9d8f' },
    { id: 'me', name: 'Muthu', color: '#e63946' },
  ]);

  const chips = [...p.d.querySelectorAll('.user-chip')];
  assert.deepEqual(chips.map((c) => c.textContent.trim()), ['Muthu (you)', 'Priya']);
  assert.match(chips[0].querySelector('.user-chip-dot').style.background, /230, 57, 70/);   // #e63946
});

test('more than five people show a +N badge with their names', async () => {
  const p = make();
  await p.fire('your_info', { id: 'me', name: 'Muthu', color: '#000' });
  const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, name: `Person${i}`, color: '#123456' }));
  await p.fire('users_update', users);

  assert.equal(p.d.querySelectorAll('.user-chip').length, 5);
  const badge = p.$('.user-dot-overflow');
  assert.equal(badge.textContent, '+2');
  assert.match(badge.title, /Person5/);
});

test('names are shown as plain text, never as HTML', async () => {
  const p = make();
  await p.fire('users_update', [{ id: 'x', name: '<img src=x onerror=alert(1)>', color: '#111111' }]);
  assert.equal(p.d.querySelectorAll('#userDots img').length, 0);
  assert.match(p.$('#userDots').textContent, /<img src=x/);
});

test('other people’s cursors show their name, follow renames and disappear on leave', async () => {
  const p = make();
  await p.fire('cursor_move', { id: 'p1', x: 5, y: 6, color: '#2a9d8f', name: 'Priya' });
  assert.equal(p.$('.remote-cursor-label').textContent, 'Priya');

  await p.fire('users_update', [{ id: 'p1', name: 'Priya K', color: '#2a9d8f' }]);
  assert.equal(p.$('.remote-cursor-label').textContent, 'Priya K');

  await p.fire('user_disconnected', { id: 'p1' });
  assert.equal(p.d.querySelectorAll('.remote-cursor').length, 0);
});