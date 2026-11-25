'use strict';
// Runs the REAL index.html, app.js and call.js in a simulated browser (jsdom),
// with a fake server connection, fake camera and fake WebRTC.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTrack(kind) {
  return { kind, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

function makeStream(kinds = ['audio', 'video']) {
  const tracks = kinds.map(makeTrack);
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

function createPage(options = {}) {
  const {
    room = 'testroom',          // null = open the page with no ?room= in the link
    username = 'Muthu',         // null = a first-time visitor with no saved name
    connected = true,           // is the fake socket connected?
    storage = {},               // things already saved in the browser, e.g. { 'whiteboard_notes_alpha': '[...]' }
    mutateHtml = (html) => html,
    files = ['app.js', 'call.js'],
  } = options;

  // Take the page's own <script> tags out; we run the files ourselves below.
  const html = mutateHtml(read('index.html').replace(/<script[\s\S]*?<\/script>/g, ''));

  const errors = [];
  const logs = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  ['log', 'warn', 'error'].forEach((level) =>
    virtualConsole.on(level, (...args) => logs.push(`${level}: ${args.join(' ')}`)));

  const query = room === null ? '' : `?room=${encodeURIComponent(room)}`;
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:5000/${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const w = dom.window;
  const d = w.document;

  if (username) w.localStorage.setItem('whiteboard_username', username);
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);

  // ----- fake socket: remembers what the app sends, lets tests "receive" events -----
  const handlers = {};
  const sent = [];
  const socket = {
    connected,
    id: 'me',
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    // Copy the data: it becomes a plain snapshot, safe to compare in tests
    emit(name, data) { sent.push({ name, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) }); },
    connect() {},
  };
  w.io = () => socket;

  // ----- fake camera/mic and fake WebRTC connections -----
  const media = {
    stream: makeStream(),
    pcs: [],
    getUserMedia: async () => media.stream,
  };
  w.navigator.mediaDevices = { getUserMedia: (constraints) => media.getUserMedia(constraints) };
  w.RTCPeerConnection = function FakePeerConnection() {
    const pc = {
      remoteDescription: null, tracksAdded: 0, candidates: 0, closed: false,
      addTrack() { this.tracksAdded += 1; },
      async createOffer() { return { type: 'offer', sdp: 'o' }; },
      async createAnswer() { return { type: 'answer', sdp: 'a' }; },
      async setLocalDescription(x) { this.local = x; },
      async setRemoteDescription(x) { this.remoteDescription = x; },
      async addIceCandidate() { this.candidates += 1; },
      close() { this.closed = true; },
    };
    media.pcs.push(pc);
    return pc;
  };

  // Real <script> elements share one global scope, like in a browser.
  for (const file of files) {
    const script = d.createElement('script');
    script.textContent = read(file);
    d.body.appendChild(script);
  }

  const page = {
    w, d, socket, sent, errors, logs, media,
    async fire(name, payload) { for (const fn of handlers[name] || []) await fn(payload); },
    sentOf: (name) => sent.filter((s) => s.name === name).map((s) => s.data),
    clearSent: () => { sent.length = 0; },
    run: (code) => w.eval(code),
    // Evaluate code in the page and get back plain data (safe to compare in tests)
    js(code) {
      const text = w.eval(`JSON.stringify(${code})`);
      return text === undefined ? undefined : JSON.parse(text);
    },
    notes: () => page.js('notes'),
    noteEls: () => [...d.querySelectorAll('.note')],
    saved: (key) => w.localStorage.getItem(key),
    $: (selector) => d.querySelector(selector),
    click: (selector) => d.querySelector(selector).click(),
    close: () => w.close(),
  };
  return page;
}

// Creates pages and closes them all after each test, so no timers are left running.
function setupPages(afterEach) {
  const pages = [];
  afterEach(() => { while (pages.length) pages.pop().close(); });
  return (options) => { const page = createPage(options); pages.push(page); return page; };
}

module.exports = { createPage, setupPages, makeStream, sleep };