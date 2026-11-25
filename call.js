// Voice + video call for the whiteboard (WebRTC).
//
// How it works, in short:
// 1. We ask the browser for camera + mic.
// 2. For every other person in the call we open a direct connection
//    (RTCPeerConnection) and send our stream through it.
// 3. The server only passes the small setup messages ("signaling").
//    The audio/video itself never touches our server.
//
// Uses globals from app.js: socket, myId, myName, myColor.

window.__callLoaded = true; // lets index.html know this file loaded
console.log('[call] call.js v5 loaded');

(function () {
  const callBtn = document.getElementById('callBtn');
  if (!callBtn) {
    console.warn('[call] The Join Call button (id="callBtn") is not in index.html, so nothing can start the call.');
    return;
  }

  // The call feature builds any missing pieces itself, so an old or
  // half-copied index.html / style.css can't silently break it.
  const callButtonCount = document.querySelectorAll('#callBtn').length;

  if (!document.getElementById('call-styles')) {
    const style = document.createElement('style');
    style.id = 'call-styles';
    style.textContent = `
      #callPanel { display:none; position:fixed; left:16px; bottom:16px; z-index:9000; flex-direction:column; gap:8px;
        padding:10px; background:rgba(20,17,13,0.88); border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.4); max-width:calc(100vw - 32px); }
      #callTiles { display:flex; flex-wrap:wrap; gap:8px; max-width:352px; }
      .call-tile { position:relative; width:168px; height:126px; border:3px solid #888; border-radius:8px; overflow:hidden; background:#111; }
      .call-tile video { width:100%; height:100%; object-fit:cover; display:block; }
      .call-tile.local video { transform:scaleX(-1); }
      .call-tile-name { position:absolute; left:4px; bottom:4px; max-width:calc(100% - 8px); padding:2px 8px; border-radius:999px;
        color:#fff; font:600 11px Inter,Arial,sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .call-tile-status { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); color:#fff; font:12px Inter,Arial,sans-serif; pointer-events:none; }
      .call-tile.failed::after { content:'Connection failed'; position:absolute; inset:0; display:flex; align-items:center;
        justify-content:center; background:rgba(0,0,0,0.7); color:#fff; font-size:12px; }
      #callControls { display:flex; justify-content:center; gap:8px; }
      #callControls button { border:none; border-radius:999px; padding:8px 14px; font-size:14px; cursor:pointer; background:rgba(255,255,255,0.15); color:#fff; }
      #callControls button.off, #callControls #callLeaveBtn { background:#c0392b; }
      #callControls button:disabled { opacity:0.4; cursor:not-allowed; }
    `;
    document.head.appendChild(style);
  }

  let panel = document.getElementById('callPanel');
  if (!panel) {
    console.warn('[call] #callPanel was missing from index.html, creating it.');
    panel = document.createElement('div');
    panel.id = 'callPanel';
    document.body.appendChild(panel);
  }
  let tilesEl = document.getElementById('callTiles');
  if (!tilesEl) {
    tilesEl = document.createElement('div');
    tilesEl.id = 'callTiles';
    panel.appendChild(tilesEl);
  }
  let controlsEl = document.getElementById('callControls');
  if (!controlsEl) {
    controlsEl = document.createElement('div');
    controlsEl.id = 'callControls';
    panel.appendChild(controlsEl);
  }
  function ensureControl(id, text, title) {
    let b = document.getElementById(id);
    if (!b) {
      b = document.createElement('button');
      b.id = id;
      b.textContent = text;
      b.title = title;
      controlsEl.appendChild(b);
    }
    return b;
  }
  const micBtn = ensureControl('callMicBtn', '🎤', 'Mute microphone');
  const camBtn = ensureControl('callCamBtn', '📷', 'Turn camera off');
  const leaveBtn = ensureControl('callLeaveBtn', '📞 Leave', 'Leave call');

  // Show or hide the call panel (class + inline style, so it works either way)
  function setPanelOpen(open) {
    panel.classList.toggle('open', open);
    panel.style.display = open ? 'flex' : 'none';
  }
  setPanelOpen(false);

  console.log('[call] ready. Join Call button found: yes, copies of #callBtn: ' + callButtonCount +
              ', disabled: ' + callBtn.disabled);

  // Debug helper: if a click lands on top of the Join Call button but hits
  // something else (an invisible layer), say what it hit.
  document.addEventListener('click', (e) => {
    const r = callBtn.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside && !callBtn.contains(e.target)) {
      console.warn('[call] You clicked where the Join Call button is, but the click hit:', e.target);
    }
  }, true);

  // STUN servers help two browsers find each other across home routers.
  // (Strict networks, like some colleges, would also need a TURN server.)
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // A small message bar on the page. Used instead of alert(), because
  // browsers can silently block alert popups.
  let toastTimer = null;
  function notify(message) {
    console.log('[call]', message);
    let toast = document.getElementById('callToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'callToast';
      // Inline styles on purpose: this message must be visible even if
      // style.css is an old copy.
      toast.style.cssText =
        'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2147483000;' +
        'max-width:min(520px,92vw);padding:12px 18px;background:#2B2520;color:#fff;' +
        'border-left:4px solid #FFD56A;border-radius:8px;font:14px/1.4 Inter,Arial,sans-serif;' +
        'box-shadow:0 10px 30px rgba(0,0,0,0.4);';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 10000);
  }

  let inCall = false;
  let starting = false;
  let localStream = null;
  let micOn = true;
  let camOn = true;
  let hasVideo = true;
  let localTile = null;
  const peers = {}; // peerId -> { pc, tile, pendingCandidates }

  // ---------- Tiles (the little video boxes) ----------

  function makeTile(name, color, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'call-tile' + (isLocal ? ' local' : '');
    tile.style.borderColor = color;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal; // never play our own voice back (echo)
    tile.appendChild(video);

    const label = document.createElement('div');
    label.className = 'call-tile-name';
    label.style.background = color;
    label.textContent = name; // textContent: names are never treated as HTML
    tile.appendChild(label);

    // Remote tiles show "Connecting…" until the other person's video/audio arrives
    let status = null;
    if (!isLocal) {
      status = document.createElement('div');
      status.className = 'call-tile-status';
      status.textContent = 'Connecting…';
      tile.appendChild(status);
      video.addEventListener('playing', () => { status.style.display = 'none'; });
    }

    tilesEl.appendChild(tile);
    return { el: tile, video, label, status };
  }

  function setTileInfo(tile, name, color) {
    if (!tile) return;
    tile.label.textContent = name;
    tile.label.style.background = color;
    tile.el.style.borderColor = color;
  }

  // ---------- Joining and leaving ----------

  async function getMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('no-api');
    }
    try {
      hasVideo = true;
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } }
      });
    } catch (err) {
      // No camera, camera blocked, or camera busy (e.g. used by another
      // tab): try again with voice only.
      hasVideo = false;
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  async function joinCall() {
    console.log('[call] Join Call clicked (inCall=' + inCall + ', starting=' + starting + ', connected=' + socket.connected + ')');
    if (inCall || starting) {
      notify(inCall ? 'You are already in the call.' : 'Still waiting for camera/mic permission. Check the address bar for a permission box.');
      return;
    }
    notify('Join Call clicked, checking connection…');

    if (!socket.connected) {
      notify('You are offline. Wait until the status says Connected, then try again.');
      return;
    }
    if (window.isSecureContext === false || !navigator.mediaDevices) {
      notify('Camera and mic only work on https:// or localhost / 127.0.0.1. Open the page from one of those.');
      return;
    }

    // Show that something is happening while the browser asks for permission
    starting = true;
    callBtn.disabled = true;
    callBtn.textContent = '📞 Starting…';
    const slowHint = setTimeout(() => {
      notify('Waiting for permission. Look for a camera/mic box near the address bar and click Allow.');
    }, 4000);

    try {
      localStream = await getMedia();
    } catch (err) {
      console.error('[call] could not get microphone:', err);
      notify('Could not use your microphone (' + (err.name || 'error') + '). Click the lock/camera icon next to the address bar, allow the microphone, then try again.');
      return;
    } finally {
      clearTimeout(slowHint);
      starting = false;
      if (!inCall && !localStream) updateButtons();
    }

    inCall = true;
    micOn = true;
    camOn = hasVideo;

    setPanelOpen(true);
    localTile = makeTile('You', myColor, true);
    localTile.video.srcObject = localStream;
    updateButtons();
    if (!hasVideo) notify('Joined with voice only (no camera available or it is being used by another tab).');

    // Ask the server to put us in this board's call
    console.log('[call] got camera/mic, asking server to join the call');
    socket.emit('call_join');
  }

  function leaveCall(tellServer) {
    if (!inCall) return;
    inCall = false;

    if (tellServer) socket.emit('call_leave');

    Object.keys(peers).forEach(removePeer);
    if (localStream) localStream.getTracks().forEach((t) => t.stop()); // turns the camera light off
    localStream = null;

    tilesEl.innerHTML = '';
    localTile = null;
    setPanelOpen(false);
    updateButtons();
  }

  // ---------- One connection per other person ----------

  function createPeer(peerId, info) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const tile = makeTile(info.name || 'Guest', info.color || '#888', false);
    const peer = { pc, tile, pendingCandidates: [] };
    peers[peerId] = peer;

    // Send our camera/mic to this person
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    // Show their camera/mic when it arrives
    pc.ontrack = (event) => {
      console.log('[call] received stream from', info.name);
      tile.video.srcObject = event.streams[0];
    };

    // Pass our network addresses to them (through the server)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('call_signal', { to: peerId, kind: 'candidate', candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[call] connection with', info.name, '->', pc.connectionState);
      tile.el.classList.toggle('failed', pc.connectionState === 'failed');
      if (tile.status) {
        if (pc.connectionState === 'connected') tile.status.style.display = 'none';
        else if (pc.connectionState === 'disconnected') {
          tile.status.style.display = 'flex';
          tile.status.textContent = 'Reconnecting…';
        }
      }
    };

    return peer;
  }

  function removePeer(peerId) {
    const peer = peers[peerId];
    if (!peer) return;
    peer.pc.close();
    peer.tile.el.remove();
    delete peers[peerId];
  }

  // The newcomer calls everyone already in the call
  async function callPeer(peerId, info) {
    const peer = createPeer(peerId, info);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('call_signal', {
      to: peerId,
      kind: 'offer',
      sdp: { type: offer.type, sdp: offer.sdp }
    });
  }

  async function flushCandidates(peer) {
    for (const c of peer.pendingCandidates) {
      try { await peer.pc.addIceCandidate(c); } catch (e) { /* ignore */ }
    }
    peer.pendingCandidates = [];
  }

  // ---------- Messages from the server ----------

  socket.on('call_peers', (existing) => {
    console.log('[call] people already in the call:', existing.length);
    if (!inCall) return;
    existing.forEach((p) => {
      callPeer(p.id, p).catch((err) => console.error('call failed:', err));
    });
  });

  socket.on('call_full', (info) => {
    notify('This call is full (max ' + info.max + ' people).');
    leaveCall(false);
  });

  socket.on('call_signal', async (msg) => {
    if (msg.kind !== 'candidate') console.log('[call] got', msg.kind, 'from', msg.name);
    if (!inCall) return;
    try {
      if (msg.kind === 'offer') {
        // Someone new is calling us: answer them
        const peer = peers[msg.from] || createPeer(msg.from, msg);
        await peer.pc.setRemoteDescription(msg.sdp);
        await flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('call_signal', {
          to: msg.from,
          kind: 'answer',
          sdp: { type: answer.type, sdp: answer.sdp }
        });
      } else if (msg.kind === 'answer') {
        const peer = peers[msg.from];
        if (!peer) return;
        await peer.pc.setRemoteDescription(msg.sdp);
        await flushCandidates(peer);
      } else if (msg.kind === 'candidate') {
        const peer = peers[msg.from];
        if (!peer) return;
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(msg.candidate);
        } else {
          peer.pendingCandidates.push(msg.candidate); // too early, keep for later
        }
      }
    } catch (err) {
      console.error('call signal error:', err);
    }
  });

  socket.on('call_peer_left', (data) => {
    removePeer(data.id);
  });

  // Keep names/colors on the tiles up to date (rename, etc.)
  socket.on('users_update', (users) => {
    users.forEach((u) => {
      if (u.id === myId) setTileInfo(localTile && { label: localTile.label, el: localTile.el }, 'You', u.color);
      else if (peers[u.id]) setTileInfo(peers[u.id].tile, u.name, u.color);
    });
  });

  // Lost the connection to the server: the call ends (rejoin after reconnect)
  socket.on('disconnect', () => {
    leaveCall(false);
  });

  // ---------- Buttons ----------

  function updateButtons() {
    callBtn.textContent = inCall ? '📞 In call' : '📞 Join Call';
    callBtn.disabled = inCall || starting;

    micBtn.textContent = micOn ? '🎤' : '🔇';
    micBtn.title = micOn ? 'Mute microphone' : 'Unmute microphone';
    micBtn.classList.toggle('off', !micOn);

    camBtn.textContent = camOn ? '📷' : '🚫';
    camBtn.title = hasVideo ? (camOn ? 'Turn camera off' : 'Turn camera on') : 'No camera available';
    camBtn.classList.toggle('off', !camOn);
    camBtn.disabled = !hasVideo;
  }

  callBtn.addEventListener('click', joinCall);
  leaveBtn.addEventListener('click', () => leaveCall(true));

  micBtn.addEventListener('click', () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
    updateButtons();
  });

  camBtn.addEventListener('click', () => {
    if (!localStream || !hasVideo) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
    updateButtons();
  });

  // Closing the tab: tell the server we left
  window.addEventListener('beforeunload', () => {
    if (inCall) socket.emit('call_leave');
  });

  updateButtons();
})();