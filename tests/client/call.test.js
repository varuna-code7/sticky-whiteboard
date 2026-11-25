'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupPages, makeStream, sleep } = require('./helpers');

const make = setupPages(afterEach);

const tiles = (p) => p.d.querySelectorAll('.call-tile').length;
const lastSignal = (p) => p.sentOf('call_signal').pop();

// Opens the page, joins the call and waits for the camera/mic to be "granted"
async function joinedCall(options) {
  const p = make(options);
  await p.fire('your_info', { id: 'me', name: 'Muthu', color: '#e63946' });
  p.click('#callBtn');
  await sleep(20);
  return p;
}

test('Join Call opens the panel with your own muted tile and asks the server', async () => {
  const p = await joinedCall();

  assert.deepEqual(p.sentOf('call_join'), [undefined]);
  assert.ok(p.$('#callPanel').classList.contains('open'));
  assert.equal(tiles(p), 1);
  assert.equal(p.$('.call-tile.local video').muted, true);            // no echo of your own voice
  assert.match(p.$('#callBtn').textContent, /In call/);
  assert.ok(p.$('#callBtn').disabled);
});

test('the newcomer calls everyone already in the call', async () => {
  const p = await joinedCall();
  await p.fire('call_peers', [{ id: 'p1', name: 'Priya', color: '#2a9d8f' }]);
  await sleep(20);

  const offer = lastSignal(p);
  assert.equal(offer.to, 'p1');
  assert.equal(offer.kind, 'offer');
  assert.equal(tiles(p), 2);
  assert.match(p.$('#callTiles').textContent, /Priya/);
  assert.equal(p.media.pcs[0].tracksAdded, 2);                         // our mic + camera are sent
  assert.match(p.$('.call-tile:not(.local) .call-tile-status').textContent, /Connecting/);
});

test('network candidates that arrive too early are kept until the answer comes', async () => {
  const p = await joinedCall();
  await p.fire('call_peers', [{ id: 'p1', name: 'Priya', color: '#2a9d8f' }]);
  await sleep(20);

  await p.fire('call_signal', { from: 'p1', kind: 'candidate', candidate: { c: 1 } });
  assert.equal(p.media.pcs[0].candidates, 0);                          // too early, queued

  await p.fire('call_signal', { from: 'p1', kind: 'answer', sdp: { type: 'answer', sdp: 'a' } });
  assert.ok(p.media.pcs[0].remoteDescription);
  assert.equal(p.media.pcs[0].candidates, 1);                          // applied after the answer
});

test('an incoming offer from a newcomer is answered and gets a tile', async () => {
  const p = await joinedCall();
  await p.fire('call_signal', { from: 'p2', name: 'Ravi', color: '#8338ec', kind: 'offer', sdp: { type: 'offer', sdp: 'o' } });

  const answer = lastSignal(p);
  assert.equal(answer.to, 'p2');
  assert.equal(answer.kind, 'answer');
  assert.equal(tiles(p), 2);
  assert.match(p.$('#callTiles').textContent, /Ravi/);
});

test('signals are ignored when you are not in a call', async () => {
  const p = make();
  await p.fire('call_signal', { from: 'p2', name: 'Ravi', color: '#8338ec', kind: 'offer', sdp: {} });
  assert.equal(tiles(p), 0);
  assert.deepEqual(p.sentOf('call_signal'), []);
});

test('renaming updates the name on the call tile', async () => {
  const p = await joinedCall();
  await p.fire('call_peers', [{ id: 'p1', name: 'Priya', color: '#2a9d8f' }]);
  await sleep(20);
  await p.fire('users_update', [{ id: 'me', name: 'Muthu', color: '#e63946' }, { id: 'p1', name: 'Priya K', color: '#2a9d8f' }]);
  assert.match(p.$('#callTiles').textContent, /Priya K/);
});

test('mute and camera buttons switch the tracks off and on', async () => {
  const p = await joinedCall();
  const [audio, video] = p.media.stream.tracks;

  p.click('#callMicBtn');
  assert.equal(audio.enabled, false);
  assert.ok(p.$('#callMicBtn').classList.contains('off'));
  p.click('#callMicBtn');
  assert.equal(audio.enabled, true);

  p.click('#callCamBtn');
  assert.equal(video.enabled, false);
});

test('when someone leaves, their tile and connection are removed', async () => {
  const p = await joinedCall();
  await p.fire('call_peers', [{ id: 'p1', name: 'Priya', color: '#2a9d8f' }]);
  await sleep(20);

  await p.fire('call_peer_left', { id: 'p1' });
  assert.equal(tiles(p), 1);
  assert.ok(p.media.pcs[0].closed);
});

test('Leave stops the camera and mic, closes everything and tells the server', async () => {
  const p = await joinedCall();
  await p.fire('call_peers', [{ id: 'p1', name: 'Priya', color: '#2a9d8f' }]);
  await sleep(20);

  p.click('#callLeaveBtn');

  assert.equal(p.sentOf('call_leave').length, 1);
  assert.ok(p.media.stream.tracks.every((t) => t.stopped));           // camera light goes off
  assert.ok(p.media.pcs.every((pc) => pc.closed));
  assert.equal(tiles(p), 0);
  assert.ok(!p.$('#callPanel').classList.contains('open'));
  assert.match(p.$('#callBtn').textContent, /Join Call/);
  assert.ok(!p.$('#callBtn').disabled);
});

test('a full call sends you back out', async () => {
  const p = await joinedCall();
  await p.fire('call_full', { max: 4 });
  assert.equal(tiles(p), 0);
  assert.match(p.d.getElementById('callToast').textContent, /full/);
});

test('losing the server connection ends the call', async () => {
  const p = await joinedCall();
  await p.fire('disconnect');
  assert.equal(tiles(p), 0);
});

test('if the camera is busy you join with voice only', async () => {
  const p = make();
  p.media.getUserMedia = async (constraints) => {
    if (constraints.video) throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
    return makeStream(['audio']);
  };
  await p.fire('your_info', { id: 'me', name: 'Muthu', color: '#e63946' });
  p.click('#callBtn');
  await sleep(20);

  assert.equal(tiles(p), 1);
  assert.ok(p.$('#callCamBtn').disabled);
});

test('if the microphone is blocked you get a message and do not join', async () => {
  const p = make();
  p.media.getUserMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  p.click('#callBtn');
  await sleep(20);

  assert.equal(tiles(p), 0);
  assert.equal(p.sentOf('call_join').length, 0);
  assert.match(p.d.getElementById('callToast').textContent, /microphone/i);
  assert.ok(!p.$('#callBtn').disabled);                               // you can try again
});

test('offline: you get a message and the camera is not even requested', async () => {
  const p = make({ connected: false });
  let asked = false;
  p.media.getUserMedia = async () => { asked = true; return makeStream(); };
  p.click('#callBtn');
  await sleep(20);

  assert.equal(asked, false);
  assert.match(p.d.getElementById('callToast').textContent, /offline/i);
});

test('clicking Join Call always gives feedback, never silence', async () => {
  const p = make({ connected: false });
  p.click('#callBtn');
  assert.ok(p.d.getElementById('callToast'));                          // a message appeared at once
});

// ---- the problem we actually hit: an index.html copy without the call panel ----

test('the call still works if index.html has no call panel (it builds its own)', async () => {
  const p = await joinedCall({
    mutateHtml: (html) => html.replace(/<div id="callPanel">[\s\S]*?<\/div>\s*<\/div>\s*(?=<div id="nameDialog")/, ''),
  });

  assert.equal(p.sentOf('call_join').length, 1);
  assert.equal(p.$('#callPanel').style.display, 'flex');
  assert.equal(tiles(p), 1);
  assert.ok(p.$('#callMicBtn') && p.$('#callCamBtn') && p.$('#callLeaveBtn'));
});

test('a missing Join Call button is reported, not a crash', () => {
  const p = make({ mutateHtml: (html) => html.replace(/<button id="callBtn"[\s\S]*?<\/button>/, '') });
  assert.deepEqual(p.errors, []);
  assert.ok(p.logs.some((line) => /callBtn/.test(line)));
});