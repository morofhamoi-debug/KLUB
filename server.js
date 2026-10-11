/* =========================================================
   server.js — HTTP + WebSocket сервер для 3D-мультиплеера
   Раздаёт index.html, style.css, client.js (Express)
   Хранит комнаты в памяти, синхронизирует игроков.
   ========================================================= */

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* ---------- Ограничения ---------- */
const MAX_PLAYERS_PER_ROOM = 10;
const MAX_MSG_BYTES = 2048;
const MIN_MOVE_INTERVAL_MS = 25;      // ~40 сообщений/сек максимум от клиента
const MAX_NAME_LEN = 20;
const MAX_STEP = 3;                    // максимальный "прыжок" координат (античит)
const BOUNDS = { minX: -13.4, maxX: 13.4, minZ: -13.4, maxZ: 13.4, minY: 0, maxY: 3 };

/* ---------- Хранилище комнат ---------- */
const rooms = new Map(); // code -> { code, players: Map<id, player>, createdAt }

/* ---------- Раздача статики (index.html, style.css, client.js) ---------- */
app.use(
  express.static(__dirname, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ---------- Генерация кода комнаты ---------- */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#1abc9c', '#e67e22', '#e84393', '#00cec9', '#6c5ce7',
];

function pickColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[room.players.size % COLORS.length];
}

/* ---------- Утилиты ---------- */
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}
function sendError(ws, message) {
  send(ws, { type: 'error', message });
}
function broadcast(code, obj, exceptId) {
  const room = rooms.get(code);
  if (!room) return;
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    const client = p.ws;
    if (client && client.readyState === WebSocket.OPEN) {
      send(client, obj);
    }
  }
}
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LEN) return null;
  return trimmed.replace(/[<>&"]/g, '');
}
function sanitizeCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(c)) return null;
  return c;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function emptyRoom(code) {
  return { code, players: new Map(), createdAt: Date.now() };
}

function removePlayerFromRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  if (!room) return;
  if (room.players.delete(ws.id)) {
    broadcast(code, { type: 'playerLeft', id: ws.id });
  }
  if (room.players.size === 0) {
    rooms.delete(code);
  }
}

/* ---------- Обработчики сообщений ---------- */

function handleCreateRoom(ws, msg) {
  if (ws.roomCode) return sendError(ws, 'Вы уже в комнате');
  const name = sanitizeName(msg.name);
  if (!name) return sendError(ws, 'Некорректное имя (1–20 символов)');

  const code = generateRoomCode();
  const room = emptyRoom(code);
  rooms.set(code, room);
  joinPlayerToRoom(ws, room, name);
}

function handleJoinRoom(ws, msg) {
  if (ws.roomCode) return sendError(ws, 'Вы уже в комнате');
  const name = sanitizeName(msg.name);
  if (!name) return sendError(ws, 'Некорректное имя (1–20 символов)');
  const code = sanitizeCode(msg.code);
  if (!code) return sendError(ws, 'Некорректный код комнаты');
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Комната не найдена');
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) return sendError(ws, 'Комната заполнена');

  joinPlayerToRoom(ws, room, name);
}

function joinPlayerToRoom(ws, room, name) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 2 + Math.random() * 3;
  const player = {
    id: ws.id,
    name,
    color: pickColor(room),
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
    ry: Math.random() * Math.PI * 2,
    moving: false,
    running: false,
    lastMove: 0,
    ws,
  };
  room.players.set(ws.id, player);
  ws.roomCode = room.code;
  ws.playerName = name;

  const snapshot = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    moving: p.moving, running: p.running,
  }));

  // === ИСПРАВЛЕНО: было "p.name", стало "player.name" ===
  send(ws, {
    type: 'roomState',
    code: room.code,
    you: { id: ws.id, name: player.name, color: player.color },
    players: snapshot,
  });

  broadcast(
    room.code,
    {
      type: 'playerJoined',
      player: {
        id: player.id, name: player.name, color: player.color,
        x: player.x, y: player.y, z: player.z, ry: player.ry,
        moving: false, running: false,
      },
    },
    ws.id
  );
}

function handlePlayerMoved(ws, msg) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const player = room.players.get(ws.id);
  if (!player) return;

  const now = Date.now();
  if (now - player.lastMove < MIN_MOVE_INTERVAL_MS) return;

  const { x, y, z, ry, moving, running } = msg;
  if (
    typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
    typeof ry !== 'number' || !isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(ry)
  ) return;

  const cx = clamp(x, BOUNDS.minX, BOUNDS.maxX);
  const cy = clamp(y, BOUNDS.minY, BOUNDS.maxY);
  const cz = clamp(z, BOUNDS.minZ, BOUNDS.maxZ);

  // античит: слишком большой шаг отбрасываем
  const dx = cx - player.x, dz = cz - player.z;
  if (dx * dx + dz * dz > MAX_STEP * MAX_STEP) return;

  player.x = cx; player.y = cy; player.z = cz;
  player.ry = ry;
  player.moving = !!moving;
  player.running = !!running;
  player.lastMove = now;

  broadcast(room.code, {
    type: 'playerMoved',
    id: player.id,
    x: cx, y: cy, z: cz, ry,
    moving: player.moving,
    running: player.running,
  }, ws.id);
}

/* ---------- WebSocket-подключения ---------- */
wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(8).toString('hex');
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerName = null;

  send(ws, { type: 'welcome', id: ws.id });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (raw.length > MAX_MSG_BYTES) return sendError(ws, 'Сообщение слишком большое');
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return sendError(ws, 'Некорректный JSON'); }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'createRoom': return handleCreateRoom(ws, msg);
      case 'joinRoom': return handleJoinRoom(ws, msg);
      case 'playerMoved': return handlePlayerMoved(ws, msg);
      case 'ping': return send(ws, { type: 'pong', t: Date.now() });
      default: return;
    }
  });

  ws.on('close', () => removePlayerFromRoom(ws));
  ws.on('error', () => removePlayerFromRoom(ws));
});

/* ---------- Heartbeat: убираем "мертвые" соединения ---------- */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30000);

/* ---------- Очистка пустых комнат ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && now - room.createdAt > 60_000) {
      rooms.delete(code);
    }
  }
}, 60_000);

/* ---------- Запуск ---------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('3D multiplayer server listening on port ' + PORT);
});
