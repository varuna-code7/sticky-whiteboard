const board = document.getElementById('board');
const boardCanvas = document.getElementById('boardCanvas');
const zoomLevelEl = document.getElementById('zoomLevel');
const addNoteBtn = document.getElementById('addNoteBtn');

// --- Rooms ---
// Each board has its own id in the link: page.html?room=abc123
// Same link = same board. No room in the link = we make a fresh one and
// put it in the address bar, so the link is ready to share.
function cleanRoomId(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function newRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

const urlParams = new URLSearchParams(window.location.search);
let roomId = cleanRoomId(urlParams.get('room'));
if (!roomId) {
  roomId = newRoomId();
  urlParams.set('room', roomId);
  history.replaceState(null, '', `${window.location.pathname}?${urlParams}`);
}
document.title = `Board ${roomId} — Sticky Whiteboard`;

// Offline copies are saved per board, so boards never mix on one device
const NOTES_KEY = 'whiteboard_notes_' + roomId;
const TOMBSTONES_KEY = 'whiteboard_tombstones_' + roomId;

// Connect to the Flask-SocketIO server
// Opened from the server itself (http://127.0.0.1:5000)? Then talk to that
// same address. Opened some other way (Live Server, a file)? Use the local server.
const SERVER_URL = window.location.port === '5000'
  ? window.location.origin
  : 'http://127.0.0.1:5000';
const socket = io(SERVER_URL);

// --- Infinite canvas: pan + zoom ---
// Notes keep their own "world" coordinates (unchanged). We render the
// whole board shifted/scaled by panX/panY/scale, so everything inside
// moves and zooms together without us having to update every note.
const canvasState = { panX: 0, panY: 0, scale: 1 };

function applyCanvasTransform() {
  boardCanvas.style.transform =
    `translate(${canvasState.panX}px, ${canvasState.panY}px) scale(${canvasState.scale})`;
  zoomLevelEl.textContent = Math.round(canvasState.scale * 100) + '%';
}
applyCanvasTransform();

// Converts a point measured in screen pixels (e.g. e.clientX relative to
// the board) into "world" coordinates — undoing the current pan/zoom.
// Needed anywhere we turn a mouse position into a note/cursor position.
function screenToWorld(screenX, screenY) {
  return {
    x: (screenX - canvasState.panX) / canvasState.scale,
    y: (screenY - canvasState.panY) / canvasState.scale
  };
}

// Stacking order: the note you touch last goes on top. Without this, a
// newer note placed over the corner of an older one hides its delete
// button, and that note seems impossible to delete.
// (Only affects what YOU see on screen; it isn't synced to other users.)
let topZ = 1;
function bringToFront(el) {
  topZ += 1;
  el.style.zIndex = topZ;
}

// Keep a lookup from note id -> DOM element, so incoming
// server events can find and update the right element fast.
const noteElements = {};

// In-memory state: one object per note.
let notes = [];

// Deleted notes: id -> time of deletion (see saveTombstones below).
let tombstones = {};
try {
  tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY)) || {};
} catch (e) {
  tombstones = {};
}

// Sets a note element's position AND keeps its fixed rotation —
// transform is a single property, so every update must include both
// or the rotation would be wiped out each time position changes.
function applyTransform(el, x, y, rotationDeg) {
  el.style.transform = `translate(${x}px, ${y}px) rotate(${rotationDeg}deg)`;
}

// fromServer=true means: this note came from a socket event,
// so we should NOT emit it back to the server (that would loop forever)
// rotation/colorIndex are fixed at creation time and shared over the
// network, so every user sees the exact same tilt/color for a note —
// if we randomized them per-browser instead, each tab would show a
// different look for the same note.
// A counter alone isn't enough — if two tabs each start counting from 0,
// their first notes would both be "note-0" and collide on the server.
// Mixing in the current time + a random chunk makes IDs unique across tabs.
function generateNoteId() {
  return 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function createNote(x = 50, y = 50, text = '', id = null, fromServer = false, rotation = null, colorIndex = null, noteType = 'sticky') {
  if (!id) id = generateNoteId();

  // One id = one note on screen. If it's already here (for example a
  // reconnect re-sends notes the other tabs already have), do nothing.
  // Without this, a duplicate "ghost" copy appears that can't be deleted.
  if (noteElements[id]) return noteElements[id];

  // Only sticky notes get a random tilt — paper and slides look more
  // deliberate (like placed documents) with straight edges.
  if (rotation === null) rotation = noteType === 'sticky' ? Math.round((Math.random() * 6 - 3) * 10) / 10 : 0;
  if (colorIndex === null) colorIndex = Math.floor(Math.random() * 4);

  const noteData = { id, x, y, text, updatedAt: Date.now(), rotation, colorIndex, noteType };
  notes.push(noteData);

  // If this id was deleted before (e.g. undo brings it back), drop the marker
  if (tombstones[id] !== undefined) {
    delete tombstones[id];
    saveTombstones();
  }

  const el = document.createElement('div');
  el.className = `note type-${noteType} color-${colorIndex}`;
  el.dataset.id = id;
  applyTransform(el, x, y, rotation);
  bringToFront(el);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'note-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete note';
  el.appendChild(deleteBtn);

  const textarea = document.createElement('textarea');
  textarea.value = text;
  el.appendChild(textarea);

  boardCanvas.appendChild(el);
  noteElements[id] = el;

  makeDraggable(el, noteData);
  makeTextSyncable(textarea, noteData);

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let this click also start a drag
    const snap = snapshotNote(id);
    if (snap) pushHistory({ type: 'delete', note: snap });
    deleteNoteAndSync(id);
  });

  if (!fromServer) {
    socket.emit('note_created', noteData);
    // Save on this device right away. Otherwise a note created offline and
    // never edited would be lost if the page is refreshed. (Notes restored
    // or received from the server are not saved here: restoring must not
    // overwrite their real timestamps.)
    saveToLocalStorage();
  }

  return el;
}

function makeDraggable(el, noteData) {
  let isDragging = false;
  let startX, startY;
  let originX, originY;
  let lastSentTime = 0;
  const THROTTLE_MS = 50;

  el.addEventListener('pointerdown', (e) => {
    bringToFront(el);

    // Ignore drags starting on the textarea (typing) or the delete button —
    // both are children of the note, so clicks on them bubble up here too.
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.target.closest('.note-delete')) return;

    isDragging = true;
    el.classList.add('dragging');

    startX = e.clientX;
    startY = e.clientY;
    originX = noteData.x;
    originY = noteData.y;

    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    // Divide by scale: at 2x zoom, a 10px mouse move should only shift
    // the note by 5 "world" pixels, since everything looks twice as big.
    const dx = (e.clientX - startX) / canvasState.scale;
    const dy = (e.clientY - startY) / canvasState.scale;

    noteData.x = originX + dx;
    noteData.y = originY + dy;

    applyTransform(el, noteData.x, noteData.y, noteData.rotation);

    const now = Date.now();
    if (now - lastSentTime > THROTTLE_MS) {
      lastSentTime = now;
      socket.emit('note_moved', {
        id: noteData.id,
        x: noteData.x,
        y: noteData.y,
        updatedAt: now
      });
    }
  });

  el.addEventListener('pointerup', () => {
    // pointerup also fires after clicking the textarea — nothing to do then
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dragging');

    if (noteData.x !== originX || noteData.y !== originY) {
      pushHistory({
        type: 'move',
        id: noteData.id,
        from: { x: originX, y: originY },
        to: { x: noteData.x, y: noteData.y }
      });
    }

    noteData.updatedAt = Date.now();
    socket.emit('note_moved', {
      id: noteData.id,
      x: noteData.x,
      y: noteData.y,
      updatedAt: noteData.updatedAt
    });
    saveToLocalStorage();
  });
}

function makeTextSyncable(textarea, noteData) {
  let debounceTimer = null;
  // The text as it was before the current burst of typing started —
  // this is what "undo" will put back.
  let textBeforeEdit = textarea.value;
  let fromBrowserUndo = false;

  // Refresh when the user clicks into the box, because someone else may
  // have changed the text since we last looked.
  textarea.addEventListener('focus', () => {
    textBeforeEdit = textarea.value;
  });

  // Edits from others that arrived while we were typing were skipped on
  // screen. When we leave the box, catch up to the latest saved text.
  textarea.addEventListener('blur', () => {
    if (textarea.value !== noteData.text) textarea.value = noteData.text;
  });

  textarea.addEventListener('input', (e) => {
    noteData.text = textarea.value;
    // Ctrl+Z inside the box is handled by the browser. We still sync it,
    // but we don't add it to our own history.
    if (e.inputType && e.inputType.startsWith('history')) fromBrowserUndo = true;

    // Debounce: wait until the user pauses typing for 300ms before sending.
    // (Different from throttle: throttle limits rate during continuous
    // activity, debounce waits for a pause before firing once.)
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!fromBrowserUndo && textBeforeEdit !== noteData.text) {
        pushHistory({
          type: 'text',
          id: noteData.id,
          from: textBeforeEdit,
          to: noteData.text
        });
      }
      textBeforeEdit = noteData.text;
      fromBrowserUndo = false;

      noteData.updatedAt = Date.now();
      socket.emit('note_text_changed', {
        id: noteData.id,
        text: noteData.text,
        updatedAt: noteData.updatedAt
      });
      saveToLocalStorage();
    }, 150);
  });
}

// Removes a note from the DOM and our local state array.
// Used both when WE delete a note, and when the server tells us
// someone else deleted one.
function removeNoteLocally(id) {
  // Remove every element with this id (also clears any old ghost copies)
  document.querySelectorAll('.note').forEach((el) => {
    if (el.dataset.id === id) el.remove();
  });
  delete noteElements[id];
  notes = notes.filter(n => n.id !== id);
  saveToLocalStorage();
}


// --- Undo / Redo ---
// Every action WE do (create, delete, move, edit text) is saved as a small
// record that holds enough info to reverse it. Undo pops the newest record
// from undoStack, reverses it, and parks it on redoStack. Redo does the
// opposite. Doing a brand-new action clears redoStack, because the
// "future" it pointed to no longer exists.
// Only OUR actions are tracked — undo never touches what other users did.
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 100;
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

function updateHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

function pushHistory(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  updateHistoryButtons();
}

// Copy of a note's data, so later changes to the live note can't
// silently alter a saved history record.
function snapshotNote(id) {
  const n = notes.find(x => x.id === id);
  return n ? { ...n } : null;
}

// These helpers apply a change AND sync it. They use a fresh timestamp,
// so the server's Last-Writer-Wins check accepts the change as the newest.
function setNotePosition(id, x, y) {
  const n = notes.find(v => v.id === id);
  const el = noteElements[id];
  if (!n || !el) return;
  n.x = x;
  n.y = y;
  n.updatedAt = Date.now();
  applyTransform(el, x, y, n.rotation);
  socket.emit('note_moved', { id, x, y, updatedAt: n.updatedAt });
  saveToLocalStorage();
}

function setNoteText(id, text) {
  const n = notes.find(v => v.id === id);
  const el = noteElements[id];
  if (!n || !el) return;
  n.text = text;
  n.updatedAt = Date.now();
  el.querySelector('textarea').value = text;
  socket.emit('note_text_changed', { id, text, updatedAt: n.updatedAt });
  saveToLocalStorage();
}

function deleteNoteAndSync(id) {
  const deletedAt = Date.now();
  tombstones[id] = deletedAt;
  saveTombstones();
  removeNoteLocally(id);
  // If we're offline this emit is lost, but the tombstone is saved, and
  // the reconnect merge sends it again.
  socket.emit('note_deleted', { id, deletedAt });
}

function recreateNote(s) {
  if (!s) return;
  // fromServer=false -> createNote also tells the server about it
  createNote(s.x, s.y, s.text, s.id, false, s.rotation, s.colorIndex, s.noteType);
}

function applyAction(action, isUndo) {
  switch (action.type) {
    case 'create':
      if (isUndo) {
        // Refresh the snapshot first, so redo brings back the CURRENT
        // text/position, not what it was when first created.
        const current = snapshotNote(action.note.id);
        if (current) action.note = current;
        deleteNoteAndSync(action.note.id);
      } else {
        recreateNote(action.note);
      }
      break;
    case 'delete':
      if (isUndo) recreateNote(action.note);
      else deleteNoteAndSync(action.note.id);
      break;
    case 'move': {
      const p = isUndo ? action.from : action.to;
      setNotePosition(action.id, p.x, p.y);
      break;
    }
    case 'text':
      setNoteText(action.id, isUndo ? action.from : action.to);
      break;
  }
}

function undo() {
  const action = undoStack.pop();
  if (!action) return;
  applyAction(action, true);
  redoStack.push(action);
  updateHistoryButtons();
}

function redo() {
  const action = redoStack.pop();
  if (!action) return;
  applyAction(action, false);
  undoStack.push(action);
  updateHistoryButtons();
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  // Inside a note's text box, Ctrl+Z should undo typing (browser default).
  if (e.target.tagName === 'TEXTAREA') return;
  if (!(e.ctrlKey || e.metaKey)) return;

  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

// --- Dark mode ---
// Toggling a single class on <body> is enough, because every color in
// style.css is defined as a CSS variable that body.dark overrides —
// we never touch individual element styles here.
const darkModeToggle = document.getElementById('darkModeToggle');

function setDarkMode(isDark) {
  document.body.classList.toggle('dark', isDark);
  darkModeToggle.textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('whiteboard_dark_mode', isDark ? '1' : '0');
}

darkModeToggle.addEventListener('click', () => {
  setDarkMode(!document.body.classList.contains('dark'));
});

// Restore the user's last choice on page load
setDarkMode(localStorage.getItem('whiteboard_dark_mode') === '1');

// Drop a new note of the given type near the center of whatever part of
// the board the user is currently looking at, not a fixed screen position —
// otherwise it could land off-screen after panning/zooming.
function addNoteOfType(noteType) {
  const rect = board.getBoundingClientRect();
  const center = screenToWorld(rect.width / 2, rect.height / 2);
  const jitter = () => (Math.random() - 0.5) * 120;
  createNote(center.x + jitter(), center.y + jitter(), '', null, false, null, null, noteType);
  // createNote adds the new note to the end of the notes array
  pushHistory({ type: 'create', note: { ...notes[notes.length - 1] } });
}

const noteTypeMenu = document.getElementById('noteTypeMenu');

addNoteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  noteTypeMenu.classList.toggle('open');
});

noteTypeMenu.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    addNoteOfType(btn.dataset.type);
    noteTypeMenu.classList.remove('open');
  });
});

// Close the menu if the user clicks anywhere else
document.addEventListener('click', (e) => {
  if (!e.target.closest('#addNoteWrapper')) {
    noteTypeMenu.classList.remove('open');
  }
});

const deleteAllBtn = document.getElementById('deleteAllBtn');
deleteAllBtn.addEventListener('click', () => {
  if (notes.length === 0) return;
  const confirmed = confirm(`Delete all ${notes.length} notes? This can't be undone.`);
  if (!confirmed) return;
  socket.emit('clear_board');
});

// Server confirms the board was cleared — remove everything locally too.
// We wait for this instead of clearing immediately on click, so every
// connected user (including us) clears at the same moment.
socket.on('board_cleared', () => {
  const now = Date.now();
  Object.keys(noteElements).forEach((id) => {
    tombstones[id] = now;
    removeNoteLocally(id);
  });
  saveTombstones();
  clearHistory(); // old records point at notes that no longer exist
});

// --- Offline persistence ---
// Save our local notes to the browser's storage after every change,
// so a page refresh (or being offline) never loses local work.
function saveToLocalStorage() {
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

function loadFromLocalStorage() {
  const raw = localStorage.getItem(NOTES_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Tombstones: id -> time the note was deleted. Saved on this device too,
// so a delete made while offline is still remembered after a refresh and
// can be sent to the server on reconnect.
function saveTombstones() {
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones));
}

// --- Incoming note events from the server ---

// This fires both on first load AND every reconnect after being offline.
// We must MERGE with what we already have locally, not recreate everything
// (that would duplicate notes we already drew on screen).
socket.on('board_state', (state) => {
 try {
  const serverNotes = state.notes || {};
  const serverDeleted = state.deleted || {};

  // Step 1: deletes the server knows about (someone deleted while we
  // were offline). Remove them here too, unless we edited the note AFTER
  // the delete — then our newer edit wins and the note is pushed back up.
  Object.entries(serverDeleted).forEach(([id, deletedAt]) => {
    const local = notes.find(n => n.id === id);
    if (local && (local.updatedAt || 0) > deletedAt) {
      socket.emit('note_created', { ...local });
      return;
    }
    if (local) removeNoteLocally(id);
    tombstones[id] = Math.max(tombstones[id] || 0, deletedAt);
  });

  // Step 2: deletes WE made while offline that the server hasn't heard
  // about yet. Send them now. (If someone else edited the note after we
  // deleted it, their edit wins and we keep the note.)
  Object.entries(tombstones).forEach(([id, deletedAt]) => {
    if (serverDeleted[id] !== undefined && serverDeleted[id] >= deletedAt) return;
    const sn = serverNotes[id];
    if (sn && (sn.updatedAt || 0) > deletedAt) {
      delete tombstones[id];
      return;
    }
    socket.emit('note_deleted', { id, deletedAt });
  });

  // Step 3: merge the server's notes with ours (Last-Writer-Wins)
  Object.values(serverNotes).forEach((serverNote) => {
    if (tombstones[serverNote.id] !== undefined) return; // deleted, skip

    const existing = notes.find(n => n.id === serverNote.id);

    if (!existing) {
      createNote(serverNote.x, serverNote.y, serverNote.text, serverNote.id, true, serverNote.rotation, serverNote.colorIndex, serverNote.noteType);
      return;
    }

    const localTime = existing.updatedAt || 0;
    const serverTime = serverNote.updatedAt || 0;

    if (serverTime > localTime) {
      existing.x = serverNote.x;
      existing.y = serverNote.y;
      existing.text = serverNote.text;
      existing.updatedAt = serverTime;

      const el = noteElements[existing.id];
      applyTransform(el, existing.x, existing.y, existing.rotation);
      const ta = el.querySelector('textarea');
      if (document.activeElement !== ta) ta.value = existing.text;
    } else if (localTime > serverTime) {
      socket.emit('note_moved', { id: existing.id, x: existing.x, y: existing.y, updatedAt: localTime });
      socket.emit('note_text_changed', { id: existing.id, text: existing.text, updatedAt: localTime });
    }
  });

  // Step 4: notes only we have (created while offline) -> send them up
  notes.forEach((n) => {
    if (!serverNotes[n.id] && serverDeleted[n.id] === undefined) {
      socket.emit('note_created', { ...n });
    }
  });

  saveTombstones();
  saveToLocalStorage();
 } catch (err) {
  // Log it instead of crashing the handler
  console.error('board_state merge failed:', err);
 }
});

socket.on('note_created', (data) => {
  createNote(data.x, data.y, data.text, data.id, true, data.rotation, data.colorIndex, data.noteType);
});

socket.on('note_moved', (data) => {
  const el = noteElements[data.id];
  if (!el) return;

  const noteData = notes.find(n => n.id === data.id);
  if (noteData) {
    noteData.x = data.x;
    noteData.y = data.y;
    applyTransform(el, data.x, data.y, noteData.rotation);
  }
});

socket.on('note_deleted', (data) => {
  tombstones[data.id] = data.deletedAt || Date.now();
  saveTombstones();
  removeNoteLocally(data.id);
});

socket.on('note_text_changed', (data) => {
  const el = noteElements[data.id];
  if (!el) return;

  const textarea = el.querySelector('textarea');
  // Don't overwrite what the user is actively typing in this exact box.
  // document.hasFocus() matters: a tab in the background still reports its
  // textarea as "active", so without it that tab would never update.
  const isTypingHere = document.activeElement === textarea && document.hasFocus();
  if (!isTypingHere) {
    textarea.value = data.text;
  }

  const noteData = notes.find(n => n.id === data.id);
  if (noteData) {
    noteData.text = data.text;
    noteData.updatedAt = data.updatedAt;
  }
});

// --- Live cursors (Phase 6) ---

// id -> { dotEl, labelEl } for every OTHER connected user
const remoteCursors = {};
let myId = null;
let myColor = '#333'; // fallback until server tells us

// --- Username ---
// Asked once and remembered on this device (same name on every board).
// Clicking your own chip in the top bar lets you change it.
const NAME_KEY = 'whiteboard_username';
let myName = '';
try { myName = (localStorage.getItem(NAME_KEY) || '').trim(); } catch (e) {}

function joinRoom() {
  // Can't join until we know the name
  if (!myName) return;
  socket.emit('join', { room: roomId, name: myName });
}

const nameDialog = document.getElementById('nameDialog');
const nameInput = document.getElementById('nameInput');
const nameSaveBtn = document.getElementById('nameSaveBtn');

// If index.html is an old copy without the name box, we fall back to the
// browser's built-in prompt instead of crashing the whole script.
const hasDialog = !!(nameDialog && nameInput && nameSaveBtn);

function openNameDialog() {
  if (!hasDialog) {
    const typed = window.prompt('What should we call you?', myName);
    if (typed !== null) applyName(typed);
    return;
  }
  nameInput.value = myName;
  nameDialog.classList.add('open');
  nameInput.focus();
  nameInput.select();
}

function saveName() {
  applyName(nameInput.value);
}

function applyName(raw) {
  const typed = String(raw).trim().replace(/\s+/g, ' ').slice(0, 20);
  const isFirstTime = !myName;
  myName = typed || myName || 'Guest ' + Math.floor(Math.random() * 90 + 10);
  try { localStorage.setItem(NAME_KEY, myName); } catch (e) {}
  if (hasDialog) nameDialog.classList.remove('open');

  if (!socket.connected) return; // join happens when we connect
  if (isFirstTime) joinRoom();
  else socket.emit('set_name', { name: myName });
}

if (hasDialog) {
  nameSaveBtn.addEventListener('click', saveName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
    if (e.key === 'Escape' && myName) nameDialog.classList.remove('open');
  });
}

if (!myName) openNameDialog();

socket.on('your_info', (info) => {
  myId = info.id;
  myColor = info.color;
});

// --- Top bar: one chip per user = their cursor color + their name ---
const userDots = document.getElementById('userDots');
const MAX_VISIBLE_AVATARS = 5;

function makeUserChip(user) {
  const isMe = user.id === myId;
  const chip = document.createElement('div');
  chip.className = 'user-chip' + (isMe ? ' me' : '');
  chip.title = isMe ? user.name + ' (you) — click to rename' : user.name;

  const dot = document.createElement('span');
  dot.className = 'user-chip-dot';
  dot.style.background = user.color;

  const label = document.createElement('span');
  label.className = 'user-chip-name';
  label.textContent = isMe ? user.name + ' (you)' : user.name; // textContent: never HTML

  chip.append(dot, label);
  if (isMe) chip.addEventListener('click', openNameDialog);
  return chip;
}

socket.on('users_update', (users) => {
  userDots.innerHTML = '';

  // You first, then everyone else
  const sorted = [...users].sort((a, b) => (b.id === myId) - (a.id === myId));
  const visible = sorted.slice(0, MAX_VISIBLE_AVATARS);
  const hidden = sorted.slice(MAX_VISIBLE_AVATARS);

  visible.forEach((user) => userDots.appendChild(makeUserChip(user)));

  if (hidden.length > 0) {
    const overflow = document.createElement('div');
    overflow.className = 'user-dot-overflow';
    overflow.textContent = '+' + hidden.length;
    overflow.title = hidden.map((u) => u.name).join(', ');
    userDots.appendChild(overflow);
  }

  // If someone renamed themselves, update the label on their cursor too
  users.forEach((user) => {
    const cursor = remoteCursors[user.id];
    if (cursor) cursor.labelEl.textContent = user.name;
  });
});

// --- Connection status + offline banner ---

const connectionStatusEl = document.getElementById('connectionStatus');
const offlineBannerEl = document.getElementById('offlineBanner');

function setStatus(state) {
  // state: 'connected' | 'offline' | 'syncing'
  connectionStatusEl.className = state;

  if (state === 'connected') {
    connectionStatusEl.textContent = '● Connected';
    offlineBannerEl.classList.remove('visible');
  } else if (state === 'offline') {
    connectionStatusEl.textContent = '○ Offline';
    offlineBannerEl.classList.add('visible');
  } else if (state === 'syncing') {
    connectionStatusEl.textContent = '⟳ Syncing';
  }
}

socket.on('connect', () => {
  setStatus('syncing');
  // Tell the server which board we want. It answers with that board's
  // notes (board_state). Must be repeated after every reconnect.
  joinRoom();
  // The server sends board_state right when we connect, and sometimes it
  // arrives BEFORE this 'connect' event. If that happens, nothing else
  // would ever flip us to "connected", so we also check after a short
  // delay: still connected = fully synced.
  setTimeout(() => {
    if (socket.connected) setStatus('connected');
  }, 500);
});

// board_state means our offline-merge logic just ran, so we're caught up.
// (The merge itself is in the other board_state handler above.)
socket.on('board_state', () => {
  setStatus('connected');
});

socket.on('disconnect', () => {
  setStatus('offline');
});

socket.on('connect_error', () => {
  setStatus('offline');
});

// The browser knows right away when the network drops. The socket can
// take up to ~45 seconds to notice, so we listen to the browser too.
window.addEventListener('offline', () => {
  setStatus('offline');
});

window.addEventListener('online', () => {
  // Network is back; the socket reconnects on its own, we just show it
  setStatus(socket.connected ? 'connected' : 'syncing');
  if (!socket.connected) socket.connect();
});

// Start in "offline" until the first connect event fires
setStatus('offline');

// --- Panning: drag on empty board background (not on a note) ---
let isPanning = false;
let panStartX, panStartY, panOriginX, panOriginY;

board.addEventListener('pointerdown', (e) => {
  // Only start a pan if the click began on the background itself,
  // not on a note or any of its children (checked via closest).
  if (e.target.closest('.note')) return;

  isPanning = true;
  board.classList.add('panning');
  panStartX = e.clientX;
  panStartY = e.clientY;
  panOriginX = canvasState.panX;
  panOriginY = canvasState.panY;
  board.setPointerCapture(e.pointerId);
});

board.addEventListener('pointerup', () => {
  isPanning = false;
  board.classList.remove('panning');
});

// --- Zooming: mouse wheel, zoomed toward the cursor position ---
board.addEventListener('wheel', (e) => {
  e.preventDefault();

  const rect = board.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
  const newScale = Math.min(2.5, Math.max(0.3, canvasState.scale * zoomFactor));

  // Keep the point currently under the mouse fixed in place while zooming —
  // without this, zooming would feel like it's dragging the board around.
  canvasState.panX = mouseX - (mouseX - canvasState.panX) * (newScale / canvasState.scale);
  canvasState.panY = mouseY - (mouseY - canvasState.panY) * (newScale / canvasState.scale);
  canvasState.scale = newScale;

  applyCanvasTransform();
}, { passive: false });

// Track our own mouse and broadcast it, throttled
let lastCursorSentTime = 0;
const CURSOR_THROTTLE_MS = 50;

board.addEventListener('pointermove', (e) => {
  // Panning takes priority over cursor broadcasting while active
  if (isPanning) {
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    canvasState.panX = panOriginX + dx;
    canvasState.panY = panOriginY + dy;
    applyCanvasTransform();
    return;
  }

  const now = Date.now();
  if (now - lastCursorSentTime < CURSOR_THROTTLE_MS) return;
  lastCursorSentTime = now;

  // Convert screen position to world coordinates, so remote cursors
  // render correctly for every viewer regardless of their own pan/zoom.
  const rect = board.getBoundingClientRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

  socket.emit('cursor_move', { x: world.x, y: world.y });
});

// When another user's cursor moves, create their dot if it doesn't
// exist yet, then just update its position.
socket.on('cursor_move', (data) => {
  let cursor = remoteCursors[data.id];

  if (!cursor) {
    const dot = document.createElement('div');
    dot.className = 'remote-cursor';
    dot.style.background = data.color;

    const label = document.createElement('div');
    label.className = 'remote-cursor-label';
    label.style.background = data.color;
    label.textContent = data.name || 'Guest';
    dot.appendChild(label);

    boardCanvas.appendChild(dot);
    cursor = { dotEl: dot, labelEl: label };
    remoteCursors[data.id] = cursor;
  }

  cursor.dotEl.style.transform = `translate(${data.x}px, ${data.y}px)`;
});

// Remove a user's cursor when they disconnect
socket.on('user_disconnected', (data) => {
  const cursor = remoteCursors[data.id];
  if (cursor) {
    cursor.dotEl.remove();
    delete remoteCursors[data.id];
  }
});

// --- On page load: restore any notes saved locally (e.g. from last time
// we were offline) immediately, before we even know if the server is up.
const savedNotes = loadFromLocalStorage();
savedNotes.forEach((n) => {
  createNote(n.x, n.y, n.text, n.id, true, n.rotation, n.colorIndex, n.noteType);
  // Fix: createNote always sets a fresh updatedAt — restore the real one
  const noteData = notes.find(x => x.id === n.id);
  if (noteData) noteData.updatedAt = n.updatedAt;
});


// --- Board toolbar: room name, share link, new board ---
const roomNameEl = document.getElementById('roomName');
const shareBtn = document.getElementById('shareBtn');
const newBoardBtn = document.getElementById('newBoardBtn');

roomNameEl.textContent = '# ' + roomId;

shareBtn.addEventListener('click', async () => {
  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
    shareBtn.textContent = '✓ Copied!';
  } catch (err) {
    // Clipboard blocked: let the user copy it by hand
    window.prompt('Copy this link to share the board:', link);
    return;
  }
  setTimeout(() => { shareBtn.textContent = '🔗 Share'; }, 1500);
});

newBoardBtn.addEventListener('click', () => {
  window.open(`${window.location.pathname}?room=${newRoomId()}`, '_blank');
});