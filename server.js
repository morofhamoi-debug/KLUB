'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

/* ============================== CONFIG ============================== */
const MAX_PLAYERS_PER_ROOM = 10;
const ROOM_SIZE = 20;
const HALF = ROOM_SIZE / 2;
const WALL_THICK = 0.2;
const PLAYER_RADIUS = 0.55;
const MAX_SPEED = 9;
const MAX_MSG_PER_SEC = 80;
const MAX_MSG_SIZE = 2048;
const RATE_WINDOW_MS = 1000;

const FURNITURE = [
  { x: -5.5, z: -7.5, w: 4.0, d: 1.4 },
  { x: 3.0, z: 0.0, w: 2.6, d: 1.6 },
  { x: 1.0, z: 0.0, w: 0.9, d: 0.9 },
  { x: 5.0, z: 0.0, w: 0.9, d: 0.9 },
  { x: 3.0, z: -1.9, w: 0.9, d: 0.9 },
  { x: 3.0, z: 1.9, w: 0.9, d: 0.9 },
  { x: -8.5, z: 5.0, w: 1.2, d: 4.0 },
  { x: 7.5, z: -8.5, w: 2.2, d: 1.2 }
];

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6',
  '#1abc9c','#e67e22','#e84393','#00bcd4','#8bc34a'];

/* ============================== STATE ============================== */
const rooms = new Map();

/* ============================== HELPERS ============================== */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  name = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  if (name.length < 1) return null;
  return name;
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcastToRoom(room, obj, excludeWs) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws === excludeWs) continue;
    if (p.ws.readyState === p.ws.OPEN) {
      try { p.ws.send(data); } catch (e) {}
    }
  }
}

function pickColor(room) {
  const used = new Set();
  for (const p of room.players.values()) used.add(p.color);
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/* ============================== MESSAGE HANDLERS ============================== */
function handleCreateRoom(ws, msg) {
  if (ws.playerId) return;
  const name = sanitizeName(msg.name);
  if (!name) return sendJson(ws, { type: 'error', message: 'Некорректное имя' });
  const code = generateRoomCode();
  const room = { code, players: new Map() };
  rooms.set(code, room);
  joinRoom(ws, room, name);
}

function handleJoinRoom(ws, msg) {
  if (ws.playerId) return;
  const name = sanitizeName(msg.name);
  if (!name) return sendJson(ws, { type: 'error', message: 'Некорректное имя' });
  const code = String(msg.code || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) return sendJson(ws, { type: 'error', message: 'Неверный код комнаты' });
  const room = rooms.get(code);
  if (!room) return sendJson(ws, { type: 'error', message: 'Комната не найдена' });
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) return sendJson(ws, { type: 'error', message: 'Комната заполнена' });
  joinRoom(ws, room, name);
}

function joinRoom(ws, room, name) {
  const id = crypto.randomBytes(8).toString('hex');
  const color = pickColor(room);
  const player = {
    id, name, color,
    x: (Math.random() - 0.5) * 6,
    y: 0,
    z: (Math.random() - 0.5) * 6,
    ry: 0,
    moving: false,
    running: false,
    lastUpdate: Date.now(),
    ws
  };
  room.players.set(id, player);
  ws.playerId = id;
  ws.roomCode = room.code;

  sendJson(ws, {
    type: 'roomState',
    roomCode: room.code,
    selfId: id,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, z: p.z, ry: p.ry
    }))
  });

  broadcastToRoom(room, {
    type: 'playerJoined',
    id, name, color,
    x: player.x, y: player.y, z: player.z, ry: player.ry
  }, ws);
}

function handlePlayerMoved(ws, msg) {
  if (!ws.roomCode || !ws.playerId) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players.get(ws.playerId);
  if (!p) return;
  if (typeof msg.x !== 'number' || typeof msg.z !== 'number') return;
  if (!isFinite(msg.x) || !isFinite(msg.z)) return;

  let x = msg.x, z = msg.z;
  let y = (typeof msg.y === 'number' && isFinite(msg.y)) ? msg.y : 0;
  let ry = (typeof msg.ry === 'number' && isFinite(msg.ry)) ? msg.ry : p.ry;

  const lim = HALF - WALL_THICK - PLAYER_RADIUS;
  x = clamp(x, -lim, lim);
  z = clamp(z, -lim, lim);
  y = clamp(y, 0, 3);

  const now = Date.now();
  const dt = Math.max((now - p.lastUpdate) / 1000, 0.016);
  const dx = x - p.x, dz = z - p.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const maxDist = MAX_SPEED * dt * 2 + 0.5;
  if (dist > maxDist) {
    const k = maxDist / dist;
    x = p.x + dx * k;
    z = p.z + dz * k;
  }

  p.x = x; p.y = y; p.z = z; p.ry = ry;
  p.moving = !!msg.moving;
  p.running = !!msg.running;
  p.lastUpdate = now;

  broadcastToRoom(room, {
    type: 'playerMoved',
    id: p.id,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    moving: p.moving, running: p.running
  }, ws);
}

function handleDisconnect(ws) {
  if (!ws.roomCode || !ws.playerId) return;
  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  const pid = ws.playerId;
  ws.playerId = null;
  if (!room) return;
  room.players.delete(pid);
  broadcastToRoom(room, { type: 'playerLeft', id: pid });
  if (room.players.size === 0) rooms.delete(room.code);
}

function handleMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'createRoom':  handleCreateRoom(ws, msg); break;
    case 'joinRoom':    handleJoinRoom(ws, msg); break;
    case 'playerMoved': handlePlayerMoved(ws, msg); break;
    case 'ping':        sendJson(ws, { type: 'pong', t: msg.t }); break;
    default: break;
  }
}

/* ============================== HTTP ============================== */
const app = express();

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_PAGE);
});

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);

/* ============================== WS ============================== */
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomCode = null;
  ws.msgCount = 0;
  ws.msgWindowStart = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    if (data.length > MAX_MSG_SIZE) return;
    const now = Date.now();
    if (now - ws.msgWindowStart > RATE_WINDOW_MS) {
      ws.msgWindowStart = now;
      ws.msgCount = 0;
    }
    ws.msgCount++;
    if (ws.msgCount > MAX_MSG_PER_SEC) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

/* ============================== HTML PAGE ============================== */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0a0b10">
<title>3D Multiplayer Room</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0b10;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #e8ecf1; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
#renderCanvas { position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; touch-action: none; outline: none; }
.hidden { display: none !important; }

/* MENU */
#menu { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: radial-gradient(circle at 50% 30%, #1a1f35 0%, #06070c 100%);
  z-index: 10; padding: 16px; }
.panel { width: 100%; max-width: 380px; background: rgba(20, 24, 38, 0.85);
  border: 1px solid rgba(120, 160, 255, 0.18); border-radius: 20px;
  padding: 28px 24px; backdrop-filter: blur(18px);
  box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
.panel h1 { font-size: 24px; text-align: center; margin-bottom: 4px;
  background: linear-gradient(90deg, #7ab8ff, #a97aff);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; font-weight: 700; }
.panel .sub { text-align: center; color: #8892a6; font-size: 12px; margin-bottom: 22px; }
.panel input { width: 100%; padding: 12px 14px; border-radius: 10px;
  border: 1px solid rgba(120, 160, 255, 0.22); background: rgba(10, 14, 24, 0.7);
  color: #e8ecf1; font-size: 15px; outline: none; transition: border-color 0.2s; }
.panel input:focus { border-color: #7ab8ff; }
.panel input + input { margin-top: 10px; }
.btn { display: block; width: 100%; padding: 12px 14px; margin-top: 10px;
  border: none; border-radius: 10px; font-size: 15px; font-weight: 600;
  cursor: pointer; transition: transform 0.1s, opacity 0.2s; }
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: linear-gradient(135deg, #4a7fff, #7a52ff); color: white; }
.btn-secondary { background: rgba(120, 160, 255, 0.14); color: #a8c0ff;
  border: 1px solid rgba(120, 160, 255, 0.28); }
.or { text-align: center; color: #5a6378; font-size: 12px; margin: 14px 0 4px; }
#menuStatus { margin-top: 14px; text-align: center; font-size: 13px;
  color: #ff8f8f; min-height: 18px; }

/* HUD */
#hud { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
#hud > * { pointer-events: auto; }
.hud-top { position: absolute; top: 10px; left: 10px; right: 10px;
  display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.room-info { background: rgba(20, 24, 38, 0.8);
  border: 1px solid rgba(120,160,255,0.2); border-radius: 12px;
  padding: 8px 12px; display: flex; align-items: center; gap: 8px;
  backdrop-filter: blur(10px); font-size: 13px; }
.room-info .code { font-weight: 700; letter-spacing: 2px; color: #7ab8ff;
  font-family: 'Courier New', monospace; }
.room-info button { background: rgba(120,160,255,0.18);
  border: 1px solid rgba(120,160,255,0.3); border-radius: 8px;
  color: #a8c0ff; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.hud-players { position: absolute; top: 60px; right: 10px;
  background: rgba(20,24,38,0.8); border: 1px solid rgba(120,160,255,0.2);
  border-radius: 12px; padding: 10px 12px; min-width: 130px;
  backdrop-filter: blur(10px); font-size: 12px; }
.hud-players h3 { font-size: 11px; text-transform: uppercase;
  letter-spacing: 1px; color: #8892a6; margin-bottom: 6px; font-weight: 600; }
.hud-players .pl { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.hud-players .dot { width: 8px; height: 8px; border-radius: 50%; }
.hud-players .me { color: #7ab8ff; font-weight: 600; }
#exitBtn { background: rgba(255, 100, 100, 0.15);
  border: 1px solid rgba(255, 100, 100, 0.35); border-radius: 12px;
  color: #ff9a9a; padding: 8px 14px; font-size: 13px; cursor: pointer;
  backdrop-filter: blur(10px); }
#connectionStatus { position: absolute; bottom: 10px; left: 50%;
  transform: translateX(-50%); background: rgba(20,24,38,0.8);
  padding: 6px 14px; border-radius: 20px; font-size: 12px;
  color: #8892a6; backdrop-filter: blur(10px); }
#connectionStatus.ok { color: #6ee7a8; }
#connectionStatus.bad { color: #ff9a9a; }

/* Notifications */
#notifications { position: absolute; top: 100px; left: 50%;
  transform: translateX(-50%); z-index: 20; pointer-events: none;
  display: flex; flex-direction: column; gap: 6px; align-items: center; }
.notif { background: rgba(20,24,38,0.9);
  border: 1px solid rgba(120,160,255,0.25); border-radius: 10px;
  padding: 8px 16px; font-size: 13px; color: #e8ecf1;
  backdrop-filter: blur(10px); animation: notifIn 0.3s ease; }
@keyframes notifIn { from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); } }

/* Mobile controls */
#joystick { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
#joystickBase { position: absolute; left: 24px; bottom: 24px;
  width: 130px; height: 130px; border-radius: 50%;
  background: rgba(255,255,255,0.06);
  border: 2px solid rgba(120,160,255,0.22);
  pointer-events: auto; touch-action: none; }
#joystickKnob { position: absolute; left: 50%; top: 50%;
  width: 56px; height: 56px; border-radius: 50%;
  background: rgba(120,160,255,0.45);
  border: 2px solid rgba(180,200,255,0.6);
  transform: translate(-50%, -50%); pointer-events: none; }
#runBtn { position: absolute; right: 24px; bottom: 40px;
  width: 84px; height: 84px; border-radius: 50%;
  background: rgba(120,160,255,0.18);
  border: 2px solid rgba(120,160,255,0.4);
  color: #a8c0ff; font-size: 13px; font-weight: 600;
  pointer-events: auto; touch-action: none; }
#runBtn.active { background: rgba(120,160,255,0.5); color: white; }

@media (max-width: 600px) {
  .room-info { padding: 6px 10px; font-size: 12px; }
  .hud-players { font-size: 11px; min-width: 110px; }
}
</style>
</head>
<body>

<canvas id="renderCanvas"></canvas>

<div id="menu">
  <div class="panel">
    <h1>3D Multiplayer Room</h1>
    <div class="sub">Онлайн-комната в реальном времени</div>
    <input id="nameInput" placeholder="Ваше имя" maxlength="20" autocomplete="off">
    <button id="createBtn" class="btn btn-primary">Создать комнату</button>
    <div class="or">— или —</div>
    <input id="codeInput" placeholder="Код комнаты" maxlength="6" autocomplete="off">
    <button id="joinBtn" class="btn btn-secondary">Войти по коду</button>
    <div id="menuStatus"></div>
  </div>
</div>

<div id="hud" class="hidden">
  <div class="hud-top">
    <div class="room-info">
      <span>Комната</span>
      <span id="roomCode" class="code">------</span>
      <button id="copyBtn">Копировать</button>
    </div>
    <button id="exitBtn">Выйти</button>
  </div>
  <div class="hud-players">
    <div id="playersList"></div>
  </div>
  <div id="connectionStatus">Подключение...</div>
</div>

<div id="notifications"></div>

<div id="joystick" class="hidden">
  <div id="joystickBase">
    <div id="joystickKnob"></div>
  </div>
  <button id="runBtn">Бег</button>
</div>

<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script>
(function () {
  'use strict';

  /* ================== CONFIG ================== */
  var ROOM_SIZE = 20;
  var HALF = ROOM_SIZE / 2;
  var WALL_THICK = 0.2;
  var PLAYER_RADIUS = 0.55;
  var FURNITURE = [
    { x: -5.5, z: -7.5, w: 4.0, d: 1.4 },
    { x: 3.0, z: 0.0, w: 2.6, d: 1.6 },
    { x: 1.0, z: 0.0, w: 0.9, d: 0.9 },
    { x: 5.0, z: 0.0, w: 0.9, d: 0.9 },
    { x: 3.0, z: -1.9, w: 0.9, d: 0.9 },
    { x: 3.0, z: 1.9, w: 0.9, d: 0.9 },
    { x: -8.5, z: 5.0, w: 1.2, d: 4.0 },
    { x: 7.5, z: -8.5, w: 2.2, d: 1.2 }
  ];

  /* ================== UI ================== */
  var canvas = document.getElementById('renderCanvas');
  var menuEl = document.getElementById('menu');
  var hudEl = document.getElementById('hud');
  var nameInput = document.getElementById('nameInput');
  var codeInput = document.getElementById('codeInput');
  var createBtn = document.getElementById('createBtn');
  var joinBtn = document.getElementById('joinBtn');
  var menuStatus = document.getElementById('menuStatus');
  var roomCodeEl = document.getElementById('roomCode');
  var copyBtn = document.getElementById('copyBtn');
  var exitBtn = document.getElementById('exitBtn');
  var playersListEl = document.getElementById('playersList');
  var connectionStatusEl = document.getElementById('connectionStatus');
  var notificationsEl = document.getElementById('notifications');
  var joystickEl = document.getElementById('joystick');
  var joystickBase = document.getElementById('joystickBase');
  var joystickKnob = document.getElementById('joystickKnob');
  var runBtn = document.getElementById('runBtn');

  /* ================== STATE ================== */
  var state = {
    ws: null,
    connected: false,
    selfId: null,
    roomCode: null,
    playerName: '',
    players: new Map(),
    local: { x: 0, y: 0, z: 0, ry: 0, moving: false, running: false },
    input: { fwd: 0, right: 0, run: false },
    cameraYaw: 0,
    cameraBeta: 1.15,
    cameraDist: 6.5,
    keys: {},
    engine: null,
    scene: null,
    camera: null,
    shadowGen: null,
    lastSent: 0,
    inGame: false,
    reconnect: { active: false, attempts: 0, timer: null }
  };

  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
                 ('ontouchstart' in window && window.innerWidth < 900);

  /* ================== NOTIFICATIONS ================== */
  function notify(text, color) {
    var el = document.createElement('div');
    el.className = 'notif';
    el.textContent = text;
    if (color) el.style.color = color;
    notificationsEl.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity 0.4s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 420);
    }, 2400);
  }

  function setStatus(text, cls) {
    connectionStatusEl.textContent = text;
    connectionStatusEl.className = cls || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================== WS ================== */
  function wsUrl() {
    var proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function connectWS(onOpen) {
    try {
      var ws = new WebSocket(wsUrl());
    } catch (e) {
      setStatus('Ошибка соединения', 'bad');
      return;
    }
    state.ws = ws;
    ws.onopen = function () {
      state.connected = true;
      setStatus('Подключено', 'ok');
      if (onOpen) onOpen();
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleServerMessage(msg);
    };
    ws.onclose = function () {
      state.connected = false;
      if (state.inGame && state.playerName && state.roomCode) {
        setStatus('Переподключение...', 'bad');
        attemptReconnect();
      } else {
        setStatus('Отключено', 'bad');
      }
    };
    ws.onerror = function () {};
  }

  function attemptReconnect() {
    if (state.reconnect.active) return;
    state.reconnect.active = true;
    state.reconnect.attempts = 0;
    tryReconnectLoop();
  }

  function tryReconnectLoop() {
    if (state.reconnect.attempts >= 8) {
      state.reconnect.active = false;
      notify('Не удалось восстановить соединение');
      backToMenu();
      return;
    }
    state.reconnect.attempts++;
    var name = state.playerName;
    var code = state.roomCode;
    setTimeout(function () {
      if (!state.inGame) { state.reconnect.active = false; return; }
      var ws;
      try { ws = new WebSocket(wsUrl()); } catch (e) { tryReconnectLoop(); return; }
      ws.onopen = function () {
        state.ws = ws;
        state.connected = true;
        state.reconnect.active = false;
        setStatus('Подключено', 'ok');
        notify('Соединение восстановлено', '#6ee7a8');
        ws.send(JSON.stringify({ type: 'joinRoom', name: name, code: code }));
      };
      ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        handleServerMessage(msg);
      };
      ws.onclose = function () {
        state.connected = false;
        setStatus('Переподключение...', 'bad');
        tryReconnectLoop();
      };
      ws.onerror = function () {};
    }, 800);
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  /* ================== SERVER MESSAGES ================== */
  function handleServerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'roomState': onRoomState(msg); break;
      case 'playerJoined': onPlayerJoined(msg); break;
      case 'playerMoved': onPlayerMoved(msg); break;
      case 'playerLeft': onPlayerLeft(msg); break;
      case 'error': onError(msg); break;
      case 'pong': break;
      default: break;
    }
  }

  function onError(msg) {
    menuStatus.textContent = msg.message || 'Ошибка';
    setTimeout(function () { menuStatus.textContent = ''; }, 3000);
  }

  function onRoomState(msg) {
    state.selfId = msg.selfId;
    state.roomCode = msg.roomCode;
    roomCodeEl.textContent = msg.roomCode;

    var ids = {};
    msg.players.forEach(function (p) { ids[p.id] = true; });

    // Remove players not present
    state.players.forEach(function (ch, id) {
      if (!ids[id]) {
        ch.root.dispose(false, true);
        state.players.delete(id);
      }
    });

    // Add or update
    msg.players.forEach(function (p) {
      if (p.id === msg.selfId) {
        state.local.x = p.x; state.local.y = p.y; state.local.z = p.z; state.local.ry = p.ry;
      }
      if (!state.players.has(p.id)) {
        var ch = buildCharacter(state.scene, p.color, p.name);
        ch.current.x = p.x; ch.current.y = p.y; ch.current.z = p.z; ch.current.ry = p.ry;
        ch.target.x = p.x; ch.target.y = p.y; ch.target.z = p.z; ch.target.ry = p.ry;
        ch.root.position.set(p.x, p.y, p.z);
        ch.root.rotation.y = p.ry;
        ch.name = p.name;
        ch.color = p.color;
        state.players.set(p.id, ch);
      } else {
        var e = state.players.get(p.id);
        e.target.x = p.x; e.target.y = p.y; e.target.z = p.z; e.target.ry = p.ry;
      }
    });

    updatePlayersList();
    notify('Вы вошли в комнату', '#7ab8ff');
  }

  function onPlayerJoined(msg) {
    if (state.players.has(msg.id)) return;
    var ch = buildCharacter(state.scene, msg.color, msg.name);
    ch.current.x = msg.x; ch.current.y = msg.y; ch.current.z = msg.z; ch.current.ry = msg.ry;
    ch.target.x = msg.x; ch.target.y = msg.y; ch.target.z = msg.z; ch.target.ry = msg.ry;
    ch.root.position.set(msg.x, msg.y, msg.z);
    ch.root.rotation.y = msg.ry;
    ch.name = msg.name;
    ch.color = msg.color;
    state.players.set(msg.id, ch);
    updatePlayersList();
    notify(msg.name + ' присоединился', '#6ee7a8');
  }

  function onPlayerMoved(msg) {
    var ch = state.players.get(msg.id);
    if (!ch) return;
    ch.target.x = msg.x;
    ch.target.y = msg.y;
    ch.target.z = msg.z;
    ch.target.ry = msg.ry;
    ch.moving = !!msg.moving;
    ch.running = !!msg.running;
  }

  function onPlayerLeft(msg) {
    var ch = state.players.get(msg.id);
    if (!ch) return;
    var name = ch.name;
    ch.root.dispose(false, true);
    state.players.delete(msg.id);
    updatePlayersList();
    if (name) notify(name + ' вышел', '#ff9a9a');
  }

  function updatePlayersList() {
    var html = '<h3>Игроки</h3>';
    state.players.forEach(function (ch, id) {
      var isMe = id === state.selfId;
      html += '<div class="pl' + (isMe ? ' me' : '') + '">';
      html += '<span class="dot" style="background:' + ch.color + '"></span>';
      html += '<span>' + escapeHtml(ch.name || '?') + (isMe ? ' (вы)' : '') + '</span>';
      html += '</div>';
    });
    playersListEl.innerHTML = html;
  }

  /* ================== BABYLON SCENE ================== */
  function initScene() {
    var engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: !isMobile
    });
    var scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.04, 0.05, 0.09, 1);
    scene.collisionsEnabled = false;

    var camera = new BABYLON.ArcRotateCamera('cam', 0, state.cameraBeta, state.cameraDist,
      new BABYLON.Vector3(0, 1.5, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 200;
    camera.lowerRadiusLimit = 2;
    camera.upperRadiusLimit = 14;
    camera.lowerBetaLimit = 0.2;
    camera.upperBetaLimit = 1.55;
    camera.fov = 1.0;
    // We handle inputs manually
    camera.inputs.clear();

    // Lights
    var hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    hemi.diffuse = new BABYLON.Color3(0.75, 0.82, 1.0);
    hemi.groundColor = new BABYLON.Color3(0.25, 0.22, 0.3);

    var dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.6, -1.6, -0.5), scene);
    dir.position = new BABYLON.Vector3(12, 18, 12);
    dir.intensity = 0.85;
    dir.shadowMinZ = 1;
    dir.shadowMaxZ = 60;

    var shadowGen;
    if (!isMobile) {
      shadowGen = new BABYLON.ShadowGenerator(1024, dir);
      shadowGen.useBlurExponentialShadowMap = true;
      shadowGen.blurKernel = 24;
      shadowGen.darkness = 0.35;
    } else {
      shadowGen = { addShadowCaster: function () {} };
    }

    buildRoom(scene, shadowGen);

    state.engine = engine;
    state.scene = scene;
    state.camera = camera;
    state.shadowGen = shadowGen;

    window.addEventListener('resize', function () { engine.resize(); });
    return engine;
  }

  /* ================== ROOM BUILD ================== */
  function buildRoom(scene, shadowGen) {
    var S = ROOM_SIZE, H = 4, h = HALF;

    var matFloor = new BABYLON.StandardMaterial('matFloor', scene);
    matFloor.diffuseColor = new BABYLON.Color3(0.42, 0.30, 0.22);
    matFloor.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);

    var matWall = new BABYLON.StandardMaterial('matWall', scene);
    matWall.diffuseColor = new BABYLON.Color3(0.84, 0.82, 0.78);

    var matCeil = new BABYLON.StandardMaterial('matCeil', scene);
    matCeil.diffuseColor = new BABYLON.Color3(0.92, 0.92, 0.95);

    var floor = BABYLON.MeshBuilder.CreateGround('floor', { width: S, height: S }, scene);
    floor.material = matFloor;
    floor.receiveShadows = true;

    var ceil = BABYLON.MeshBuilder.CreateBox('ceil', { width: S, height: 0.1, depth: S }, scene);
    ceil.position.y = H;
    ceil.material = matCeil;

    var wallDefs = [
      { w: S, d: WALL_THICK, x: 0, z: -h },
      { w: S, d: WALL_THICK, x: 0, z: h },
      { w: WALL_THICK, d: S, x: -h, z: 0 },
      { w: WALL_THICK, d: S, x: h, z: 0 }
    ];
    for (var i = 0; i < wallDefs.length; i++) {
      var wd = wallDefs[i];
      var w = BABYLON.MeshBuilder.CreateBox('wall' + i,
        { width: wd.w, height: H, depth: wd.d }, scene);
      w.position.set(wd.x, H / 2, wd.z);
      w.material = matWall;
      w.receiveShadows = true;
      shadowGen.addShadowCaster(w);
    }

    // Windows
    var matWindow = new BABYLON.StandardMaterial('matWin', scene);
    matWindow.diffuseColor = new BABYLON.Color3(0.4, 0.7, 1.0);
    matWindow.emissiveColor = new BABYLON.Color3(0.35, 0.55, 0.9);
    matWindow.alpha = 0.85;

    var win1 = BABYLON.MeshBuilder.CreateBox('win1', { width: 3, height: 2, depth: 0.06 }, scene);
    win1.position.set(-4, 2.2, -h + WALL_THICK / 2 + 0.04);
    win1.material = matWindow;

    var win2 = BABYLON.MeshBuilder.CreateBox('win2', { width: 3, height: 2, depth: 0.06 }, scene);
    win2.position.set(4, 2.2, -h + WALL_THICK / 2 + 0.04);
    win2.material = matWindow;

    // Door
    var matDoor = new BABYLON.StandardMaterial('matDoor', scene);
    matDoor.diffuseColor = new BABYLON.Color3(0.42, 0.27, 0.16);

    var door = BABYLON.MeshBuilder.CreateBox('door',
      { width: 0.1, height: 2.4, depth: 1.2 }, scene);
    door.position.set(h - WALL_THICK / 2 - 0.05, 1.2, -4);
    door.material = matDoor;

    var matMetal = new BABYLON.StandardMaterial('matMetal', scene);
    matMetal.diffuseColor = new BABYLON.Color3(0.85, 0.72, 0.28);
    matMetal.specularColor = new BABYLON.Color3(1, 1, 1);

    var handle = BABYLON.MeshBuilder.CreateSphere('handle', { diameter: 0.1 }, scene);
    handle.position.set(h - WALL_THICK - 0.12, 1.2, -3.55);
    handle.material = matMetal;

    // Carpet
    var matCarpet = new BABYLON.StandardMaterial('matCarpet', scene);
    matCarpet.diffuseColor = new BABYLON.Color3(0.5, 0.15, 0.2);
    var carpet = BABYLON.MeshBuilder.CreateBox('carpet',
      { width: 6, height: 0.02, depth: 4 }, scene);
    carpet.position.set(2, 0.011, 0);
    carpet.material = matCarpet;
    carpet.receiveShadows = true;

    // Ceiling lamp
    var matLamp = new BABYLON.StandardMaterial('matLamp', scene);
    matLamp.diffuseColor = new BABYLON.Color3(1, 0.95, 0.75);
    matLamp.emissiveColor = new BABYLON.Color3(1, 0.9, 0.6);

    var lampRod = BABYLON.MeshBuilder.CreateCylinder('lampRod',
      { diameter: 0.06, height: 0.4 }, scene);
    lampRod.position.set(0, H - 0.2, 0);
    lampRod.material = matMetal;

    var lampShade = BABYLON.MeshBuilder.CreateSphere('lampShade',
      { diameter: 0.9 }, scene);
    lampShade.position.set(0, H - 0.6, 0);
    lampShade.scaling.y = 0.55;
    lampShade.material = matLamp;

    var pl = new BABYLON.PointLight('pl', new BABYLON.Vector3(0, H - 0.7, 0), scene);
    pl.intensity = 0.55;
    pl.diffuse = new BABYLON.Color3(1, 0.95, 0.8);
    pl.range = 14;

    buildSofa(scene, shadowGen, -5.5, -7.5);
    buildTable(scene, shadowGen, 3, 0);
    buildChair(scene, shadowGen, 1, 0, Math.PI / 2);
    buildChair(scene, shadowGen, 5, 0, -Math.PI / 2);
    buildChair(scene, shadowGen, 3, -1.9, 0);
    buildChair(scene, shadowGen, 3, 1.9, Math.PI);
    buildBookshelf(scene, shadowGen, -8.5, 5);
    buildCabinet(scene, shadowGen, 7.5, -8.5);

    // Plant
    var matPot = new BABYLON.StandardMaterial('matPot', scene);
    matPot.diffuseColor = new BABYLON.Color3(0.55, 0.3, 0.2);
    var pot = BABYLON.MeshBuilder.CreateCylinder('pot',
      { diameterTop: 0.5, diameterBottom: 0.35, height: 0.5 }, scene);
    pot.position.set(-7, 0.25, 8.5);
    pot.material = matPot;

    var matLeaf = new BABYLON.StandardMaterial('matLeaf', scene);
    matLeaf.diffuseColor = new BABYLON.Color3(0.2, 0.55, 0.25);
    var leaf = BABYLON.MeshBuilder.CreateSphere('leaf', { diameter: 1.0 }, scene);
    leaf.position.set(-7, 1.15, 8.5);
    leaf.scaling.y = 1.4;
    leaf.material = matLeaf;
    shadowGen.addShadowCaster(leaf);
  }

  function buildSofa(scene, shadowGen, x, z) {
    var mat = new BABYLON.StandardMaterial('matSofa', scene);
    mat.diffuseColor = new BABYLON.Color3(0.28, 0.18, 0.32);
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);

    var base = BABYLON.MeshBuilder.CreateBox('sofaBase',
      { width: 4, height: 0.5, depth: 1.4 }, scene);
    base.position.set(x, 0.35, z);
    base.material = mat;
    base.receiveShadows = true;
    shadowGen.addShadowCaster(base);

    var back = BABYLON.MeshBuilder.CreateBox('sofaBack',
      { width: 4, height: 0.7, depth: 0.3 }, scene);
    back.position.set(x, 0.9, z + 0.55);
    back.material = mat;
    shadowGen.addShadowCaster(back);

    var armL = BABYLON.MeshBuilder.CreateBox('sofaArmL',
      { width: 0.3, height: 0.5, depth: 1.4 }, scene);
    armL.position.set(x - 1.85, 0.85, z);
    armL.material = mat;
    shadowGen.addShadowCaster(armL);

    var armR = BABYLON.MeshBuilder.CreateBox('sofaArmR',
      { width: 0.3, height: 0.5, depth: 1.4 }, scene);
    armR.position.set(x + 1.85, 0.85, z);
    armR.material = mat;
    shadowGen.addShadowCaster(armR);

    for (var i = -1; i <= 1; i++) {
      var c = BABYLON.MeshBuilder.CreateBox('sofaCush' + i,
        { width: 1.1, height: 0.15, depth: 1.1 }, scene);
      c.position.set(x + i * 1.2, 0.67, z);
      var cm = new BABYLON.StandardMaterial('cm' + i, scene);
      cm.diffuseColor = new BABYLON.Color3(0.35, 0.22, 0.38);
      c.material = cm;
    }
  }

  function buildTable(scene, shadowGen, x, z) {
    var mat = new BABYLON.StandardMaterial('matTable', scene);
    mat.diffuseColor = new BABYLON.Color3(0.42, 0.27, 0.16);
    mat.specularColor = new BABYLON.Color3(0.15, 0.1, 0.05);

    var top = BABYLON.MeshBuilder.CreateBox('tableTop',
      { width: 2.6, height: 0.12, depth: 1.6 }, scene);
    top.position.set(x, 0.85, z);
    top.material = mat;
    top.receiveShadows = true;
    shadowGen.addShadowCaster(top);

    var legPos = [
      [x - 1.15, z - 0.65], [x + 1.15, z - 0.65],
      [x - 1.15, z + 0.65], [x + 1.15, z + 0.65]
    ];
    for (var i = 0; i < legPos.length; i++) {
      var l = BABYLON.MeshBuilder.CreateBox('tleg' + i,
        { width: 0.1, height: 0.85, depth: 0.1 }, scene);
      l.position.set(legPos[i][0], 0.42, legPos[i][1]);
      l.material = mat;
    }
  }

  function buildChair(scene, shadowGen, x, z, rot) {
    var mat = new BABYLON.StandardMaterial('matChair' + x + z, scene);
    mat.diffuseColor = new BABYLON.Color3(0.32, 0.2, 0.13);

    var root = new BABYLON.TransformNode('chair' + x + z, scene);
    root.position.set(x, 0, z);
    root.rotation.y = rot || 0;

    var seat = BABYLON.MeshBuilder.CreateBox('chSeat',
      { width: 0.7, height: 0.08, depth: 0.7 }, scene);
    seat.position.y = 0.45;
    seat.material = mat;
    seat.parent = root;
    seat.receiveShadows = true;
    shadowGen.addShadowCaster(seat);

    var back = BABYLON.MeshBuilder.CreateBox('chBack',
      { width: 0.7, height: 0.7, depth: 0.08 }, scene);
    back.position.set(0, 0.8, -0.31);
    back.material = mat;
    back.parent = root;
    shadowGen.addShadowCaster(back);

    var lg = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]];
    for (var i = 0; i < lg.length; i++) {
      var l = BABYLON.MeshBuilder.CreateBox('chLeg' + i,
        { width: 0.06, height: 0.45, depth: 0.06 }, scene);
      l.position.set(lg[i][0], 0.22, lg[i][1]);
      l.material = mat;
      l.parent = root;
    }
  }

  function buildBookshelf(scene, shadowGen, x, z) {
    var mat = new BABYLON.StandardMaterial('matBs', scene);
    mat.diffuseColor = new BABYLON.Color3(0.35, 0.22, 0.15);

    var body = BABYLON.MeshBuilder.CreateBox('bs',
      { width: 1.2, height: 2.4, depth: 4.0 }, scene);
    body.position.set(x, 1.2, z);
    body.material = mat;
    body.receiveShadows = true;
    shadowGen.addShadowCaster(body);

    var matBook = new BABYLON.StandardMaterial('matBook', scene);
    matBook.diffuseColor = new BABYLON.Color3(0.7, 0.25, 0.25);

    for (var s = 0; s < 4; s++) {
      for (var b = 0; b < 4; b++) {
        var bk = BABYLON.MeshBuilder.CreateBox('bk' + s + b,
          { width: 0.9, height: 0.35, depth: 0.5 }, scene);
        bk.position.set(x + 0.15, 0.5 + s * 0.55, z - 1.4 + b * 0.9);
        var bmat = new BABYLON.StandardMaterial('bm' + s + b, scene);
        bmat.diffuseColor = new BABYLON.Color3(
          0.4 + (s * 0.15 + b * 0.07) % 0.5,
          0.25 + (s * 0.1 + b * 0.13) % 0.5,
          0.5 - (b * 0.08) % 0.4
        );
        bk.material = bmat;
      }
    }
  }

  function buildCabinet(scene, shadowGen, x, z) {
    var mat = new BABYLON.StandardMaterial('matCab', scene);
    mat.diffuseColor = new BABYLON.Color3(0.3, 0.24, 0.18);

    var body = BABYLON.MeshBuilder.CreateBox('cab',
      { width: 2.2, height: 1.4, depth: 1.2 }, scene);
    body.position.set(x, 0.7, z);
    body.material = mat;
    body.receiveShadows = true;
    shadowGen.addShadowCaster(body);

    var matMetal = new BABYLON.StandardMaterial('cabM', scene);
    matMetal.diffuseColor = new BABYLON.Color3(0.8, 0.75, 0.4);
    var h1 = BABYLON.MeshBuilder.CreateSphere('cabH1', { diameter: 0.08 }, scene);
    h1.position.set(x - 0.35, 0.85, z - 0.62);
    h1.material = matMetal;
    var h2 = BABYLON.MeshBuilder.CreateSphere('cabH2', { diameter: 0.08 }, scene);
    h2.position.set(x + 0.35, 0.85, z - 0.62);
    h2.material = matMetal;
  }

  /* ================== CHARACTER ================== */
  function buildCharacter(scene, colorHex, name) {
    var root = new BABYLON.TransformNode('char_' + Math.random().toString(36).slice(2), scene);

    var clothMat = new BABYLON.StandardMaterial('cloth_' + Math.random(), scene);
    clothMat.diffuseColor = BABYLON.Color3.FromHexString(colorHex);
    clothMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);

    var skinMat = new BABYLON.StandardMaterial('skin_' + Math.random(), scene);
    skinMat.diffuseColor = new BABYLON.Color3(0.95, 0.78, 0.62);

    var pantsMat = new BABYLON.StandardMaterial('pants_' + Math.random(), scene);
    pantsMat.diffuseColor = new BABYLON.Color3(0.18, 0.22, 0.32);

    var hairMat = new BABYLON.StandardMaterial('hair_' + Math.random(), scene);
    hairMat.diffuseColor = new BABYLON.Color3(0.15, 0.1, 0.08);

    // Legs
    var legL = new BABYLON.TransformNode('legLPivot', scene);
    legL.parent = root;
    legL.position.set(-0.14, 0.7, 0);
    var legLMesh = BABYLON.MeshBuilder.CreateBox('legLMesh',
      { width: 0.22, height: 0.7, depth: 0.22 }, scene);
    legLMesh.position.y = -0.35;
    legLMesh.material = pantsMat;
    legLMesh.parent = legL;

    var legR = new BABYLON.TransformNode('legRPivot', scene);
    legR.parent = root;
    legR.position.set(0.14, 0.7, 0);
    var legRMesh = BABYLON.MeshBuilder.CreateBox('legRMesh',
      { width: 0.22, height: 0.7, depth: 0.22 }, scene);
    legRMesh.position.y = -0.35;
    legRMesh.material = pantsMat;
    legRMesh.parent = legR;

    // Torso
    var torso = BABYLON.MeshBuilder.CreateBox('torso',
      { width: 0.6, height: 0.75, depth: 0.32 }, scene);
    torso.position.y = 1.07;
    torso.material = clothMat;
    torso.parent = root;

    // Arms
    var armL = new BABYLON.TransformNode('armLPivot', scene);
    armL.parent = root;
    armL.position.set(-0.4, 1.4, 0);
    var armLMesh = BABYLON.MeshBuilder.CreateBox('armLMesh',
      { width: 0.18, height: 0.72, depth: 0.18 }, scene);
    armLMesh.position.y = -0.36;
    armLMesh.material = clothMat;
    armLMesh.parent = armL;

    var armR = new BABYLON.TransformNode('armRPivot', scene);
    armR.parent = root;
    armR.position.set(0.4, 1.4, 0);
    var armRMesh = BABYLON.MeshBuilder.CreateBox('armRMesh',
      { width: 0.18, height: 0.72, depth: 0.18 }, scene);
    armRMesh.position.y = -0.36;
    armRMesh.material = clothMat;
    armRMesh.parent = armR;

    // Head
    var head = BABYLON.MeshBuilder.CreateSphere('head',
      { diameter: 0.42 }, scene);
    head.position.y = 1.7;
    head.material = skinMat;
    head.parent = root;

    // Hair
    var hair = BABYLON.MeshBuilder.CreateSphere('hair',
      { diameter: 0.44 }, scene);
    hair.position.y = 1.76;
    hair.scaling.y = 0.65;
    hair.material = hairMat;
    hair.parent = root;

    // Name tag
    var dt = new BABYLON.DynamicTexture('nt_' + Math.random(),
      { width: 512, height: 128 }, scene, true);
    dt.hasAlpha = true;
    dt.drawText(name, null, 90, 'bold 56px Arial', '#ffffff', 'transparent', true);
    var ntMat = new BABYLON.StandardMaterial('ntMat_' + Math.random(), scene);
    ntMat.diffuseTexture = dt;
    ntMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    ntMat.disableLighting = true;
    ntMat.useAlphaFromDiffuseTexture = true;
    ntMat.backFaceCulling = false;
    var plane = BABYLON.MeshBuilder.CreatePlane('ntPlane',
      { width: 1.4, height: 0.35 }, scene);
    plane.material = ntMat;
    plane.position.y = 2.2;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.parent = root;

    return {
      root: root,
      parts: { legL: legL, legR: legR, armL: armL, armR: armR, torso: torso, head: head },
      walkPhase: 0,
      moving: false,
      running: false,
      current: { x: 0, y: 0, z: 0, ry: 0 },
      target: { x: 0, y: 0, z: 0, ry: 0 }
    };
  }

  function animateCharacter(ch, dt) {
    var speed = ch.running ? 13 : 9;
    if (ch.moving) {
      ch.walkPhase += dt * speed;
    } else {
      ch.walkPhase *= 0.85;
    }
    var amp = ch.moving ? (ch.running ? 0.95 : 0.65) : 0.0;
    var s = Math.sin(ch.walkPhase);
    ch.parts.legL.rotation.x = s * amp * 0.8;
    ch.parts.legR.rotation.x = -s * amp * 0.8;
    ch.parts.armL.rotation.x = -s * amp * 0.7;
    ch.parts.armR.rotation.x = s * amp * 0.7;
    // Head bob
    ch.parts.head.position.y = 1.7 + Math.abs(s) * amp * 0.02;
  }

  /* ================== COLLISION ================== */
  function resolveCollision(nx, nz, ox, oz) {
    var r = PLAYER_RADIUS;
    var lim = HALF - WALL_THICK - r;

    nx = Math.max(-lim, Math.min(lim, nx));
    nz = Math.max(-lim, Math.min(lim, nz));

    for (var i = 0; i < FURNITURE.length; i++) {
      var f = FURNITURE[i];
      var minX = f.x - f.w / 2 - r;
      var maxX = f.x + f.w / 2 + r;
      var minZ = f.z - f.d / 2 - r;
      var maxZ = f.z + f.d / 2 + r;
      if (nx > minX && nx < maxX && nz > minZ && nz < maxZ) {
        var dxL = nx - minX;
        var dxR = maxX - nx;
        var dzL = nz - minZ;
        var dzR = maxZ - nz;
        var m = Math.min(dxL, dxR, dzL, dzR);
        if (m === dxL) nx = minX;
        else if (m === dxR) nx = maxX;
        else if (m === dzL) nz = minZ;
        else nz = maxZ;
      }
    }
    return { x: nx, z: nz };
  }

  /* ================== INPUT ================== */
  function setupDesktopInput() {
    window.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var k = e.key.toLowerCase();
      state.keys[k] = true;
      if (k === ' ' || k === 'spacebar') { state.keys['space'] = true; }
      if (['w', 'a', 's', 'd', 'shift', ' '].indexOf(k) >= 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) {
      var k = e.key.toLowerCase();
      state.keys[k] = false;
      if (k === ' ' || k === 'spacebar') state.keys['space'] = false;
    });
    window.addEventListener('blur', function () { state.keys = {}; });

    canvas.addEventListener('click', function () {
      if (state.inGame && !isMobile && canvas.requestPointerLock) {
        canvas.requestPointerLock();
      }
    });
    document.addEventListener('mousemove', function (e) {
      if (document.pointerLockElement !== canvas) return;
      state.cameraYaw -= e.movementX * 0.0025;
      state.cameraBeta -= e.movementY * 0.0025;
      state.cameraBeta = Math.max(0.25, Math.min(1.5, state.cameraBeta));
    });
    canvas.addEventListener('wheel', function (e) {
      state.cameraDist += e.deltaY * 0.005;
      state.cameraDist = Math.max(3, Math.min(12, state.cameraDist));
      e.preventDefault();
    }, { passive: false });
  }

  function setupMobileInput() {
    var joyActive = false;
    var joyId = null;
    var joyCenter = { x: 0, y: 0 };
    var joyRadius = 55;

    function startJoy(e) {
      var t = e.changedTouches ? e.changedTouches[0] : e;
      joyId = t.identifier !== undefined ? t.identifier : 'mouse';
      var rect = joystickBase.getBoundingClientRect();
      joyCenter.x = rect.left + rect.width / 2;
      joyCenter.y = rect.top + rect.height / 2;
      joyActive = true;
      moveJoy(t.clientX, t.clientY);
      e.preventDefault();
    }
    function moveJoy(cx, cy) {
      var dx = cx - joyCenter.x;
      var dy = cy - joyCenter.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > joyRadius) {
        dx = dx / d * joyRadius;
        dy = dy / d * joyRadius;
      }
      joystickKnob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
      state.input.right = dx / joyRadius;
      state.input.fwd = -dy / joyRadius;
    }
    function endJoy() {
      joyActive = false;
      joyId = null;
      joystickKnob.style.transform = 'translate(-50%, -50%)';
      state.input.right = 0;
      state.input.fwd = 0;
    }

    joystickBase.addEventListener('touchstart', startJoy, { passive: false });
    joystickBase.addEventListener('touchmove', function (e) {
      if (!joyActive) return;
      var t = e.changedTouches[0];
      if (t.identifier !== joyId) return;
      moveJoy(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });
    joystickBase.addEventListener('touchend', endJoy);
    joystickBase.addEventListener('touchcancel', endJoy);
    joystickBase.addEventListener('mousedown', startJoy);
    window.addEventListener('mousemove', function (e) {
      if (joyActive && joyId === 'mouse') moveJoy(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', function () {
      if (joyId === 'mouse') endJoy();
    });

    // Camera swipe on right side
    var camId = null;
    var camLast = { x: 0, y: 0 };
    canvas.addEventListener('touchstart', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.clientX > window.innerWidth / 2 && camId === null) {
          camId = t.identifier;
          camLast.x = t.clientX;
          camLast.y = t.clientY;
        }
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === camId) {
          var dx = t.clientX - camLast.x;
          var dy = t.clientY - camLast.y;
          state.cameraYaw -= dx * 0.006;
          state.cameraBeta -= dy * 0.006;
          state.cameraBeta = Math.max(0.25, Math.min(1.5, state.cameraBeta));
          camLast.x = t.clientX;
          camLast.y = t.clientY;
          e.preventDefault();
        }
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === camId) camId = null;
      }
    });

    // Run button
    function runOn(e) { state.input.run = true; runBtn.classList.add('active'); e.preventDefault(); }
    function runOff(e) { state.input.run = false; runBtn.classList.remove('active'); if (e) e.preventDefault(); }
    runBtn.addEventListener('touchstart', runOn, { passive: false });
    runBtn.addEventListener('touchend', runOff);
    runBtn.addEventListener('touchcancel', runOff);
    runBtn.addEventListener('mousedown', runOn);
    window.addEventListener('mouseup', function () { if (state.input.run) runOff(); });
  }

  function updateDesktopInput() {
    if (isMobile) return;
    var f = 0, r = 0;
    if (state.keys['w'] || state.keys['ц']) f += 1;
    if (state.keys['s'] || state.keys['ы']) f -= 1;
    if (state.keys['a'] || state.keys['ф']) r -= 1;
    if (state.keys['d'] || state.keys['в']) r += 1;
    state.input.fwd = f;
    state.input.right = r;
    state.input.run = !!state.keys['shift'];
  }

  /* ================== GAME LOOP ================== */
  function updateLocal(dt) {
    var mx = state.input.right;
    var mz = state.input.fwd;
    var len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0.15) {
      var speed = state.input.run ? 7.5 : 3.6;
      var angle = state.cameraYaw;
      var fX = Math.sin(angle);
      var fZ = Math.cos(angle);
      var rX = Math.cos(angle);
      var rZ = -Math.sin(angle);
      var dx = fX * mz + rX * mx;
      var dz = fZ * mz + rZ * mx;
      var dl = Math.sqrt(dx * dx + dz * dz);
      if (dl > 0) { dx /= dl; dz /= dl; }
      var nx = state.local.x + dx * speed * dt;
      var nz = state.local.z + dz * speed * dt;
      var res = resolveCollision(nx, nz, state.local.x, state.local.z);
      state.local.x = res.x;
      state.local.z = res.z;

      var targetRy = Math.atan2(dx, dz);
      var diff = targetRy - state.local.ry;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      state.local.ry += diff * Math.min(1, dt * 14);

      state.local.moving = true;
      state.local.running = state.input.run;
    } else {
      state.local.moving = false;
      state.local.running = false;
    }
  }

  function updateCamera(dt) {
    var cam = state.camera;
    var target = new BABYLON.Vector3(
      state.local.x,
      state.local.y + 1.4,
      state.local.z
    );
    var smooth = Math.min(1, dt * 10);
    cam.target = BABYLON.Vector3.Lerp(cam.target, target, smooth);
    cam.alpha = -state.cameraYaw - Math.PI / 2;
    cam.beta = state.cameraBeta;
    cam.radius = state.cameraDist;

    // Camera wall clamp
    var pos = cam.position;
    var lim = HALF - 0.3;
    if (pos.x > lim || pos.x < -lim || pos.z > lim || pos.z < -lim) {
      var cl = Math.max(-lim, Math.min(lim, pos.x));
      var cz = Math.max(-lim, Math.min(lim, pos.z));
      cam.setPosition(new BABYLON.Vector3(cl, Math.max(0.5, pos.y), cz));
    }
  }

  function updateRemotePlayers(dt) {
    var smooth = Math.min(1, dt * 10);
    state.players.forEach(function (ch, id) {
      if (id === state.selfId) return;
      ch.current.x += (ch.target.x - ch.current.x) * smooth;
      ch.current.y += (ch.target.y - ch.current.y) * smooth;
      ch.current.z += (ch.target.z - ch.current.z) * smooth;
      var dr = ch.target.ry - ch.current.ry;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      ch.current.ry += dr * smooth;
      ch.root.position.set(ch.current.x, ch.current.y, ch.current.z);
      ch.root.rotation.y = ch.current.ry;
      animateCharacter(ch, dt);
    });

    // Local character
    var local = state.players.get(state.selfId);
    if (local) {
      local.root.position.set(state.local.x, state.local.y, state.local.z);
      local.root.rotation.y = state.local.ry;
      local.moving = state.local.moving;
      local.running = state.local.running;
      animateCharacter(local, dt);
    }
  }

  function sendPosition() {
    if (!state.connected || !state.selfId) return;
    var now = performance.now();
    if (now - state.lastSent < 50) return;
    state.lastSent = now;
    send({
      type: 'playerMoved',
      x: state.local.x,
      y: state.local.y,
      z: state.local.z,
      ry: state.local.ry,
      moving: state.local.moving,
      running: state.local.running
    });
  }

  /* ================== MAIN ================== */
  var engine, scene;

  function startGame() {
    menuEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
    if (isMobile) joystickEl.classList.remove('hidden');
    state.inGame = true;

    if (!state.engine) {
      engine = initScene();
      scene = state.scene;

      engine.runRenderLoop(function () {
        var dt = engine.getDeltaTime() / 1000;
        if (dt > 0.1) dt = 0.1;

        updateDesktopInput();
        updateLocal(dt);
        updateRemotePlayers(dt);
        updateCamera(dt);
        sendPosition();

        scene.render();
      });
    }
  }

  function backToMenu() {
    // Dispose scene
    if (state.engine) {
      try { state.engine.stopRenderLoop(); } catch (e) {}
    }
    if (state.scene) {
      try { state.scene.dispose(); } catch (e) {}
    }
    state.engine = null;
    state.scene = null;
    state.camera = null;
    state.players.clear();
    state.selfId = null;
    state.roomCode = null;
    state.inGame = false;
    state.reconnect.active = false;

    if (document.pointerLockElement === canvas) {
      try { document.exitPointerLock(); } catch (e) {}
    }
    hudEl.classList.add('hidden');
    joystickEl.classList.add('hidden');
    menuEl.classList.remove('hidden');
    setStatus('');
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.close(); } catch (e) {}
    }
    state.ws = null;
  }

  function doCreate() {
    var name = (nameInput.value || '').trim();
    if (name.length < 1) { menuStatus.textContent = 'Введите имя'; return; }
    if (name.length > 20) { menuStatus.textContent = 'Имя слишком длинное'; return; }
    state.playerName = name;
    menuStatus.textContent = 'Создание комнаты...';
    connectWS(function () {
      send({ type: 'createRoom', name: name });
      menuStatus.textContent = '';
      startGame();
    });
  }

  function doJoin() {
    var name = (nameInput.value || '').trim();
    var code = (codeInput.value || '').trim().toUpperCase();
    if (name.length < 1) { menuStatus.textContent = 'Введите имя'; return; }
    if (!/^[A-Z0-9]{6}$/.test(code)) { menuStatus.textContent = 'Код должен быть 6 символов'; return; }
    state.playerName = name;
    menuStatus.textContent = 'Подключение...';
    connectWS(function () {
      send({ type: 'joinRoom', name: name, code: code });
      menuStatus.textContent = '';
      startGame();
    });
  }

  createBtn.addEventListener('click', doCreate);
  joinBtn.addEventListener('click', doJoin);
  codeInput.addEventListener('input', function () {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doCreate();
  });
  codeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doJoin();
  });

  copyBtn.addEventListener('click', function () {
    if (!state.roomCode) return;
    var text = state.roomCode;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        notify('Код скопирован: ' + text, '#6ee7a8');
      }).catch(function () {
        notify('Код: ' + text, '#7ab8ff');
      });
    } else {
      notify('Код: ' + text, '#7ab8ff');
    }
  });

  exitBtn.addEventListener('click', function () {
    backToMenu();
  });

  setupDesktopInput();
  if (isMobile) setupMobileInput();

  // Prevent page scroll / pinch
  document.addEventListener('touchmove', function (e) {
    if (e.target && e.target.closest && e.target.closest('#menu')) return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  // Save name
  try {
    var saved = localStorage.getItem('mpg_name');
    if (saved) nameInput.value = saved;
  } catch (e) {}
  nameInput.addEventListener('change', function () {
    try { localStorage.setItem('mpg_name', nameInput.value); } catch (e) {}
  });

  setStatus('Готово', 'ok');
})();
</script>
</body>
</html>`;

/* ============================== START ============================== */
server.listen(PORT, () => {
  console.log('Server listening on port ' + PORT);
});
