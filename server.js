'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 10;
const ROOM_HALF = 14;                 // серверный предел координат (комната 30x30)
const MAX_MSG_BYTES = 4096;           // защита от больших сообщений

// ---------- HTTP + WS ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

// ---------- Rooms ----------
const rooms = new Map(); // code -> { code, players: Map<id, player>, createdAt }

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e84393', '#00cec9', '#6c5ce7'
];

function makeRoomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function makePlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const t = name.replace(/[<>"']/g, '').trim().slice(0, 16);
  return t.length >= 1 ? t : null;
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    walking: p.walking, running: p.running
  };
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const [id, p] of room.players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) {
      try { p.ws.send(data); } catch (e) { /* ignore */ }
    }
  }
}

function roomStateMsg(room) {
  const players = [];
  for (const p of room.players.values()) players.push(publicPlayer(p));
  return { type: 'roomState', code: room.code, players };
}

function addPlayerToRoom(ws, room, name) {
  const id = makePlayerId();
  const used = new Set();
  for (const p of room.players.values()) used.add(p.color);
  let color = COLORS.find(c => !used.has(c));
  if (!color) color = COLORS[Math.floor(Math.random() * COLORS.length)];

  const a = Math.random() * Math.PI * 2;
  const r = 2 + Math.random() * 3;
  const player = {
    id, name, color, ws,
    x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r,
    ry: 0, walking: false, running: false,
    lastUpdate: Date.now()
  };
  ws.playerId = id;
  ws.roomCode = room.code;
  room.players.set(id, player);
  return player;
}

function removeWsFromRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  const id = ws.playerId;
  ws.roomCode = null;
  ws.playerId = null;
  if (!room || !id) return;
  if (!room.players.has(id)) return;
  room.players.delete(id);
  broadcast(room, { type: 'playerLeft', id });
  if (room.players.size === 0) rooms.delete(code);
}

// ---------- WS ----------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomCode = null;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // ограничение частоты сообщений: не более 100/сек с одного клиента
    const now = Date.now();
    if (now - ws.msgWindow > 1000) { ws.msgWindow = now; ws.msgCount = 0; }
    ws.msgCount++;
    if (ws.msgCount > 100) return;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'createRoom') {
      if (ws.roomCode) { sendJson(ws, { type: 'error', message: 'Вы уже в комнате' }); return; }
      const name = sanitizeName(msg.name);
      if (!name) { sendJson(ws, { type: 'error', message: 'Введите имя (1–16 символов)' }); return; }
      const code = makeRoomCode();
      const room = { code, players: new Map(), createdAt: Date.now() };
      rooms.set(code, room);
      addPlayerToRoom(ws, room, name);
      sendJson(ws, { type: 'roomJoined', code: room.code, you: ws.playerId });
      sendJson(ws, roomStateMsg(room));
    }
    else if (msg.type === 'joinRoom') {
      if (ws.roomCode) { sendJson(ws, { type: 'error', message: 'Вы уже в комнате' }); return; }
      const name = sanitizeName(msg.name);
      if (!name) { sendJson(ws, { type: 'error', message: 'Введите имя (1–16 символов)' }); return; }
      const code = String(msg.code || '').toUpperCase().trim();
      if (!/^[A-F0-9]{6}$/.test(code)) { sendJson(ws, { type: 'error', message: 'Неверный формат кода' }); return; }
      const room = rooms.get(code);
      if (!room) { sendJson(ws, { type: 'error', message: 'Комната не найдена' }); return; }
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) { sendJson(ws, { type: 'error', message: 'Комната переполнена' }); return; }
      const player = addPlayerToRoom(ws, room, name);
      sendJson(ws, { type: 'roomJoined', code: room.code, you: ws.playerId });
      sendJson(ws, roomStateMsg(room));
      broadcast(room, { type: 'playerJoined', player: publicPlayer(player) }, ws.playerId);
    }
    else if (msg.type === 'playerMoved') {
      if (!ws.roomCode) return;
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const p = room.players.get(ws.playerId);
      if (!p) return;
      const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z), ry = Number(msg.ry);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(ry)) return;
      p.x = clamp(x, -ROOM_HALF, ROOM_HALF);
      p.y = clamp(y, 0, 6);
      p.z = clamp(z, -ROOM_HALF, ROOM_HALF);
      p.ry = ry;
      p.walking = !!msg.walking;
      p.running = !!msg.running;
      p.lastUpdate = Date.now();
      broadcast(room, {
        type: 'playerMoved', id: p.id,
        x: p.x, y: p.y, z: p.z, ry: p.ry,
        walking: p.walking, running: p.running
      }, p.id);
    }
    else if (msg.type === 'leaveRoom') {
      removeWsFromRoom(ws);
    }
    else if (msg.type === 'ping') {
      sendJson(ws, { type: 'pong', t: msg.t });
    }
  });

  ws.on('close', () => removeWsFromRoom(ws));
  ws.on('error', () => removeWsFromRoom(ws));
});

// heartbeat — чистим мёртвые соединения
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

// ---------- HTML клиент ----------
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0a0a12">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>3D Multiplayer Room</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html, body {
    width:100%; height:100%; overflow:hidden; background:#0a0a12; color:#fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    touch-action:none; overscroll-behavior:none;
    user-select:none; -webkit-user-select:none;
  }
  #renderCanvas {
    position:fixed; inset:0; width:100%; height:100%;
    display:block; outline:none; touch-action:none;
  }

  /* ---------- MENU ---------- */
  #menu {
    position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    background: radial-gradient(circle at 50% 30%, #1a1a2e 0%, #0a0a12 70%);
    z-index:20; padding:16px;
  }
  .panel {
    width:100%; max-width:380px; background:rgba(20,20,35,0.85);
    border:1px solid rgba(120,120,255,0.18); border-radius:20px;
    padding:26px 22px; backdrop-filter: blur(20px);
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .panel h1 {
    font-size:22px; font-weight:700; text-align:center; margin-bottom:6px;
    background: linear-gradient(135deg,#7c8bff,#a86bff);
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
  }
  .panel p.sub { text-align:center; font-size:12px; color:#8a8aa0; margin-bottom:20px; }
  label { display:block; font-size:12px; color:#9a9ab5; margin-bottom:6px; letter-spacing:0.3px; }
  input {
    width:100%; padding:12px 14px; border-radius:12px;
    border:1px solid rgba(120,120,255,0.25); background:rgba(0,0,0,0.35);
    color:#fff; font-size:15px; outline:none; margin-bottom:12px;
    transition: border-color .2s;
  }
  input:focus { border-color:#7c8bff; }
  button {
    width:100%; padding:13px 16px; border-radius:12px; border:none;
    font-size:15px; font-weight:600; cursor:pointer; color:#fff;
    background: linear-gradient(135deg,#5b6cff,#9b5bff);
    transition: transform .1s, filter .2s; margin-bottom:10px;
  }
  button:active { transform: scale(0.98); }
  button.secondary {
    background: rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15);
  }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  #statusLine {
    display:flex; align-items:center; gap:8px; justify-content:center;
    font-size:12px; color:#8a8aa0; margin-top:8px;
  }
  #statusDot {
    width:8px; height:8px; border-radius:50%; background:#f39c12;
    box-shadow: 0 0 8px #f39c12;
  }
  #statusDot.on { background:#2ecc71; box-shadow: 0 0 8px #2ecc71; }
  #statusDot.off { background:#e74c3c; box-shadow: 0 0 8px #e74c3c; }
  #errorMsg {
    color:#ff7676; font-size:13px; text-align:center; margin-top:10px; min-height:16px;
  }

  /* ---------- HUD ---------- */
  #hud { position:fixed; inset:0; pointer-events:none; z-index:10; display:none; }
  #hud.active { display:block; }

  #roomInfo {
    position:absolute; top:12px; left:12px;
    background:rgba(15,15,28,0.75); border:1px solid rgba(120,120,255,0.22);
    border-radius:14px; padding:10px 12px; backdrop-filter: blur(12px);
    pointer-events:auto; max-width: 70vw;
  }
  #roomInfo .row { display:flex; align-items:center; gap:8px; }
  #roomCode {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size:18px; font-weight:700; letter-spacing:3px; color:#a8b3ff;
  }
  #copyBtn {
    width:auto; padding:6px 10px; font-size:12px; margin:0; border-radius:8px;
    background: rgba(120,120,255,0.2); border:1px solid rgba(120,120,255,0.35);
  }
  #roomInfo .me { font-size:12px; color:#9a9ab5; margin-top:6px; }
  #roomInfo .me span { color:#fff; font-weight:600; }

  #playersPanel {
    position:absolute; top:12px; right:12px;
    background:rgba(15,15,28,0.75); border:1px solid rgba(120,120,255,0.22);
    border-radius:14px; padding:10px 12px; backdrop-filter: blur(12px);
    min-width:140px; pointer-events:auto; max-height: 40vh; overflow:auto;
  }
  #playersPanel .title { font-size:11px; color:#8a8aa0; letter-spacing:1px; margin-bottom:6px; }
  #playersPanel .p { display:flex; align-items:center; gap:6px; font-size:13px; padding:3px 0; }
  #playersPanel .dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }

  #exitBtn {
    position:absolute; bottom:14px; right:14px;
    width:auto; padding:10px 16px; font-size:13px; margin:0;
    background: rgba(231,76,60,0.25); border:1px solid rgba(231,76,60,0.5);
    pointer-events:auto; border-radius:12px;
  }

  #netStatus {
    position:absolute; top:12px; left:50%; transform:translateX(-50%);
    background: rgba(231,76,60,0.85); color:#fff; font-size:12px;
    padding:6px 12px; border-radius:20px; display:none;
  }
  #netStatus.show { display:block; }

  #toast {
    position:absolute; top: 70px; left:50%; transform:translateX(-50%);
    background:rgba(20,20,35,0.9); border:1px solid rgba(120,120,255,0.3);
    color:#fff; font-size:13px; padding:8px 14px; border-radius:20px;
    opacity:0; transition: opacity .3s; pointer-events:none;
  }
  #toast.show { opacity:1; }

  /* ---------- MOBILE CONTROLS ---------- */
  #joystick {
    position:absolute; left:24px; bottom:24px;
    width:120px; height:120px; border-radius:50%;
    background: rgba(120,120,255,0.12); border:2px solid rgba(120,120,255,0.3);
    pointer-events:auto; touch-action:none; display:none;
  }
  #joystick.active { display:block; }
  #joystickKnob {
    position:absolute; left:50%; top:50%; width:52px; height:52px;
    margin-left:-26px; margin-top:-26px; border-radius:50%;
    background: rgba(160,170,255,0.55);
    box-shadow: 0 0 20px rgba(120,120,255,0.6);
    transition: background .15s;
  }
  #runBtn {
    position:absolute; right:24px; bottom:34px;
    width:80px; height:80px; border-radius:50%;
    background: rgba(255,180,80,0.25); border:2px solid rgba(255,180,80,0.5);
    color:#ffd18a; font-size:12px; font-weight:700;
    display:none; pointer-events:auto; touch-action:none;
    align-items:center; justify-content:center;
    width:auto; padding:0; margin:0;
  }
  #runBtn.active { display:flex; }
  #runBtn.on { background: rgba(255,180,80,0.55); }

  @media (max-width: 640px) {
    #playersPanel { font-size:12px; min-width:110px; padding:8px 10px; }
    #roomInfo { padding:8px 10px; }
    #roomCode { font-size:15px; letter-spacing:2px; }
  }
</style>
</head>
<body>
<canvas id="renderCanvas"></canvas>

<!-- MENU -->
<div id="menu">
  <div class="panel">
    <h1>3D Multiplayer Room</h1>
    <p class="sub">Онлайн-комната в реальном времени</p>
    <label for="nameInput">Ваше имя</label>
    <input id="nameInput" maxlength="16" placeholder="Игрок" autocomplete="off">
    <button id="createBtn">Создать комнату</button>
    <label for="codeInput" style="margin-top:8px;">Код комнаты</label>
    <input id="codeInput" maxlength="6" placeholder="ABC123" autocomplete="off" style="text-transform:uppercase; letter-spacing:4px; text-align:center; font-family: monospace;">
    <button id="joinBtn" class="secondary">Войти по коду</button>
    <div id="statusLine"><span id="statusDot"></span><span id="statusText">Подключение…</span></div>
    <div id="errorMsg"></div>
  </div>
</div>

<!-- HUD -->
<div id="hud">
  <div id="roomInfo">
    <div class="row">
      <div id="roomCode">------</div>
      <button id="copyBtn">Копировать</button>
    </div>
    <div class="me">Вы: <span id="meName">—</span></div>
  </div>
  <div id="playersPanel">
    <div class="title">ИГРОКИ</div>
    <div id="playersList"></div>
  </div>
  <button id="exitBtn">Выйти</button>
  <div id="netStatus">Соединение потеряно. Переподключение…</div>
  <div id="toast"></div>

  <div id="joystick"><div id="joystickKnob"></div></div>
  <button id="runBtn">БЕГ</button>
</div>

<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script>
(function () {
  'use strict';

  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
                 (('ontouchstart' in window) && window.innerWidth < 900);

  // ============ CONFIG ============
  var ROOM_HALF = 14;
  var WALK_SPEED = 4.2;
  var RUN_SPEED = 7.5;
  var SEND_INTERVAL = 1000 / 15; // 15 Гц
  var GRAVITY = -18;
  var JUMP_V = 6.5;

  // ============ STATE ============
  var state = {
    ws: null,
    connected: false,
    myId: null,
    roomCode: null,
    myName: '',
    players: {},        // id -> playerObj
    reconnectAttempts: 0,
    reconnectTimer: null,
    intentionalLeave: false,
    sendAccum: 0
  };

  // ============ BABYLON ============
  var canvas = document.getElementById('renderCanvas');
  var engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: !isMobile,
    powerPreference: 'high-performance'
  });
  var scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.05, 0.09, 1);
  scene.collisionsEnabled = true;
  scene.blockMaterialDirtyMechanism = true;

  // ---------- CAMERA ----------
  var camera = new BABYLON.ArcRotateCamera(
    'cam', -Math.PI / 2, Math.PI / 2.6, 6.5,
    new BABYLON.Vector3(0, 1.3, 0), scene
  );
  camera.lowerRadiusLimit = 1.8;
  camera.upperRadiusLimit = 9;
  camera.lowerBetaLimit = 0.25;
  camera.upperBetaLimit = Math.PI / 2 - 0.03;
  camera.wheelPrecision = 25;
  camera.panningSensibility = 0;
  camera.checkCollisions = false;
  camera.minZ = 0.1;

  // ============ BUILD ROOM ============
  buildRoom(scene);

  function mkMat(name, col, spec) {
    var m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = col;
    if (spec) m.specularColor = spec; else m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    return m;
  }

  function collider(mesh) {
    mesh.checkCollisions = true;
    mesh.metadata = mesh.metadata || {};
    mesh.metadata.isRoom = true;
    return mesh;
  }

  function buildRoom(scene) {
    var W = 30, H = 5, D = 30;
    var half = W / 2;

    // ---- FLOOR ----
    var floorMat = mkMat('floorMat', new BABYLON.Color3(0.18, 0.14, 0.11));
    var floor = BABYLON.MeshBuilder.CreateBox('floor', { width: W, height: 0.4, depth: D }, scene);
    floor.position.y = -0.2;
    floor.material = floorMat;
    collider(floor);
    floor.receiveShadows = true;

    // floor pattern (a big rug)
    var rugMat = mkMat('rugMat', new BABYLON.Color3(0.28, 0.22, 0.45));
    var rug = BABYLON.MeshBuilder.CreateBox('rug', { width: 8, height: 0.03, depth: 6 }, scene);
    rug.position.y = 0.015;
    rug.material = rugMat;
    rug.receiveShadows = true;

    // ---- CEILING ----
    var ceilMat = mkMat('ceilMat', new BABYLON.Color3(0.92, 0.92, 0.95));
    var ceil = BABYLON.MeshBuilder.CreateBox('ceil', { width: W, height: 0.3, depth: D }, scene);
    ceil.position.y = H + 0.15;
    ceil.material = ceilMat;

    // ---- WALLS ----
    var wallMat = mkMat('wallMat', new BABYLON.Color3(0.82, 0.80, 0.76));
    var wallThickness = 0.3;

    var wallN = BABYLON.MeshBuilder.CreateBox('wallN', { width: W, height: H, depth: wallThickness }, scene);
    wallN.position.set(0, H / 2, -half);
    wallN.material = wallMat; collider(wallN); wallN.receiveShadows = true;

    var wallS = wallN.clone('wallS');
    wallS.position.set(0, H / 2, half);
    collider(wallS); wallS.receiveShadows = true;

    var wallE = BABYLON.MeshBuilder.CreateBox('wallE', { width: wallThickness, height: H, depth: D }, scene);
    wallE.position.set(half, H / 2, 0);
    wallE.material = wallMat; collider(wallE); wallE.receiveShadows = true;

    var wallW = wallE.clone('wallW');
    wallW.position.set(-half, H / 2, 0);
    collider(wallW); wallW.receiveShadows = true;

    // ---- WINDOWS on north wall ----
    var glassMat = new BABYLON.StandardMaterial('glassMat', scene);
    glassMat.diffuseColor = new BABYLON.Color3(0.5, 0.7, 0.95);
    glassMat.emissiveColor = new BABYLON.Color3(0.25, 0.4, 0.6);
    glassMat.alpha = 0.35;
    glassMat.specularColor = new BABYLON.Color3(1, 1, 1);

    var frameMat = mkMat('frameMat', new BABYLON.Color3(0.25, 0.22, 0.2));

    function makeWindow(x, y, z, rotY) {
      var g = BABYLON.MeshBuilder.CreateBox('win', { width: 3, height: 1.8, depth: 0.06 }, scene);
      g.material = glassMat;
      g.position.set(x, y, z);
      g.rotation.y = rotY;
      var fr = BABYLON.MeshBuilder.CreateBox('winFrame', { width: 3.25, height: 2.05, depth: 0.1 }, scene);
      fr.material = frameMat;
      fr.position.set(x, y, z);
      fr.rotation.y = rotY;
      // make frame look hollow-ish by putting glass in front
      g.position.y += 0.01;
    }
    makeWindow(-6, 3, -half + 0.16, 0);
    makeWindow(6, 3, -half + 0.16, 0);

    // ---- DOOR on south wall ----
    var doorMat = mkMat('doorMat', new BABYLON.Color3(0.35, 0.24, 0.16));
    var door = BABYLON.MeshBuilder.CreateBox('door', { width: 1.4, height: 2.6, depth: 0.12 }, scene);
    door.position.set(0, 1.3, half - 0.2);
    door.material = doorMat;
    var doorFrame = BABYLON.MeshBuilder.CreateBox('doorFrame', { width: 1.6, height: 2.8, depth: 0.2 }, scene);
    doorFrame.material = frameMat;
    doorFrame.position.set(0, 1.4, half - 0.25);
    var handle = BABYLON.MeshBuilder.CreateSphere('handle', { diameter: 0.12 }, scene);
    var handleMat = mkMat('handleMat', new BABYLON.Color3(0.9, 0.78, 0.3));
    handleMat.specularColor = new BABYLON.Color3(1, 1, 1);
    handle.material = handleMat;
    handle.position.set(0.5, 1.25, half - 0.28);

    // ---- SOFA (north side, facing +z) ----
    var sofaMat = mkMat('sofaMat', new BABYLON.Color3(0.20, 0.28, 0.5));
    var sofaDark = mkMat('sofaDark', new BABYLON.Color3(0.14, 0.20, 0.38));

    function makeSofa(cx, cz) {
      var base = BABYLON.MeshBuilder.CreateBox('sofaBase', { width: 3.4, height: 0.55, depth: 1.4 }, scene);
      base.position.set(cx, 0.35, cz);
      base.material = sofaMat; collider(base); base.receiveShadows = true;

      var back = BABYLON.MeshBuilder.CreateBox('sofaBack', { width: 3.4, height: 0.9, depth: 0.3 }, scene);
      back.position.set(cx, 0.9, cz - 0.55);
      back.material = sofaDark; collider(back); back.receiveShadows = true;

      var armL = BABYLON.MeshBuilder.CreateBox('sofaArmL', { width: 0.3, height: 0.65, depth: 1.4 }, scene);
      armL.position.set(cx - 1.55, 0.62, cz);
      armL.material = sofaDark; collider(armL);

      var armR = armL.clone('sofaArmR');
      armR.position.x = cx + 1.55;
      collider(armR);

      var cushY = 0.68;
      for (var i = -1; i <= 1; i++) {
        var c = BABYLON.MeshBuilder.CreateBox('cushion' + i, { width: 0.9, height: 0.16, depth: 1.15 }, scene);
        c.position.set(cx + i * 0.98, cushY, cz + 0.05);
        c.material = sofaMat;
      }
    }
    makeSofa(0, -half + 1.6);

    // ---- COFFEE TABLE ----
    var woodMat = mkMat('woodMat', new BABYLON.Color3(0.42, 0.26, 0.15));
    function makeTable(cx, cz, w, d, h) {
      var top = BABYLON.MeshBuilder.CreateBox('tableTop', { width: w, height: 0.1, depth: d }, scene);
      top.position.set(cx, h, cz);
      top.material = woodMat; collider(top); top.receiveShadows = true;
      var legT = 0.1;
      var legH = h - 0.05;
      var positions = [
        [cx - w/2 + 0.15, cz - d/2 + 0.15],
        [cx + w/2 - 0.15, cz - d/2 + 0.15],
        [cx - w/2 + 0.15, cz + d/2 - 0.15],
        [cx + w/2 - 0.15, cz + d/2 - 0.15]
      ];
      for (var i = 0; i < 4; i++) {
        var leg = BABYLON.MeshBuilder.CreateBox('leg' + i, { width: legT, height: legH, depth: legT }, scene);
        leg.position.set(positions[i][0], legH / 2, positions[i][1]);
        leg.material = woodMat;
      }
    }
    makeTable(0, -half + 4.4, 2.0, 1.2, 0.45);

    // ---- TV stand + TV (south) ----
    var tvStand = BABYLON.MeshBuilder.CreateBox('tvStand', { width: 2.6, height: 0.5, depth: 0.6 }, scene);
    tvStand.position.set(0, 0.25, half - 1.1);
    tvStand.material = woodMat; collider(tvStand); tvStand.receiveShadows = true;

    var tvBody = BABYLON.MeshBuilder.CreateBox('tvBody', { width: 2.2, height: 1.3, depth: 0.08 }, scene);
    tvBody.position.set(0, 1.25, half - 1.1);
    var tvMat = mkMat('tvMat', new BABYLON.Color3(0.05, 0.05, 0.07));
    tvBody.material = tvMat;
    var screenMat = new BABYLON.StandardMaterial('screenMat', scene);
    screenMat.diffuseColor = new BABYLON.Color3(0.05, 0.1, 0.2);
    screenMat.emissiveColor = new BABYLON.Color3(0.1, 0.35, 0.55);
    var screen = BABYLON.MeshBuilder.CreatePlane('screen', { width: 2.0, height: 1.1 }, scene);
    screen.material = screenMat;
    screen.position.set(0, 1.25, half - 1.15);
    screen.rotation.y = Math.PI;

    // ---- DINING TABLE + CHAIRS (east side) ----
    var dtCX = 8, dtCZ = 6;
    makeTable(dtCX, dtCZ, 2.6, 1.6, 0.75);

    var chairMat = mkMat('chairMat', new BABYLON.Color3(0.30, 0.20, 0.15));
    function makeChair(cx, cz, ry) {
      var seat = BABYLON.MeshBuilder.CreateBox('chairSeat', { width: 0.5, height: 0.08, depth: 0.5 }, scene);
      seat.position.set(cx, 0.45, cz);
      seat.rotation.y = ry;
      seat.material = chairMat; collider(seat);
      var back = BABYLON.MeshBuilder.CreateBox('chairBack', { width: 0.5, height: 0.55, depth: 0.07 }, scene);
      back.position.set(
        cx + Math.sin(ry) * 0.24,
        0.75,
        cz + Math.cos(ry) * 0.24
      );
      back.rotation.y = ry;
      back.material = chairMat; collider(back);
      for (var i = -1; i <= 1; i += 2) {
        for (var j = -1; j <= 1; j += 2) {
          var lx = cx + i * 0.2, lz = cz + j * 0.2;
          var leg = BABYLON.MeshBuilder.CreateBox('chairLeg', { width: 0.06, height: 0.44, depth: 0.06 }, scene);
          leg.position.set(lx, 0.22, lz);
          leg.material = chairMat;
        }
      }
    }
    makeChair(dtCX - 1.4, dtCZ - 1.2, -Math.PI / 4);
    makeChair(dtCX + 1.4, dtCZ - 1.2, Math.PI / 4);
    makeChair(dtCX - 1.4, dtCZ + 1.2, -Math.PI * 3 / 4);
    makeChair(dtCX + 1.4, dtCZ + 1.2, Math.PI * 3 / 4);

    // ---- BOOKSHELF (west wall) ----
    var shelfMat = mkMat('shelfMat', new BABYLON.Color3(0.32, 0.20, 0.13));
    var shelfBody = BABYLON.MeshBuilder.CreateBox('shelfBody', { width: 0.6, height: 2.4, depth: 3.2 }, scene);
    shelfBody.position.set(-half + 0.4, 1.2, -2);
    shelfBody.material = shelfMat; collider(shelfBody);

    var bookColors = [
      new BABYLON.Color3(0.85, 0.3, 0.3),
      new BABYLON.Color3(0.3, 0.6, 0.9),
      new BABYLON.Color3(0.9, 0.75, 0.3),
      new BABYLON.Color3(0.4, 0.8, 0.5),
      new BABYLON.Color3(0.7, 0.4, 0.8)
    ];
    for (var s = 0; s < 4; s++) {
      var y = 0.4 + s * 0.55;
      for (var b = 0; b < 10; b++) {
        var bw = 0.14 + Math.random() * 0.06;
        var book = BABYLON.MeshBuilder.CreateBox('book', { width: 0.35, height: 0.38, depth: bw }, scene);
        book.position.set(-half + 0.45, y + 0.19, -3.4 + b * 0.3 + Math.random() * 0.05);
        var bm = mkMat('bookMat', bookColors[(s + b) % bookColors.length]);
        book.material = bm;
      }
    }

    // ---- PLANT in the corner ----
    function makePlant(cx, cz) {
      var potMat = mkMat('potMat', new BABYLON.Color3(0.5, 0.25, 0.15));
      var pot = BABYLON.MeshBuilder.CreateCylinder('pot', { diameterTop: 0.55, diameterBottom: 0.4, height: 0.55 }, scene);
      pot.position.set(cx, 0.275, cz);
      pot.material = potMat; collider(pot);
      var leafMat = mkMat('leafMat', new BABYLON.Color3(0.2, 0.55, 0.25));
      for (var i = 0; i < 7; i++) {
        var leaf = BABYLON.MeshBuilder.CreateSphere('leaf', { diameter: 0.5, segments: 6 }, scene);
        leaf.scaling = new BABYLON.Vector3(0.6, 0.4, 0.9);
        var ang = (i / 7) * Math.PI * 2;
        leaf.position.set(cx + Math.cos(ang) * 0.22, 0.85 + Math.random() * 0.3, cz + Math.sin(ang) * 0.22);
        leaf.material = leafMat;
      }
      var stem = BABYLON.MeshBuilder.CreateCylinder('stem', { diameter: 0.06, height: 0.7 }, scene);
      stem.position.set(cx, 0.85, cz);
      stem.material = leafMat;
    }
    makePlant(-half + 1.2, half - 1.2);
    makePlant(half - 1.2, -half + 1.2);

    // ---- PICTURE on east wall ----
    var picFrame = BABYLON.MeshBuilder.CreateBox('picFrame', { width: 0.1, height: 1.2, depth: 1.8 }, scene);
    picFrame.position.set(half - 0.15, 2.6, -4);
    picFrame.material = frameMat;
    var picCanvasMat = new BABYLON.StandardMaterial('picCanvasMat', scene);
    picCanvasMat.diffuseColor = new BABYLON.Color3(0.3, 0.5, 0.7);
    picCanvasMat.emissiveColor = new BABYLON.Color3(0.15, 0.25, 0.35);
    var picCanvas = BABYLON.MeshBuilder.CreatePlane('picCanvas', { width: 1.6, height: 1.0 }, scene);
    picCanvas.material = picCanvasMat;
    picCanvas.position.set(half - 0.22, 2.6, -4);
    picCanvas.rotation.y = -Math.PI / 2;

    // ---- Ceiling lamps ----
    function makeLamp(x, z) {
      var cord = BABYLON.MeshBuilder.CreateCylinder('cord', { diameter: 0.03, height: 0.6 }, scene);
      cord.position.set(x, H - 0.3, z);
      var shadeMat = mkMat('shadeMat', new BABYLON.Color3(0.95, 0.85, 0.6));
      shadeMat.emissiveColor = new BABYLON.Color3(0.4, 0.32, 0.15);
      var shade = BABYLON.MeshBuilder.CreateCylinder('shade', { diameterTop: 0.5, diameterBottom: 0.7, height: 0.3 }, scene);
      shade.position.set(x, H - 0.75, z);
      shade.material = shadeMat;
      var bulb = new BABYLON.PointLight('bulb', new BABYLON.Vector3(x, H - 0.9, z), scene);
      bulb.diffuse = new BABYLON.Color3(1, 0.95, 0.85);
      bulb.intensity = 0.35;
      bulb.range = 12;
    }
    makeLamp(-6, -4);
    makeLamp(6, 4);

    // ---- LIGHTING ----
    var hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    hemi.diffuse = new BABYLON.Color3(0.95, 0.95, 1);
    hemi.groundColor = new BABYLON.Color3(0.25, 0.25, 0.3);

    var dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-1, -2, 1), scene);
    dir.position = new BABYLON.Vector3(12, 15, -12);
    dir.intensity = 0.9;
    dir.diffuse = new BABYLON.Color3(1, 0.96, 0.88);

    // Shadows
    if (!isMobile) {
      try {
        var sg = new BABYLON.ShadowGenerator(1024, dir);
        sg.useBlurExponentialShadowMap = true;
        sg.blurKernel = 16;
        sg.darkness = 0.4;
        var shadowCasters = ['sofaBase','sofaBack','tableTop','tvStand','shelfBody','chairSeat','chairBack','door','rug'];
        scene.meshes.forEach(function (m) {
          if (shadowCasters.indexOf(m.name) !== -1) sg.addShadowCaster(m);
        });
      } catch (e) {}
    }
  }

  // ============ CHARACTER FACTORY ============
  function mkStdMat(name, col) {
    var m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = col;
    m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    return m;
  }

  function makeLabel(text, y) {
    var dt = new BABYLON.DynamicTexture('lbl' + text, { width: 512, height: 128 }, scene, true);
    dt.hasAlpha = true;
    dt.drawText(text, null, 88, 'bold 62px sans-serif', '#ffffff', 'transparent', true);
    var mat = new BABYLON.StandardMaterial('lblMat' + text, scene);
    mat.diffuseTexture = dt;
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.disableLighting = true;
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;
    var plane = BABYLON.MeshBuilder.CreatePlane('lblPlane' + text, { width: 1.5, height: 0.375 }, scene);
    plane.material = mat;
    plane.position.y = y;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    return plane;
  }

  function createCharacter(name, colorHex, isLocal) {
    // Root = невидимый бокс с коллизиями (origin в ступнях)
    var root = BABYLON.MeshBuilder.CreateBox('playerRoot_' + name, { width: 0.6, height: 1.7, depth: 0.5 }, scene);
    root.isVisible = false;
    root.isPickable = false;
    root.checkCollisions = true;
    root.ellipsoid = new BABYLON.Vector3(0.35, 0.85, 0.35);
    root.ellipsoidOffset = new BABYLON.Vector3(0, 0.85, 0);

    var cloth = BABYLON.Color3.FromHexString(colorHex);
    var skin = new BABYLON.Color3(0.95, 0.79, 0.66);
    var pants = new BABYLON.Color3(0.15, 0.16, 0.22);
    var hair = new BABYLON.Color3(0.14, 0.09, 0.06);

    var clothMat = mkStdMat('clothMat_' + name, cloth);
    var skinMat  = mkStdMat('skinMat_' + name, skin);
    var pantsMat = mkStdMat('pantsMat_' + name, pants);
    var hairMat  = mkStdMat('hairMat_' + name, hair);
    var shoeMat  = mkStdMat('shoeMat_' + name, new BABYLON.Color3(0.08, 0.08, 0.1));

    // ----- TORSO -----
    var torso = BABYLON.MeshBuilder.CreateBox('torso_' + name, { width: 0.6, height: 0.72, depth: 0.34 }, scene);
    torso.position.y = 1.16;
    torso.material = clothMat;
    torso.parent = root;
    torso.receiveShadows = true;

    // ----- HIPS -----
    var hips = BABYLON.MeshBuilder.CreateBox('hips_' + name, { width: 0.55, height: 0.22, depth: 0.32 }, scene);
    hips.position.y = 0.72;
    hips.material = pantsMat;
    hips.parent = root;

    // ----- NECK -----
    var neck = BABYLON.MeshBuilder.CreateCylinder('neck_' + name, { diameter: 0.16, height: 0.12 }, scene);
    neck.position.y = 1.55;
    neck.material = skinMat;
    neck.parent = root;

    // ----- HEAD -----
    var head = BABYLON.MeshBuilder.CreateSphere('head_' + name, { diameter: 0.44, segments: 14 }, scene);
    head.position.y = 1.83;
    head.material = skinMat;
    head.parent = root;
    head.receiveShadows = true;

    // ----- HAIR -----
    var hairMesh = BABYLON.MeshBuilder.CreateSphere('hair_' + name, { diameter: 0.47, segments: 14, slice: 0.55 }, scene);
    hairMesh.position.y = 1.87;
    hairMesh.material = hairMat;
    hairMesh.parent = root;

    // ----- EYES -----
    var eyeMat = mkStdMat('eyeMat_' + name, new BABYLON.Color3(0.06, 0.06, 0.09));
    for (var e = -1; e <= 1; e += 2) {
      var eye = BABYLON.MeshBuilder.CreateSphere('eye_' + name, { diameter: 0.07 }, scene);
      eye.position.set(e * 0.09, 1.85, 0.21);
      eye.material = eyeMat;
      eye.parent = root;
    }

    // ----- ARMS -----
    function makeArm(side) {
      var arm = BABYLON.MeshBuilder.CreateBox('arm_' + name, { width: 0.16, height: 0.68, depth: 0.18 }, scene);
      arm.material = clothMat;
      arm.parent = root;
      arm.position.set(side * 0.39, 1.15, 0);
      arm.setPivotPoint(new BABYLON.Vector3(0, 0.34, 0));
      // hand
      var hand = BABYLON.MeshBuilder.CreateSphere('hand_' + name, { diameter: 0.16 }, scene);
      hand.material = skinMat;
      hand.parent = arm;
      hand.position.set(0, -0.4, 0);
      return arm;
    }
    var armL = makeArm(-1);
    var armR = makeArm(1);

    // ----- LEGS -----
    function makeLeg(side) {
      var leg = BABYLON.MeshBuilder.CreateBox('leg_' + name, { width: 0.2, height: 0.72, depth: 0.22 }, scene);
      leg.material = pantsMat;
      leg.parent = root;
      leg.position.set(side * 0.15, 0.37, 0);
      leg.setPivotPoint(new BABYLON.Vector3(0, 0.36, 0));
      // shoe
      var shoe = BABYLON.MeshBuilder.CreateBox('shoe_' + name, { width: 0.22, height: 0.12, depth: 0.32 }, scene);
      shoe.material = shoeMat;
      shoe.parent = leg;
      shoe.position.set(0, -0.4, 0.04);
      return leg;
    }
    var legL = makeLeg(-1);
    var legR = makeLeg(1);

    // ----- LABEL -----
    var label = makeLabel(name, 2.3);
    label.parent = root;

    return {
      root: root,
      parts: { armL: armL, armR: armR, legL: legL, legR: legR },
      walkPhase: 0
    };
  }

  function removeCharacter(pl) {
    if (!pl) return;
    if (pl.char) {
      if (pl.char.root) pl.char.root.dispose(false, true);
    }
  }

  // ============ LOCAL PLAYER ============
  var localPlayer = null;
  var myRoot = null;

  function ensureLocalPlayer() {
    if (myRoot && !myRoot.isDisposed()) return;
    var ch = createCharacter(state.myName, '#7c8bff', true);
    myRoot = ch.root;
    localPlayer = ch;
    myRoot.position.set(0, 0, 0);
  }

  // ============ NETWORK ============
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var errorMsg = document.getElementById('errorMsg');
  var netStatus = document.getElementById('netStatus');
  var toastEl = document.getElementById('toast');

  function setStatus(ok, text) {
    statusDot.className = ok === true ? 'on' : (ok === false ? 'off' : '');
    statusText.textContent = text;
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    setTimeout(function () { errorMsg.textContent = ''; }, 4000);
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  function connectWS() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    setStatus(null, 'Подключение…');
    var ws;
    try { ws = new WebSocket(wsUrl()); }
    catch (e) { setStatus(false, 'Ошибка соединения'); return; }
    state.ws = ws;

    ws.onopen = function () {
      state.connected = true;
      state.reconnectAttempts = 0;
      setStatus(true, 'Подключено');
      netStatus.classList.remove('show');
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    };

    ws.onclose = function () {
      state.connected = false;
      setStatus(false, 'Соединение потеряно');
      if (!state.intentionalLeave && state.roomCode) {
        netStatus.classList.add('show');
        scheduleReconnect();
      }
    };

    ws.onerror = function () {
      setStatus(false, 'Ошибка соединения');
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectAttempts++;
    var delay = Math.min(5000, 600 * Math.pow(1.4, state.reconnectAttempts));
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      if (state.intentionalLeave) return;
      if (state.roomCode && state.myName) {
        // попытка зайти обратно в ту же комнату
        connectWSAndJoin(state.myName, state.roomCode);
      } else {
        connectWS();
      }
    }, delay);
  }

  function connectWSAndJoin(name, code) {
    state.intentionalLeave = false;
    var ws;
    try { ws = new WebSocket(wsUrl()); }
    catch (e) { scheduleReconnect(); return; }
    state.ws = ws;
    ws.onopen = function () {
      state.connected = true;
      state.reconnectAttempts = 0;
      setStatus(true, 'Подключено');
      netStatus.classList.remove('show');
      ws.send(JSON.stringify({ type: 'joinRoom', name: name, code: code }));
    };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    };
    ws.onclose = function () {
      state.connected = false;
      setStatus(false, 'Соединение потеряно');
      if (!state.intentionalLeave) {
        netStatus.classList.add('show');
        scheduleReconnect();
      }
    };
    ws.onerror = function () { setStatus(false, 'Ошибка'); };
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // ============ MESSAGE HANDLERS ============
  function handleMessage(msg) {
    switch (msg.type) {
      case 'roomJoined':
        state.roomCode = msg.code;
        state.myId = msg.you;
        showHUD();
        document.getElementById('roomCode').textContent = msg.code;
        document.getElementById('meName').textContent = state.myName;
        break;

      case 'roomState':
        // удаляем всех, кроме себя
        Object.keys(state.players).forEach(function (id) {
          if (id !== state.myId) {
            removeCharacter(state.players[id]);
            delete state.players[id];
          }
        });
        // ставим себя
        ensureLocalPlayer();
        for (var i = 0; i < msg.players.length; i++) {
          var p = msg.players[i];
          if (p.id === state.myId) {
            myRoot.position.x = p.x;
            myRoot.position.y = p.y;
            myRoot.position.z = p.z;
          } else {
            addRemotePlayer(p);
          }
        }
        updatePlayersList();
        break;

      case 'playerJoined':
        addRemotePlayer(msg.player);
        updatePlayersList();
        toast(msg.player.name + ' присоединился');
        break;

      case 'playerMoved':
        updateRemotePlayer(msg);
        break;

      case 'playerLeft':
        if (state.players[msg.id]) {
          var pl = state.players[msg.id];
          removeCharacter(pl);
          delete state.players[msg.id];
          updatePlayersList();
          toast((pl.name || 'Игрок') + ' вышел');
        }
        break;

      case 'error':
        showError(msg.message);
        if (msg.message.indexOf('Комната не найдена') !== -1 ||
            msg.message.indexOf('переполнена') !== -1 ||
            msg.message.indexOf('формат') !== -1) {
          // возвращаемся в меню
          backToMenu();
        }
        break;

      case 'pong':
        break;
    }
  }

  function addRemotePlayer(p) {
    if (!p || !p.id) return;
    if (state.players[p.id]) {
      updateRemotePlayer(p);
      return;
    }
    var ch = createCharacter(p.name, p.color, false);
    ch.root.position.set(p.x, p.y || 0, p.z);
    ch.root.rotation.y = p.ry || 0;

    state.players[p.id] = {
      id: p.id,
      name: p.name,
      color: p.color,
      char: ch,
      targetX: p.x, targetY: p.y || 0, targetZ: p.z,
      targetRy: p.ry || 0,
      walking: !!p.walking,
      running: !!p.running,
      walkPhase: 0
    };
  }

  function updateRemotePlayer(p) {
    var pl = state.players[p.id];
    if (!pl) return;
    pl.targetX = p.x;
    pl.targetY = p.y || 0;
    pl.targetZ = p.z;
    pl.targetRy = p.ry || 0;
    pl.walking = !!p.walking;
    pl.running = !!p.running;
  }

  function updatePlayersList() {
    var list = document.getElementById('playersList');
    var html = '';
    // себя первым
    html += '<div class="p"><span class="dot" style="background:#7c8bff"></span>' +
            escapeHtml(state.myName) + ' <span style="color:#8a8aa0">(вы)</span></div>';
    Object.keys(state.players).forEach(function (id) {
      var p = state.players[id];
      html += '<div class="p"><span class="dot" style="background:' + p.color + '"></span>' +
              escapeHtml(p.name) + '</div>';
    });
    list.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ============ UI ============
  var menuEl = document.getElementById('menu');
  var hudEl = document.getElementById('hud');
  var nameInput = document.getElementById('nameInput');
  var codeInput = document.getElementById('codeInput');

  // load saved name
  try {
    var savedName = localStorage.getItem('mp_name');
    if (savedName) nameInput.value = savedName;
  } catch (e) {}

  function validateName() {
    var n = nameInput.value.replace(/[<>"']/g, '').trim().slice(0, 16);
    if (!n) { showError('Введите имя'); return null; }
    try { localStorage.setItem('mp_name', n); } catch (e) {}
    return n;
  }

  document.getElementById('createBtn').addEventListener('click', function () {
    var n = validateName();
    if (!n) return;
    state.myName = n;
    state.intentionalLeave = false;
    send({ type: 'createRoom', name: n });
  });

  document.getElementById('joinBtn').addEventListener('click', function () {
    var n = validateName();
    if (!n) return;
    var code = codeInput.value.toUpperCase().trim();
    if (!/^[A-F0-9]{6}$/.test(code)) { showError('Код должен содержать 6 символов (0-9, A-F)'); return; }
    state.myName = n;
    state.intentionalLeave = false;
    send({ type: 'joinRoom', name: n, code: code });
  });

  codeInput.addEventListener('input', function () {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6);
  });

  function showHUD() {
    menuEl.style.display = 'none';
    hudEl.classList.add('active');
    if (isMobile) {
      document.getElementById('joystick').classList.add('active');
      document.getElementById('runBtn').classList.add('active');
    }
  }

  function backToMenu() {
    state.intentionalLeave = true;
    state.roomCode = null;
    state.myId = null;
    // удаляем всех персонажей
    Object.keys(state.players).forEach(function (id) {
      removeCharacter(state.players[id]);
      delete state.players[id];
    });
    if (localPlayer) {
      if (localPlayer.root) localPlayer.root.dispose(false, true);
      localPlayer = null;
      myRoot = null;
    }
    hudEl.classList.remove('active');
    menuEl.style.display = 'flex';
    netStatus.classList.remove('show');
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }

  document.getElementById('exitBtn').addEventListener('click', function () {
    send({ type: 'leaveRoom' });
    backToMenu();
  });

  document.getElementById('copyBtn').addEventListener('click', function () {
    var code = state.roomCode || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () {
        toast('Код скопирован: ' + code);
      }).catch(function () {
        fallbackCopy(code);
      });
    } else {
      fallbackCopy(code);
    }
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Код скопирован: ' + text); }
    catch (e) { toast('Код: ' + text); }
    document.body.removeChild(ta);
  }

  // ============ INPUT: KEYBOARD ============
  var keys = { w: false, a: false, s: false, d: false, shift: false, space: false };

  window.addEventListener('keydown', function (e) {
    if (!hudEl.classList.contains('active')) {
      if (e.key === 'Enter') {
        if (document.activeElement === codeInput) {
          document.getElementById('joinBtn').click();
        } else {
          document.getElementById('createBtn').click();
        }
      }
      return;
    }
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = true; break;
      case 'KeyS': case 'ArrowDown': keys.s = true; break;
      case 'KeyA': case 'ArrowLeft': keys.a = true; break;
      case 'KeyD': case 'ArrowRight': keys.d = true; break;
      case 'ShiftLeft': case 'ShiftRight': keys.shift = true; break;
      case 'Space': keys.space = true; e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', function (e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = false; break;
      case 'KeyS': case 'ArrowDown': keys.s = false; break;
      case 'KeyA': case 'ArrowLeft': keys.a = false; break;
      case 'KeyD': case 'ArrowRight': keys.d = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.shift = false; break;
      case 'Space': keys.space = false; break;
    }
  });

  // ============ INPUT: POINTERS ============
  var joystick = document.getElementById('joystick');
  var joystickKnob = document.getElementById('joystickKnob');
  var runBtn = document.getElementById('runBtn');

  var joystickPointerId = null;
  var joystickCenter = { x: 0, y: 0 };
  var joystickVector = { x: 0, y: 0 };
  var cameraPointerId = null;
  var cameraLast = { x: 0, y: 0 };
  var pointerTypes = {};
  var runPressed = false;

  function rectCenter(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r };
  }

  function pointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  window.addEventListener('pointerdown', function (e) {
    if (!hudEl.classList.contains('active')) return;
    pointerTypes[e.pointerId] = e.pointerType;

    var jr = joystick.getBoundingClientRect();
    var rr = runBtn.getBoundingClientRect();

    // run button
    if (runBtn.classList.contains('active') && pointInRect(e.clientX, e.clientY, rr)) {
      runPressed = true;
      runBtn.classList.add('on');
      e.preventDefault();
      return;
    }

    // joystick zone
    if (isMobile && joystick.classList.contains('active') && joystickPointerId === null) {
      // allow starting from expanded area
      var padX = jr.left - 30, padY = jr.top - 30;
      var padR = jr.right + 30, padB = jr.bottom + 30;
      if (e.clientX >= padX && e.clientX <= padR && e.clientY >= padY && e.clientY <= padB && e.clientX < window.innerWidth * 0.5) {
        joystickPointerId = e.pointerId;
        var c = rectCenter(joystick);
        joystickCenter.x = c.x;
        joystickCenter.y = c.y;
        updateJoystick(e.clientX, e.clientY);
        e.preventDefault();
        return;
      }
    }

    // camera drag (rest of the screen)
    if (cameraPointerId === null) {
      cameraPointerId = e.pointerId;
      cameraLast.x = e.clientX;
      cameraLast.y = e.clientY;
      e.preventDefault();
    }
  }, { passive: false });

  window.addEventListener('pointermove', function (e) {
    if (e.pointerId === joystickPointerId) {
      updateJoystick(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (e.pointerId === cameraPointerId) {
      var dx = e.clientX - cameraLast.x;
      var dy = e.clientY - cameraLast.y;
      cameraLast.x = e.clientX;
      cameraLast.y = e.clientY;
      var sensitivity = pointerTypes[e.pointerId] === 'touch' ? 0.006 : 0.005;
      camera.alpha -= dx * sensitivity;
      camera.beta  -= dy * sensitivity;
      camera.beta = Math.max(camera.lowerBetaLimit, Math.min(camera.upperBetaLimit, camera.beta));
      e.preventDefault();
    }
  }, { passive: false });

  function endPointer(e) {
    if (e.pointerId === joystickPointerId) {
      joystickPointerId = null;
      joystickVector.x = 0;
      joystickVector.y = 0;
      joystickKnob.style.transform = 'translate(0,0)';
    }
    if (e.pointerId === cameraPointerId) {
      cameraPointerId = null;
    }
    if (e.pointerId === runBtn._pid) {
      runPressed = false;
      runBtn.classList.remove('on');
      runBtn._pid = null;
    }
    if (e.pointerId === runBtn._pid2) {
      runPressed = false;
      runBtn.classList.remove('on');
      runBtn._pid2 = null;
    }
    delete pointerTypes[e.pointerId];
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // run button handlers
  runBtn.addEventListener('pointerdown', function (e) {
    runPressed = true;
    runBtn.classList.add('on');
    runBtn._pid = e.pointerId;
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  runBtn.addEventListener('pointerup', function (e) {
    runPressed = false;
    runBtn.classList.remove('on');
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  runBtn.addEventListener('pointercancel', function () {
    runPressed = false;
    runBtn.classList.remove('on');
  });

  function updateJoystick(x, y) {
    var dx = x - joystickCenter.x;
    var dy = y - joystickCenter.y;
    var maxR = 46;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > maxR) { dx = dx / len * maxR; dy = dy / len * maxR; len = maxR; }
    joystickKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    joystickVector.x = dx / maxR;
    joystickVector.y = dy / maxR;
  }

  // prevent context menu / scroll
  window.addEventListener('contextmenu', function (e) {
    if (hudEl.classList.contains('active')) e.preventDefault();
  });
  document.addEventListener('touchmove', function (e) {
    if (hudEl.classList.contains('active')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  // ============ UPDATE LOOP ============
  var lastTime = performance.now();
  var velY = 0;
  var onGround = true;

  scene.registerBeforeRender(function () {
    var now = performance.now();
    var dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (!myRoot || !hudEl.classList.contains('active')) return;

    // ---- input vector ----
    var ix = 0, iz = 0;
    if (keys.w) iz += 1;
    if (keys.s) iz -= 1;
    if (keys.a) ix -= 1;
    if (keys.d) ix += 1;
    ix += joystickVector.x;
    iz -= joystickVector.y;
    var mag = Math.sqrt(ix * ix + iz * iz);
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }

    var running = keys.shift || runPressed;
    var speed = running ? RUN_SPEED : WALK_SPEED;

    // camera-relative movement
    var camDir = camera.getForwardRay().direction;
    camDir.y = 0;
    camDir.normalize();
    var camRight = new BABYLON.Vector3(camDir.z, 0, -camDir.x);

    var moveX = (camDir.x * iz + camRight.x * ix) * speed * dt;
    var moveZ = (camDir.z * iz + camRight.z * ix) * speed * dt;

    // jump / gravity
    if (keys.space && onGround) {
      velY = JUMP_V;
      onGround = false;
    }
    velY += GRAVITY * dt;
    var moveY = velY * dt;

    var disp = new BABYLON.Vector3(moveX, moveY, moveZ);
    myRoot.moveWithCollisions(disp);

    // ground clamp
    if (myRoot.position.y < 0) {
      myRoot.position.y = 0;
      velY = 0;
      onGround = true;
    }
    // server bounds
    if (myRoot.position.x > ROOM_HALF) myRoot.position.x = ROOM_HALF;
    if (myRoot.position.x < -ROOM_HALF) myRoot.position.x = -ROOM_HALF;
    if (myRoot.position.z > ROOM_HALF) myRoot.position.z = ROOM_HALF;
    if (myRoot.position.z < -ROOM_HALF) myRoot.position.z = -ROOM_HALF;

    // ---- rotate to move direction ----
    var targetRy = myRoot.rotation.y;
    if (mag > 0.05) {
      targetRy = Math.atan2(moveX, moveZ);
    }
    var ryDiff = targetRy - myRoot.rotation.y;
    while (ryDiff > Math.PI) ryDiff -= Math.PI * 2;
    while (ryDiff < -Math.PI) ryDiff += Math.PI * 2;
    myRoot.rotation.y += ryDiff * Math.min(1, dt * 12);

    // ---- character animation (local) ----
    animateChar(localPlayer, mag > 0.05, running, dt);

    // ---- camera follow ----
    var tgt = new BABYLON.Vector3(
      myRoot.position.x,
      myRoot.position.y + 1.35,
      myRoot.position.z
    );
    camera.target.x += (tgt.x - camera.target.x) * Math.min(1, dt * 10);
    camera.target.y += (tgt.y - camera.target.y) * Math.min(1, dt * 10);
    camera.target.z += (tgt.z - camera.target.z) * Math.min(1, dt * 10);

    // camera collision: pull in if wall between target and camera
    var camPos = camera.position;
    var dirToCam = camPos.subtract(camera.target);
    var dist = dirToCam.length();
    if (dist > 0.01) {
      dirToCam.normalize();
      var ray = new BABYLON.Ray(camera.target, dirToCam, dist);
      var hit = scene.pickWithRay(ray, function (m) {
        return m.isPickable && m.checkCollisions && m.name !== 'floor' && m !== myRoot;
      });
      if (hit && hit.hit && hit.distance < dist) {
        camera.radius = Math.max(camera.lowerRadiusLimit, hit.distance - 0.35);
      } else if (camera.radius < camera.upperRadiusLimit) {
        camera.radius = Math.min(camera.upperRadiusLimit, camera.radius + dt * 4);
      }
    }

    // ---- interpolation of remote players ----
    var ids = Object.keys(state.players);
    for (var i = 0; i < ids.length; i++) {
      var pl = state.players[ids[i]];
      var c = pl.char;
      if (!c || !c.root) continue;
      var lerp = Math.min(1, dt * 12);
      c.root.position.x += (pl.targetX - c.root.position.x) * lerp;
      c.root.position.y += (pl.targetY - c.root.position.y) * lerp;
      c.root.position.z += (pl.targetZ - c.root.position.z) * lerp;
      var dRy = pl.targetRy - c.root.rotation.y;
      while (dRy > Math.PI) dRy -= Math.PI * 2;
      while (dRy < -Math.PI) dRy += Math.PI * 2;
      c.root.rotation.y += dRy * lerp;
      animateChar(c, pl.walking || pl.running, pl.running, dt);
    }

    // ---- send own state ----
    state.sendAccum += dt * 1000;
    if (state.sendAccum >= SEND_INTERVAL && state.connected && state.myId) {
      state.sendAccum = 0;
      send({
        type: 'playerMoved',
        x: myRoot.position.x,
        y: myRoot.position.y,
        z: myRoot.position.z,
        ry: myRoot.rotation.y,
        walking: mag > 0.05 && !running,
        running: mag > 0.05 && running
      });
    }
  });

  function animateChar(ch, walking, running, dt) {
    if (!ch || !ch.parts) return;
    var speed = running ? 13 : 8.5;
    if (walking) ch.walkPhase += dt * speed;
    else ch.walkPhase += dt * 1.5;

    var amp = running ? 0.85 : 0.6;
    var sw = Math.sin(ch.walkPhase) * amp * (walking ? 1 : 0.06);
    ch.parts.armL.rotation.x = sw;
    ch.parts.armR.rotation.x = -sw;
    ch.parts.legL.rotation.x = -sw;
    ch.parts.legR.rotation.x = sw;
  }

  // ============ ENGINE RUN ============
  engine.runRenderLoop(function () {
    scene.render();
  });

  window.addEventListener('resize', function () {
    engine.resize();
  });

  // adaptive quality
  if (isMobile) {
    engine.setHardwareScalingLevel(1.25);
  }

  // ============ START ============
  connectWS();

  // clean exit
  window.addEventListener('beforeunload', function () {
    state.intentionalLeave = true;
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify({ type: 'leaveRoom' })); } catch (e) {}
    }
  });
})();
</script>
</body>
</html>`;

// ---------- HTTP routes ----------
app.get('/', function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(HTML);
});

app.get('/health', function (req, res) {
  res.setHeader('Content-Type', 'text/plain');
  res.send('ok');
});

// ---------- START ----------
server.listen(PORT, function () {
  console.log('Server listening on port ' + PORT);
});
