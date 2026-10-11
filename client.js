/* =========================================================
   client.js — Babylon.js 3D сцена, первое лицо, киберпанк,
   WebSocket-клиент, синхронизация игроков.
   ========================================================= */

(function () {
'use strict';

/* ==================== DOM ==================== */
const $ = (id) => document.getElementById(id);
const menuEl         = $('menu');
const gameEl         = $('game');
const canvas         = $('renderCanvas');
const nameInput      = $('nameInput');
const roomInput      = $('roomInput');
const createBtn      = $('createBtn');
const joinBtn        = $('joinBtn');
const errorEl        = $('error');
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const roomCodeEl     = $('roomCodeDisplay');
const copyBtn        = $('copyBtn');
const leaveBtn       = $('leaveBtn');
const playersListEl  = $('playersList');
const playersCountEl = $('playersCount');
const localNameEl    = $('localName');
const connStatusEl   = $('connStatus');
const notifEl        = $('notification');
const joystickEl     = $('joystick');
const joystickKnob   = $('joystickKnob');
const runBtn         = $('runBtn');

const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const isMobile = isTouch && window.matchMedia('(max-width: 900px)').matches;

/* ==================== Состояние ==================== */
const state = {
  ws: null,
  myId: null,
  roomCode: null,
  inRoom: false,
  playerName: '',
  wantReconnect: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  lastSent: 0,
  connected: false,
};

const playersInfo = new Map(); // id -> { id, name, color }
const remotePlayers = new Map(); // id -> remote entry

/* ==================== Ввод ==================== */
const keys = Object.create(null);
const keyMove = { x: 0, y: 0 };
const joyMove = { x: 0, y: 0 };
let runningBtnHeld = false;

// Ориентация камеры
let camYaw = 0;
let camPitch = 0;
const EYE_HEIGHT = 1.7;
const PITCH_MIN = -1.45;
const PITCH_MAX = 1.45;

/* ==================== Babylon ==================== */
let engine, scene, camera, shadowGen;
const local = { x: 0, y: 0, z: 0, moving: false, running: false };

const OBSTACLES = []; // {minX,maxX,minZ,maxZ}

/* =========================================================
   УТИЛИТЫ
   ========================================================= */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function showNotification(text) {
  notifEl.textContent = text;
  notifEl.classList.add('show');
  clearTimeout(showNotification._t);
  showNotification._t = setTimeout(() => notifEl.classList.remove('show'), 2200);
}
function setError(text) { errorEl.textContent = text || ''; }
function setConnectionIndicator(kind, text) {
  statusDot.classList.remove('online', 'connecting');
  if (kind === 'online') statusDot.classList.add('online');
  else if (kind === 'connecting') statusDot.classList.add('connecting');
  statusText.textContent = text;
}
function setInGameConn(text, ok) {
  connStatusEl.textContent = text;
  connStatusEl.classList.toggle('offline', !ok);
}

/* =========================================================
   BABYLON — СЦЕНА
   ========================================================= */
function initBabylon() {
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true);
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.01, 0.01, 0.03, 1);
  scene.ambientColor = new BABYLON.Color3(0.10, 0.12, 0.20);
  scene.collisionsEnabled = false;

  // Камера первого лица
  camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, EYE_HEIGHT, 0), scene);
  camera.minZ = 0.05;
  camera.maxZ = 200;
  camera.fov = 1.05;
  camera.inertia = 0;
  camera.speed = 0;
  camera.rotation = new BABYLON.Vector3(0, 0, 0);

  buildRoom(scene);

  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
    updateLocalPlayer(dt);
    updateRemotePlayers(dt);
    updateCamera();
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => engine.resize(), 250));
}

/* =========================================================
   КИБЕРПАНК-КОМНАТА
   ========================================================= */
function buildRoom(scene) {
  const P = 14;   // половина стороны
  const H = 4.5;  // высота стен

  // Туман — синеватая дымка
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogColor = new BABYLON.Color3(0.02, 0.02, 0.05);
  scene.fogDensity = 0.022;

  // GlowLayer — неоновое свечение всех emissive-материалов
  const glow = new BABYLON.GlowLayer('glow', scene, {
    mainTextureFixedSize: isMobile ? 256 : 512,
    blurKernelSize: isMobile ? 24 : 32,
  });
  glow.intensity = 1.15;

  /* ---------- МАТЕРИАЛЫ ---------- */
  const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
  floorMat.diffuseColor = new BABYLON.Color3(0.04, 0.04, 0.065);
  floorMat.specularColor = new BABYLON.Color3(0.55, 0.6, 0.8);
  floorMat.specularPower = 200;

  const wallMat = new BABYLON.StandardMaterial('wallMat', scene);
  wallMat.diffuseColor = new BABYLON.Color3(0.085, 0.085, 0.12);
  wallMat.specularColor = new BABYLON.Color3(0.14, 0.14, 0.20);

  const wallPanelMat = new BABYLON.StandardMaterial('wallPanelMat', scene);
  wallPanelMat.diffuseColor = new BABYLON.Color3(0.055, 0.055, 0.085);
  wallPanelMat.specularColor = new BABYLON.Color3(0.22, 0.22, 0.30);
  wallPanelMat.specularPower = 96;

  const ceilMat = new BABYLON.StandardMaterial('ceilMat', scene);
  ceilMat.diffuseColor = new BABYLON.Color3(0.035, 0.035, 0.055);

  const metalDark = new BABYLON.StandardMaterial('metalDark', scene);
  metalDark.diffuseColor = new BABYLON.Color3(0.12, 0.12, 0.16);
  metalDark.specularColor = new BABYLON.Color3(0.75, 0.78, 0.9);
  metalDark.specularPower = 140;

  const neonCyan = new BABYLON.StandardMaterial('neonCyan', scene);
  neonCyan.emissiveColor = new BABYLON.Color3(0.05, 0.85, 1.0);
  neonCyan.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const neonMagenta = new BABYLON.StandardMaterial('neonMagenta', scene);
  neonMagenta.emissiveColor = new BABYLON.Color3(1.0, 0.08, 0.85);
  neonMagenta.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const neonYellow = new BABYLON.StandardMaterial('neonYellow', scene);
  neonYellow.emissiveColor = new BABYLON.Color3(1.0, 0.85, 0.1);
  neonYellow.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const neonBlue = new BABYLON.StandardMaterial('neonBlue', scene);
  neonBlue.emissiveColor = new BABYLON.Color3(0.15, 0.4, 1.0);
  neonBlue.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const screenCyan = new BABYLON.StandardMaterial('screenCyan', scene);
  screenCyan.emissiveColor = new BABYLON.Color3(0.1, 0.55, 0.95);
  screenCyan.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const screenMagenta = new BABYLON.StandardMaterial('screenMagenta', scene);
  screenMagenta.emissiveColor = new BABYLON.Color3(0.95, 0.1, 0.7);
  screenMagenta.diffuseColor = new BABYLON.Color3(0, 0, 0);

  const screenYellow = new BABYLON.StandardMaterial('screenYellow', scene);
  screenYellow.emissiveColor = new BABYLON.Color3(1.0, 0.75, 0.15);
  screenYellow.diffuseColor = new BABYLON.Color3(0, 0, 0);

  /* ---------- ПОЛ ---------- */
  const floor = BABYLON.MeshBuilder.CreateBox('floor', { width: P*2, height: 0.2, depth: P*2 }, scene);
  floor.position.y = -0.1;
  floor.material = floorMat;
  floor.receiveShadows = true;

  // Неоновая сетка на полу
  for (let i = -6; i <= 6; i++) {
    const isMain = (i === 0);
    const isAccent = (i % 3 === 0);
    const mat = isMain ? neonCyan : (isAccent ? neonMagenta : neonBlue);
    const lx = BABYLON.MeshBuilder.CreateBox('gridX' + i, { width: P*2 - 0.6, height: 0.015, depth: 0.035 }, scene);
    lx.position.set(0, 0.008, i * 2);
    lx.material = mat;
    const lz = BABYLON.MeshBuilder.CreateBox('gridZ' + i, { width: 0.035, height: 0.015, depth: P*2 - 0.6 }, scene);
    lz.position.set(i * 2, 0.008, 0);
    lz.material = mat;
  }

  /* ---------- СТЕНЫ ---------- */
  const wallT = 0.3;
  const walls = [
    { name: 'N', w: P*2 + wallT*2, d: wallT, x: 0, z: -P },
    { name: 'S', w: P*2 + wallT*2, d: wallT, x: 0, z:  P },
    { name: 'W', w: wallT, d: P*2, x: -P, z: 0 },
    { name: 'E', w: wallT, d: P*2, x:  P, z: 0 },
  ];
  for (const w of walls) {
    const m = BABYLON.MeshBuilder.CreateBox('wall' + w.name, { width: w.w, height: H, depth: w.d }, scene);
    m.position.set(w.x, H/2, w.z);
    m.material = wallMat;
  }

  // Панели на стенах
  for (let i = -5; i <= 5; i++) {
    if (i === 0) continue;
    const pN = BABYLON.MeshBuilder.CreateBox('panelN' + i, { width: 1.8, height: H - 0.6, depth: 0.05 }, scene);
    pN.position.set(i * 2.3, H/2, -P + wallT/2 + 0.03);
    pN.material = wallPanelMat;
    const pS = BABYLON.MeshBuilder.CreateBox('panelS' + i, { width: 1.8, height: H - 0.6, depth: 0.05 }, scene);
    pS.position.set(i * 2.3, H/2, P - wallT/2 - 0.03);
    pS.material = wallPanelMat;
  }
  for (let i = -5; i <= 5; i++) {
    const pW = BABYLON.MeshBuilder.CreateBox('panelW' + i, { width: 0.05, height: H - 0.6, depth: 1.8 }, scene);
    pW.position.set(-P + wallT/2 + 0.03, H/2, i * 2.3);
    pW.material = wallPanelMat;
    const pE = BABYLON.MeshBuilder.CreateBox('panelE' + i, { width: 0.05, height: H - 0.6, depth: 1.8 }, scene);
    pE.position.set(P - wallT/2 - 0.03, H/2, i * 2.3);
    pE.material = wallPanelMat;
  }

  // Горизонтальные неоновые полосы
  function wallStrip(name, w, h, d, x, y, z, mat) {
    const s = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    s.position.set(x, y, z);
    s.material = mat;
  }
  wallStrip('stripN_top', P*2 - 0.5, 0.06, 0.04, 0, H - 0.3, -P + wallT/2 + 0.05, neonCyan);
  wallStrip('stripN_mid', P*2 - 0.5, 0.04, 0.04, 0, H/2,     -P + wallT/2 + 0.05, neonMagenta);
  wallStrip('stripS_top', P*2 - 0.5, 0.06, 0.04, 0, H - 0.3,  P - wallT/2 - 0.05, neonCyan);
  wallStrip('stripS_mid', P*2 - 0.5, 0.04, 0.04, 0, H/2,      P - wallT/2 - 0.05, neonMagenta);
  wallStrip('stripE_top', 0.04, 0.06, P*2 - 0.5,  P - wallT/2 - 0.05, H - 0.3, 0, neonMagenta);
  wallStrip('stripE_mid', 0.04, 0.04, P*2 - 0.5,  P - wallT/2 - 0.05, H/2,     0, neonCyan);
  wallStrip('stripW_top', 0.04, 0.06, P*2 - 0.5, -P + wallT/2 + 0.05, H - 0.3, 0, neonMagenta);
  wallStrip('stripW_mid', 0.04, 0.04, P*2 - 0.5, -P + wallT/2 + 0.05, H/2,     0, neonCyan);

  /* ---------- ПОТОЛОК ---------- */
  const ceiling = BABYLON.MeshBuilder.CreateBox('ceiling', { width: P*2, height: 0.2, depth: P*2 }, scene);
  ceiling.position.y = H + 0.1;
  ceiling.material = ceilMat;
  for (let i = -3; i <= 3; i++) {
    const strip = BABYLON.MeshBuilder.CreateBox('ceilStrip' + i, { width: P*2 - 1, height: 0.03, depth: 0.08 }, scene);
    strip.position.set(0, H - 0.02, i * 3);
    strip.material = (i % 2 === 0) ? neonCyan : neonMagenta;
  }

  /* ---------- ДВЕРЬ (север) ---------- */
  const doorFrame = BABYLON.MeshBuilder.CreateBox('doorFrame', { width: 2.4, height: 3.2, depth: 0.12 }, scene);
  doorFrame.position.set(0, 1.6, -P + wallT/2 + 0.02);
  doorFrame.material = metalDark;
  const door = BABYLON.MeshBuilder.CreateBox('door', { width: 2.0, height: 3.0, depth: 0.08 }, scene);
  door.position.set(0, 1.5, -P + wallT/2 + 0.09);
  door.material = metalDark;
  const doorSplit = BABYLON.MeshBuilder.CreateBox('doorSplit', { width: 0.04, height: 3.0, depth: 0.10 }, scene);
  doorSplit.position.set(0, 1.5, -P + wallT/2 + 0.10);
  doorSplit.material = neonCyan;
  const hL = BABYLON.MeshBuilder.CreateBox('hL', { width: 0.08, height: 0.6, depth: 0.06 }, scene);
  hL.position.set(-0.15, 1.5, -P + wallT/2 + 0.13);
  hL.material = neonCyan;
  const hR = BABYLON.MeshBuilder.CreateBox('hR', { width: 0.08, height: 0.6, depth: 0.06 }, scene);
  hR.position.set(0.15, 1.5, -P + wallT/2 + 0.13);
  hR.material = neonCyan;
  const doorSign = BABYLON.MeshBuilder.CreateBox('doorSign', { width: 1.8, height: 0.35, depth: 0.08 }, scene);
  doorSign.position.set(0, 3.6, -P + wallT/2 + 0.09);
  doorSign.material = neonMagenta;

  /* ---------- ОКНА (юг) ---------- */
  const winXs = [-8, -2.5, 3, 8.5];
  for (let i = 0; i < winXs.length; i++) {
    const wx = winXs[i];
    const glass = BABYLON.MeshBuilder.CreatePlane('glass' + i, { width: 4.5, height: 2.4 }, scene);
    glass.position.set(wx, 2.2, P - wallT/2 - 0.02);
    glass.rotation.y = Math.PI;
    const gm = new BABYLON.StandardMaterial('glassM' + i, scene);
    gm.emissiveColor = new BABYLON.Color3(0.15, 0.35, 0.65);
    gm.diffuseColor = new BABYLON.Color3(0.08, 0.18, 0.4);
    gm.alpha = 0.35;
    glass.material = gm;
    const ft = BABYLON.MeshBuilder.CreateBox('winTop' + i, { width: 4.7, height: 0.15, depth: 0.15 }, scene);
    ft.position.set(wx, 3.45, P - wallT/2 - 0.05);
    ft.material = metalDark;
    const fb = BABYLON.MeshBuilder.CreateBox('winBot' + i, { width: 4.7, height: 0.15, depth: 0.15 }, scene);
    fb.position.set(wx, 0.95, P - wallT/2 - 0.05);
    fb.material = metalDark;
    const fl = BABYLON.MeshBuilder.CreateBox('winL' + i, { width: 0.15, height: 2.65, depth: 0.15 }, scene);
    fl.position.set(wx - 2.35, 2.2, P - wallT/2 - 0.05);
    fl.material = metalDark;
    const fr = BABYLON.MeshBuilder.CreateBox('winR' + i, { width: 0.15, height: 2.65, depth: 0.15 }, scene);
    fr.position.set(wx + 2.35, 2.2, P - wallT/2 - 0.05);
    fr.material = metalDark;
    const fm = BABYLON.MeshBuilder.CreateBox('winMid' + i, { width: 0.08, height: 2.65, depth: 0.1 }, scene);
    fm.position.set(wx, 2.2, P - wallT/2 - 0.05);
    fm.material = metalDark;
    const sill = BABYLON.MeshBuilder.CreateBox('sill' + i, { width: 4.6, height: 0.05, depth: 0.12 }, scene);
    sill.position.set(wx, 0.88, P - wallT/2 - 0.08);
    sill.material = neonCyan;
  }

  /* ---------- НЕОНОВЫЙ ГОРОД ЗА ОКНАМИ ---------- */
  const cityMat = new BABYLON.StandardMaterial('cityMat', scene);
  cityMat.diffuseColor = new BABYLON.Color3(0.025, 0.025, 0.055);
  cityMat.emissiveColor = new BABYLON.Color3(0.02, 0.02, 0.05);

  const cityGlows = [
    new BABYLON.StandardMaterial('cgA', scene),
    new BABYLON.StandardMaterial('cgB', scene),
    new BABYLON.StandardMaterial('cgC', scene),
  ];
  cityGlows[0].emissiveColor = new BABYLON.Color3(0.9, 0.15, 0.6);
  cityGlows[1].emissiveColor = new BABYLON.Color3(0.15, 0.7, 1.0);
  cityGlows[2].emissiveColor = new BABYLON.Color3(1.0, 0.85, 0.2);
  for (const m of cityGlows) m.diffuseColor = new BABYLON.Color3(0, 0, 0);

  for (let i = 0; i < 30; i++) {
    const bx = -35 + Math.random() * 70;
    const bz = P + 10 + Math.random() * 50;
    const bh = 6 + Math.random() * 35;
    const bw = 1.5 + Math.random() * 3.5;
    const b = BABYLON.MeshBuilder.CreateBox('bldg' + i, { width: bw, height: bh, depth: bw }, scene);
    b.position.set(bx, bh / 2 - 3, bz);
    b.material = cityMat;
    const dots = 3 + Math.floor(Math.random() * 4);
    for (let d = 0; d < dots; d++) {
      const dot = BABYLON.MeshBuilder.CreatePlane('cd' + i + '_' + d, { width: 0.25, height: 0.25 }, scene);
      const dy = Math.random() * (bh - 1.5) + 0.5;
      dot.position.set(bx + (Math.random() - 0.5) * (bw - 0.4), dy, bz - bw / 2 - 0.06);
      dot.rotation.y = Math.PI;
      dot.material = cityGlows[Math.floor(Math.random() * 3)];
    }
  }

  /* ---------- ВОСТОЧНАЯ СТЕНА: серверная стойка + голопанель ---------- */
  const rack = BABYLON.MeshBuilder.CreateBox('rack', { width: 0.9, height: 2.4, depth: 2.0 }, scene);
  rack.position.set(P - 0.9, 1.2, -6);
  rack.material = metalDark;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 3; c++) {
      const led = BABYLON.MeshBuilder.CreateBox('led' + r + '_' + c, { width: 0.03, height: 0.05, depth: 0.03 }, scene);
      led.position.set(P - 1.35, 0.4 + r * 0.2, -6.9 + c * 0.6);
      led.material = Math.random() > 0.5 ? neonCyan : (Math.random() > 0.5 ? neonMagenta : neonYellow);
    }
  }
  OBSTACLES.push({ minX: P - 1.4, maxX: P - 0.4, minZ: -7.1, maxZ: -4.9 });

  const holoPanel = BABYLON.MeshBuilder.CreatePlane('holoPanel', { width: 3.5, height: 2.0 }, scene);
  holoPanel.position.set(P - wallT/2 - 0.06, 2.2, -1.5);
  holoPanel.rotation.y = -Math.PI / 2;
  const holoMat = new BABYLON.StandardMaterial('holoMat', scene);
  holoMat.emissiveColor = new BABYLON.Color3(0.15, 0.85, 1.0);
  holoMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
  holoMat.alpha = 0.85;
  holoPanel.material = holoMat;
  const holoFrame = BABYLON.MeshBuilder.CreateBox('holoFrame', { width: 0.06, height: 2.2, depth: 3.7 }, scene);
  holoFrame.position.set(P - wallT/2 - 0.12, 2.2, -1.5);
  holoFrame.material = metalDark;

  /* ---------- ЗАПАДНАЯ СТЕНА: кибер-стол с 3 мониторами ---------- */
  const deskTop = BABYLON.MeshBuilder.CreateBox('deskTop', { width: 1.2, height: 0.08, depth: 3.6 }, scene);
  deskTop.position.set(-P + 1.1, 0.85, 0);
  deskTop.material = metalDark;
  for (let i = 0; i < 4; i++) {
    const dx = (i % 2 === 0) ? -0.45 : 0.45;
    const dz = (i < 2) ? -1.6 : 1.6;
    const leg = BABYLON.MeshBuilder.CreateBox('deskLeg' + i, { width: 0.1, height: 0.82, depth: 0.1 }, scene);
    leg.position.set(-P + 1.1 + dx, 0.41, dz);
    leg.material = metalDark;
  }
  const deskNeon = BABYLON.MeshBuilder.CreateBox('deskNeon', { width: 1.15, height: 0.04, depth: 3.55 }, scene);
  deskNeon.position.set(-P + 1.1, 0.83, 0);
  deskNeon.material = neonMagenta;

  for (let i = -1; i <= 1; i++) {
    const mz = i * 1.15;
    const monBase = BABYLON.MeshBuilder.CreateBox('monBase' + i, { width: 0.15, height: 0.05, depth: 0.35 }, scene);
    monBase.position.set(-P + 1.4, 0.92, mz);
    monBase.material = metalDark;
    const monStand = BABYLON.MeshBuilder.CreateBox('monStand' + i, { width: 0.06, height: 0.35, depth: 0.08 }, scene);
    monStand.position.set(-P + 1.4, 1.10, mz);
    monStand.material = metalDark;
    const monScreen = BABYLON.MeshBuilder.CreateBox('monScreen' + i, { width: 0.05, height: 0.65, depth: 0.95 }, scene);
    monScreen.position.set(-P + 1.4, 1.55, mz);
    monScreen.material = (i === -1) ? screenCyan : (i === 0 ? screenMagenta : screenYellow);
  }
  OBSTACLES.push({ minX: -P + 0.5, maxX: -P + 1.75, minZ: -1.9, maxZ: 1.9 });

  /* ---------- КИБЕР-КРЕСЛО ---------- */
  const cBase = BABYLON.MeshBuilder.CreateCylinder('cBase', { diameter: 0.7, height: 0.06 }, scene);
  cBase.position.set(-P + 2.5, 0.05, 0);
  cBase.material = metalDark;
  const cPole = BABYLON.MeshBuilder.CreateCylinder('cPole', { diameter: 0.08, height: 0.5 }, scene);
  cPole.position.set(-P + 2.5, 0.3, 0);
  cPole.material = metalDark;
  const cSeat = BABYLON.MeshBuilder.CreateBox('cSeat', { width: 0.55, height: 0.1, depth: 0.55 }, scene);
  cSeat.position.set(-P + 2.5, 0.6, 0);
  cSeat.material = metalDark;
  const cBack = BABYLON.MeshBuilder.CreateBox('cBack', { width: 0.55, height: 0.9, depth: 0.1 }, scene);
  cBack.position.set(-P + 2.2, 1.05, 0);
  cBack.material = metalDark;
  const cN1 = BABYLON.MeshBuilder.CreateBox('cN1', { width: 0.5, height: 0.06, depth: 0.12 }, scene);
  cN1.position.set(-P + 2.2, 1.15, 0);
  cN1.material = neonCyan;
  const cN2 = BABYLON.MeshBuilder.CreateBox('cN2', { width: 0.5, height: 0.06, depth: 0.12 }, scene);
  cN2.position.set(-P + 2.2, 0.85, 0);
  cN2.material = neonCyan;
  OBSTACLES.push({ minX: -P + 2.1, maxX: -P + 2.9, minZ: -0.5, maxZ: 0.5 });

  /* ---------- АВТОМАТ С ЕДОЙ (СВ угол) ---------- */
  const vendBody = BABYLON.MeshBuilder.CreateBox('vendBody', { width: 1.2, height: 2.2, depth: 0.9 }, scene);
  vendBody.position.set(9, 1.1, -P + 1.2);
  vendBody.material = metalDark;
  const vendGlass = BABYLON.MeshBuilder.CreateBox('vendGlass', { width: 1.05, height: 1.6, depth: 0.05 }, scene);
  vendGlass.position.set(9, 1.35, -P + 1.68);
  const vgm = new BABYLON.StandardMaterial('vgm', scene);
  vgm.emissiveColor = new BABYLON.Color3(0.9, 0.4, 1.0);
  vgm.diffuseColor = new BABYLON.Color3(0, 0, 0);
  vgm.alpha = 0.75;
  vendGlass.material = vgm;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      const p = BABYLON.MeshBuilder.CreateBox('vp' + r + '_' + c, { width: 0.15, height: 0.25, depth: 0.02 }, scene);
      p.position.set(8.55 + c * 0.22, 0.75 + r * 0.5, -P + 1.72);
      const pm = new BABYLON.StandardMaterial('vpm' + r + c, scene);
      pm.emissiveColor = BABYLON.Color3.FromHSV(Math.random() * 360, 1, 1);
      pm.diffuseColor = new BABYLON.Color3(0, 0, 0);
      p.material = pm;
    }
  }
  OBSTACLES.push({ minX: 8.4, maxX: 9.6, minZ: -P + 0.75, maxZ: -P + 1.65 });

  /* ---------- ДИВАН (ЮВ угол) ---------- */
  const sofaMat = new BABYLON.StandardMaterial('sofaMat', scene);
  sofaMat.diffuseColor = new BABYLON.Color3(0.07, 0.08, 0.13);
  sofaMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.15);
  const sBase = BABYLON.MeshBuilder.CreateBox('sBase', { width: 3.2, height: 0.5, depth: 1.3 }, scene);
  sBase.position.set(6, 0.35, 11);
  sBase.material = sofaMat;
  const sBack = BABYLON.MeshBuilder.CreateBox('sBack', { width: 3.2, height: 0.9, depth: 0.3 }, scene);
  sBack.position.set(6, 0.85, 11.5);
  sBack.material = sofaMat;
  const sNeon = BABYLON.MeshBuilder.CreateBox('sNeon', { width: 3.1, height: 0.05, depth: 0.05 }, scene);
  sNeon.position.set(6, 0.62, 10.4);
  sNeon.material = neonMagenta;
  OBSTACLES.push({ minX: 4.3, maxX: 7.7, minZ: 10.3, maxZ: 11.7 });

  /* ---------- НИЗКИЙ СТОЛИК ---------- */
  const lowTable = BABYLON.MeshBuilder.CreateBox('lowTable', { width: 1.6, height: 0.06, depth: 0.9 }, scene);
  lowTable.position.set(6, 0.42, 8.6);
  lowTable.material = metalDark;
  const ltNeon = BABYLON.MeshBuilder.CreateBox('ltNeon', { width: 1.55, height: 0.03, depth: 0.85 }, scene);
  ltNeon.position.set(6, 0.4, 8.6);
  ltNeon.material = neonCyan;
  OBSTACLES.push({ minX: 5.2, maxX: 6.8, minZ: 8.15, maxZ: 9.05 });

  /* ---------- РАСТЕНИЕ ---------- */
  const potMat = new BABYLON.StandardMaterial('potMat', scene);
  potMat.diffuseColor = new BABYLON.Color3(0.14, 0.14, 0.17);
  potMat.specularColor = new BABYLON.Color3(0.4, 0.4, 0.5);
  const pot = BABYLON.MeshBuilder.CreateCylinder('pot', { diameterTop: 0.5, diameterBottom: 0.35, height: 0.5 }, scene);
  pot.position.set(-11, 0.25, 11);
  pot.material = potMat;
  const plantMat = new BABYLON.StandardMaterial('plantMat', scene);
  plantMat.diffuseColor = new BABYLON.Color3(0.08, 0.32, 0.18);
  plantMat.emissiveColor = new BABYLON.Color3(0.03, 0.14, 0.07);
  for (let i = 0; i < 8; i++) {
    const leaf = BABYLON.MeshBuilder.CreateSphere('leaf' + i, { diameter: 0.55, segments: 6 }, scene);
    const a = (i / 8) * Math.PI * 2;
    leaf.position.set(-11 + Math.cos(a) * 0.3, 0.85 + Math.sin(i * 1.7) * 0.15, 11 + Math.sin(a) * 0.3);
    leaf.scaling.y = 1.5;
    leaf.material = plantMat;
  }
  OBSTACLES.push({ minX: -11.4, maxX: -10.6, minZ: 10.6, maxZ: 11.4 });

  /* ---------- ТРУБЫ НА ПОТОЛКЕ ---------- */
  for (let i = 0; i < 3; i++) {
    const pipe = BABYLON.MeshBuilder.CreateCylinder('pipe' + i, { diameter: 0.15, height: P*2 - 1 }, scene);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, H - 0.35, -4 + i * 4);
    pipe.material = metalDark;
  }

  /* ---------- ОСВЕЩЕНИЕ ---------- */
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.28;
  hemi.diffuse = new BABYLON.Color3(0.6, 0.7, 1.0);
  hemi.groundColor = new BABYLON.Color3(0.04, 0.04, 0.08);

  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.4, -1, -0.3), scene);
  dir.position = new BABYLON.Vector3(10, 20, 10);
  dir.intensity = 0.35;
  dir.diffuse = new BABYLON.Color3(0.6, 0.7, 1.0);

  if (!isMobile) {
    shadowGen = new BABYLON.ShadowGenerator(1024, dir);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 12;
    shadowGen.darkness = 0.65;
  }

  const pCyan = new BABYLON.PointLight('pCyan', new BABYLON.Vector3(P - 3, 2.4, -1.5), scene);
  pCyan.diffuse = new BABYLON.Color3(0.2, 0.85, 1.0);
  pCyan.intensity = 0.65;
  pCyan.range = 13;

  const pMagenta = new BABYLON.PointLight('pMagenta', new BABYLON.Vector3(-P + 3, 2.4, 0), scene);
  pMagenta.diffuse = new BABYLON.Color3(1.0, 0.2, 0.85);
  pMagenta.intensity = 0.6;
  pMagenta.range = 13;

  const pDoor = new BABYLON.PointLight('pDoor', new BABYLON.Vector3(0, 2.6, -P + 1.5), scene);
  pDoor.diffuse = new BABYLON.Color3(1.0, 0.15, 0.85);
  pDoor.intensity = 0.65;
  pDoor.range = 11;

  const pWin = new BABYLON.PointLight('pWin', new BABYLON.Vector3(0, 2.6, P - 2), scene);
  pWin.diffuse = new BABYLON.Color3(0.2, 0.6, 1.0);
  pWin.intensity = 0.55;
  pWin.range = 15;

  const pVend = new BABYLON.PointLight('pVend', new BABYLON.Vector3(9, 1.8, -P + 2), scene);
  pVend.diffuse = new BABYLON.Color3(0.9, 0.4, 1.0);
  pVend.intensity = 0.55;
  pVend.range = 9;

  // Лёгкое мерцание неона
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() * 0.001;
    pCyan.intensity    = 0.65 + Math.sin(t * 2.3) * 0.08;
    pMagenta.intensity = 0.60 + Math.sin(t * 1.7 + 1) * 0.07;
    pDoor.intensity    = 0.65 + Math.sin(t * 3.1 + 2) * 0.10;
  });
}

/* =========================================================
   ПЕРСОНАЖ (для удалённых игроков)
   ========================================================= */
function createCharacter(scene, color, name) {
  const root = new BABYLON.TransformNode('char-' + name, scene);

  const cloth = new BABYLON.StandardMaterial('cloth-' + name, scene);
  cloth.diffuseColor = BABYLON.Color3.FromHexString(color);
  cloth.emissiveColor = BABYLON.Color3.FromHexString(color).scale(0.15);
  cloth.specularColor = new BABYLON.Color3(0.1, 0.1, 0.15);

  const skinMat = new BABYLON.StandardMaterial('skin-' + name, scene);
  skinMat.diffuseColor = new BABYLON.Color3(0.94, 0.78, 0.62);

  const pantsMat = new BABYLON.StandardMaterial('pants-' + name, scene);
  pantsMat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.14);

  const shoeMat = new BABYLON.StandardMaterial('shoe-' + name, scene);
  shoeMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.07);

  const hairMat = new BABYLON.StandardMaterial('hair-' + name, scene);
  hairMat.diffuseColor = new BABYLON.Color3(0.1, 0.07, 0.05);

  const torso = BABYLON.MeshBuilder.CreateBox('torso-' + name, { width: 0.55, height: 0.72, depth: 0.30 }, scene);
  torso.position.y = 1.06;
  torso.material = cloth;
  torso.parent = root;

  const hips = BABYLON.MeshBuilder.CreateBox('hips-' + name, { width: 0.52, height: 0.22, depth: 0.28 }, scene);
  hips.position.y = 0.62;
  hips.material = pantsMat;
  hips.parent = root;

  const head = BABYLON.MeshBuilder.CreateSphere('head-' + name, { diameter: 0.46, segments: 12 }, scene);
  head.position.y = 1.72;
  head.material = skinMat;
  head.parent = root;

  const hair = BABYLON.MeshBuilder.CreateSphere('hair-' + name, { diameter: 0.48, segments: 10 }, scene);
  hair.position.y = 1.80;
  hair.scaling.y = 0.75;
  hair.material = hairMat;
  hair.parent = root;

  function makeArm(side) {
    const pivot = new BABYLON.TransformNode('armPivot' + side + '-' + name, scene);
    pivot.parent = root;
    pivot.position.set(side * 0.38, 1.30, 0);
    const upper = BABYLON.MeshBuilder.CreateBox('arm-' + side + '-' + name, { width: 0.15, height: 0.72, depth: 0.16 }, scene);
    upper.position.y = -0.36;
    upper.material = cloth;
    upper.parent = pivot;
    const hand = BABYLON.MeshBuilder.CreateSphere('hand-' + side + '-' + name, { diameter: 0.16 }, scene);
    hand.position.y = -0.74;
    hand.material = skinMat;
    hand.parent = pivot;
    return pivot;
  }
  const armL = makeArm(-1);
  const armR = makeArm(1);

  function makeLeg(side) {
    const pivot = new BABYLON.TransformNode('legPivot' + side + '-' + name, scene);
    pivot.parent = root;
    pivot.position.set(side * 0.15, 0.60, 0);
    const leg = BABYLON.MeshBuilder.CreateBox('leg-' + side + '-' + name, { width: 0.19, height: 0.55, depth: 0.21 }, scene);
    leg.position.y = -0.28;
    leg.material = pantsMat;
    leg.parent = pivot;
    const shoe = BABYLON.MeshBuilder.CreateBox('shoe-' + side + '-' + name, { width: 0.21, height: 0.11, depth: 0.32 }, scene);
    shoe.position.set(0, -0.58, 0.04);
    shoe.material = shoeMat;
    shoe.parent = pivot;
    return pivot;
  }
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // Имя
  const dt = new BABYLON.DynamicTexture('nameTag-' + name, { width: 512, height: 128 }, scene, true);
  dt.hasAlpha = true;
  const ctx = dt.getContext();
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = 'bold 62px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 256, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, 256, 64);
  dt.update();

  const nameMat = new BABYLON.StandardMaterial('nameMat-' + name, scene);
  nameMat.diffuseTexture = dt;
  nameMat.opacityTexture = dt;
  nameMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  nameMat.disableLighting = true;
  nameMat.backFaceCulling = false;

  const namePlane = BABYLON.MeshBuilder.CreatePlane('namePlane-' + name, { width: 1.6, height: 0.4 }, scene);
  namePlane.material = nameMat;
  namePlane.position.y = 2.25;
  namePlane.parent = root;
  namePlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

  if (shadowGen) {
    shadowGen.addShadowCaster(torso);
    shadowGen.addShadowCaster(hips);
    shadowGen.addShadowCaster(head);
  }

  return { root, armL, armR, legL, legR, walkPhase: 0 };
}

function animateCharacter(char, moving, running, dt) {
  const speed = running ? 13 : 8.5;
  if (moving) char.walkPhase += dt * speed;
  else char.walkPhase *= Math.pow(0.0001, dt);
  const amp = moving ? (running ? 0.95 : 0.6) : 0;
  const swing = Math.sin(char.walkPhase) * amp;
  char.armL.rotation.x =  swing;
  char.armR.rotation.x = -swing;
  char.legL.rotation.x = -swing;
  char.legR.rotation.x =  swing;
}

/* =========================================================
   ЛОКАЛЬНЫЙ ИГРОК (без меша — камера от первого лица)
   ========================================================= */
function updateLocalPlayer(dt) {
  if (!state.inRoom) return;

  let ix = keyMove.x + joyMove.x;
  let iz = keyMove.y + joyMove.y;
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }

  // Направление вперёд/вправо относительно camYaw
  const fx = Math.sin(camYaw);
  const fz = Math.cos(camYaw);
  const rx = Math.cos(camYaw);
  const rz = -Math.sin(camYaw);

  const dx = fx * iz + rx * ix;
  const dz = fz * iz + rz * ix;

  const running = runningBtnHeld || !!keys['shift'];
  const speed = running ? 8.5 : 4.5;

  const nx = local.x + dx * speed * dt;
  const nz = local.z + dz * speed * dt;

  const pos = { x: nx, z: nz };
  resolveCollisions(pos);
  local.x = pos.x;
  local.z = pos.z;

  const moving = (Math.abs(dx) + Math.abs(dz)) > 0.001;
  local.moving = moving;
  local.running = running && moving;

  // Отправка на сервер (20 Hz)
  const now = performance.now();
  if (now - state.lastSent > 50) {
    state.lastSent = now;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'playerMoved',
        x: local.x, y: local.y, z: local.z,
        ry: camYaw,                 // тело смотрит туда, куда смотрит камера
        moving: local.moving,
        running: local.running,
      }));
    }
  }
}

function resolveCollisions(pos) {
  const r = 0.42;
  const limit = 14 - 0.3 / 2 - r;
  pos.x = clamp(pos.x, -limit, limit);
  pos.z = clamp(pos.z, -limit, limit);

  for (const o of OBSTACLES) {
    const cx = clamp(pos.x, o.minX, o.maxX);
    const cz = clamp(pos.z, o.minZ, o.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = r - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        const l = Math.abs(pos.x - o.minX);
        const rr = Math.abs(o.maxX - pos.x);
        const t = Math.abs(pos.z - o.minZ);
        const b = Math.abs(o.maxZ - pos.z);
        const m = Math.min(l, rr, t, b);
        if (m === l) pos.x = o.minX - r;
        else if (m === rr) pos.x = o.maxX + r;
        else if (m === t) pos.z = o.minZ - r;
        else pos.z = o.maxZ + r;
      }
    }
  }
}

/* =========================================================
   КАМЕРА — ПЕРВОЕ ЛИЦО
   ========================================================= */
function updateCamera() {
  if (!state.inRoom) return;
  camera.position.set(local.x, local.y + EYE_HEIGHT, local.z);
  const cp = Math.cos(camPitch);
  const tx = local.x + Math.sin(camYaw) * cp;
  const ty = local.y + EYE_HEIGHT + Math.sin(camPitch);
  const tz = local.z + Math.cos(camYaw) * cp;
  camera.setTarget(new BABYLON.Vector3(tx, ty, tz));
}

/* =========================================================
   УДАЛЁННЫЕ ИГРОКИ
   ========================================================= */
function spawnRemotePlayer(p) {
  if (remotePlayers.has(p.id)) return;
  const char = createCharacter(scene, p.color, p.name);
  char.root.position.set(p.x, p.y, p.z);
  char.root.rotation.y = p.ry || 0;
  remotePlayers.set(p.id, {
    id: p.id, char,
    tx: p.x, ty: p.y, tz: p.z, tryRy: p.ry || 0,
    moving: false, running: false,
  });
  playersInfo.set(p.id, { id: p.id, name: p.name, color: p.color });
  renderPlayersList();
}

function updateRemotePlayer(msg) {
  const r = remotePlayers.get(msg.id);
  if (!r) return;
  r.tx = msg.x; r.ty = msg.y; r.tz = msg.z;
  r.tryRy = msg.ry;
  r.moving = !!msg.moving;
  r.running = !!msg.running;
}

function removeRemotePlayer(id) {
  const r = remotePlayers.get(id);
  if (r) { r.char.root.dispose(false, true); remotePlayers.delete(id); }
  playersInfo.delete(id);
  renderPlayersList();
}

function updateRemotePlayers(dt) {
  const k = 1 - Math.pow(0.0001, dt);
  for (const r of remotePlayers.values()) {
    const p = r.char.root.position;
    p.x += (r.tx - p.x) * k;
    p.y += (r.ty - p.y) * k;
    p.z += (r.tz - p.z) * k;
    r.char.root.rotation.y = lerpAngle(r.char.root.rotation.y, r.tryRy, k);
    animateCharacter(r.char, r.moving, r.running, dt);
  }
}

/* =========================================================
   СПИСОК ИГРОКОВ
   ========================================================= */
function renderPlayersList() {
  const items = [];
  for (const info of playersInfo.values()) {
    const isMe = info.id === state.myId;
    items.push(
      '<li>' +
        '<span class="swatch" style="background:' + info.color + ';color:' + info.color + '"></span>' +
        '<span class="' + (isMe ? 'me' : '') + '">' + escapeHtml(info.name) + (isMe ? ' (вы)' : '') + '</span>' +
      '</li>'
    );
  }
  playersListEl.innerHTML = items.join('');
  playersCountEl.textContent = String(playersInfo.size);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* =========================================================
   WEBSOCKET
   ========================================================= */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}

function connectAnd(action, payload) {
  setError('');
  setConnectionIndicator('connecting', 'Подключение…');

  let ws;
  try { ws = new WebSocket(wsUrl()); }
  catch (e) { setError('Не удалось открыть WebSocket'); setConnectionIndicator('offline', 'Ошибка'); return; }

  state.ws = ws;
  state.wantReconnect = true;

  ws.addEventListener('open', () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    setConnectionIndicator('online', 'Подключено');
    setInGameConn('online', true);
    ws.send(JSON.stringify(action === 'create'
      ? { type: 'createRoom', name: payload.name }
      : { type: 'joinRoom', name: payload.name, code: payload.code }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setConnectionIndicator('offline', 'Отключено');
    setInGameConn('offline', false);
    if (state.inRoom && state.wantReconnect) scheduleReconnect(payload);
  });

  ws.addEventListener('error', () => {});
}

function scheduleReconnect(payload) {
  if (state.reconnectAttempts >= 8) {
    showNotification('Соединение потеряно. Выход из комнаты.');
    hardLeave();
    return;
  }
  state.reconnectAttempts++;
  showNotification('Переподключение… (' + state.reconnectAttempts + ')');
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (payload.code) connectAnd('join', payload);
    else hardLeave();
  }, Math.min(1000 * state.reconnectAttempts, 5000));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.id;
      break;

    case 'roomState': {
      state.myId = msg.you.id;
      state.roomCode = msg.code;
      state.inRoom = true;
      state.playerName = msg.you.name;

      for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
      playersInfo.clear();

      for (const p of msg.players) {
        if (p.id === state.myId) {
          local.x = p.x; local.y = p.y; local.z = p.z;
          // Начальная ориентация камеры — куда смотрел персонаж при спавне
          camYaw = p.ry || 0;
          camPitch = 0;
          playersInfo.set(p.id, { id: p.id, name: p.name, color: p.color });
        } else {
          spawnRemotePlayer(p);
        }
      }

      roomCodeEl.textContent = state.roomCode;
      localNameEl.textContent = state.playerName;
      renderPlayersList();

      menuEl.classList.add('hidden');
      gameEl.classList.remove('hidden');
      joystickEl.classList.toggle('hidden', !isTouch);
      runBtn.classList.toggle('hidden', !isTouch);

      engine.resize();
      setTimeout(() => engine.resize(), 100);
      break;
    }

    case 'playerJoined':
      spawnRemotePlayer(msg.player);
      showNotification(msg.player.name + ' подключился');
      break;

    case 'playerMoved':
      updateRemotePlayer(msg);
      break;

    case 'playerLeft': {
      const info = playersInfo.get(msg.id);
      removeRemotePlayer(msg.id);
      if (info) showNotification(info.name + ' покинул комнату');
      break;
    }

    case 'error':
      setError(msg.message || 'Ошибка сервера');
      setConnectionIndicator('offline', 'Ошибка');
      if (!state.inRoom && state.ws) {
        state.wantReconnect = false;
        try { state.ws.close(); } catch (_) {}
      }
      break;

    case 'pong':
      break;
  }
}

/* =========================================================
   УПРАВЛЕНИЕ
   ========================================================= */
function setupInput() {
  // Клавиатура
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (['w','a','s','d',' '].includes(k)) e.preventDefault();
    updateKeyMove();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    keys[k] = false;
    updateKeyMove();
  });
  window.addEventListener('blur', () => {
    for (const k of Object.keys(keys)) keys[k] = false;
    updateKeyMove();
  });
  function updateKeyMove() {
    keyMove.x = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
    keyMove.y = (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0);
  }

  // ---------- Обзор: мышь + свайп ----------
  // Свайп влево -> смотрим влево. Свайп вверх -> смотрим вверх.
  let dragging = false;
  let dragId = null;
  let lastX = 0, lastY = 0;
  const LOOK_SENS = isTouch ? 0.006 : 0.0035;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.inRoom) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const rect = canvas.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      // Игнор левой нижней зоны (там джойстик)
      if (lx < 200 && ly > rect.height - 220) return;
    }
    dragging = true;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // ИСПРАВЛЕНО: свайп влево (dx<0) -> смотрим влево (yaw уменьшается).
    camYaw += dx * LOOK_SENS;
    // ИСПРАВЛЕНО: свайп вверх (dy<0) -> смотрим вверх (pitch увеличивается).
    camPitch = clamp(camPitch - dy * LOOK_SENS, PITCH_MIN, PITCH_MAX);
  });

  function endDrag(e) {
    if (e.pointerId !== dragId) return;
    dragging = false;
    dragId = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', endDrag);

  // ---------- Джойстик ----------
  let joyActive = false;
  let joyId = null;
  const joyRect = () => joystickEl.getBoundingClientRect();

  joystickEl.addEventListener('pointerdown', (e) => {
    if (!state.inRoom) return;
    joyActive = true;
    joyId = e.pointerId;
    try { joystickEl.setPointerCapture(e.pointerId); } catch (_) {}
    updateJoy(e);
  });
  joystickEl.addEventListener('pointermove', (e) => {
    if (!joyActive || e.pointerId !== joyId) return;
    updateJoy(e);
  });
  function joyEnd(e) {
    if (!joyActive || e.pointerId !== joyId) return;
    joyActive = false;
    joyId = null;
    joyMove.x = 0;
    joyMove.y = 0;
    joystickKnob.style.left = '50%';
    joystickKnob.style.top = '50%';
  }
  joystickEl.addEventListener('pointerup', joyEnd);
  joystickEl.addEventListener('pointercancel', joyEnd);
  joystickEl.addEventListener('pointerleave', joyEnd);

  function updateJoy(e) {
    const r = joyRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const max = r.width / 2 - 14;
    const dist = Math.hypot(dx, dy);
    if (dist > max) { dx = (dx / dist) * max; dy = (dy / dist) * max; }
    joystickKnob.style.left = (r.width / 2 + dx) + 'px';
    joystickKnob.style.top  = (r.height / 2 + dy) + 'px';
    joyMove.x = dx / max;
    joyMove.y = -dy / max;
  }

  // ---------- Кнопка RUN ----------
  runBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    runningBtnHeld = true;
    runBtn.classList.add('active');
    try { runBtn.setPointerCapture(e.pointerId); } catch (_) {}
  });
  const stopRun = () => { runningBtnHeld = false; runBtn.classList.remove('active'); };
  runBtn.addEventListener('pointerup', stopRun);
  runBtn.addEventListener('pointercancel', stopRun);
  runBtn.addEventListener('pointerleave', stopRun);

  // Запрет скролла/зума
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => { if (state.inRoom) e.preventDefault(); });
  document.addEventListener('touchmove', (e) => {
    if (state.inRoom && e.target !== nameInput && e.target !== roomInput) {
      e.preventDefault();
    }
  }, { passive: false });
}

/* =========================================================
   UI
   ========================================================= */
function setupUi() {
  createBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim();
    if (!name) { setError('Введите имя'); return; }
    connectAnd('create', { name });
  });

  joinBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim();
    const code = (roomInput.value || '').trim().toUpperCase();
    if (!name) { setError('Введите имя'); return; }
    if (!/^[A-Z0-9]{5}$/.test(code)) { setError('Код комнаты — 5 символов'); return; }
    connectAnd('join', { name, code });
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  nameInput.addEventListener('input', () => {
    nameInput.value = nameInput.value.slice(0, 20);
  });

  copyBtn.addEventListener('click', async () => {
    const code = state.roomCode || '';
    if (!code) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showNotification('Код скопирован: ' + code);
    } catch (_) {
      showNotification('Код: ' + code);
    }
  });

  leaveBtn.addEventListener('click', () => hardLeave());

  try {
    const saved = localStorage.getItem('mp_name');
    if (saved) nameInput.value = saved;
  } catch (_) {}
  nameInput.addEventListener('change', () => {
    try { localStorage.setItem('mp_name', nameInput.value); } catch (_) {}
  });
}

function hardLeave() {
  state.wantReconnect = false;
  state.reconnectAttempts = 0;
  clearTimeout(state.reconnectTimer);

  if (state.ws) {
    try { state.ws.close(); } catch (_) {}
    state.ws = null;
  }

  for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
  playersInfo.clear();
  playersListEl.innerHTML = '';
  playersCountEl.textContent = '0';

  state.inRoom = false;
  state.roomCode = null;
  state.myId = null;

  gameEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  joystickEl.classList.add('hidden');
  runBtn.classList.add('hidden');
  setConnectionIndicator('offline', 'Не подключено');
  setError('');

  engine.resize();
}

/* =========================================================
   HEARTBEAT
   ========================================================= */
setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (_) {}
  }
}, 25000);

/* =========================================================
   СТАРТ
   ========================================================= */
window.addEventListener('load', () => {
  initBabylon();
  setupInput();
  setupUi();
  setConnectionIndicator('offline', 'Не подключено');
});

})();
