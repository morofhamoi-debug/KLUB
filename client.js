/* =========================================================
   client.js — Babylon.js 3D сцена, персонажи, камера, WebSocket
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

let camYaw = 0;
let camPitch = 0.28;
const CAM_DIST = isMobile ? 5.2 : 6.0;
const CAM_TARGET_H = 1.55;

/* ==================== Babylon ==================== */
let engine, scene, camera, shadowGen;
let localChar = null;
const local = {
  x: 0, y: 0, z: 0, ry: 0,
  moving: false, running: false,
  walkPhase: 0,
};

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
   BABYLON — ИНИЦИАЛИЗАЦИЯ СЦЕНЫ
   ========================================================= */
function initBabylon() {
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true);
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.04, 0.08, 1);
  scene.ambientColor = new BABYLON.Color3(0.28, 0.28, 0.34);
  scene.collisionsEnabled = false;

  camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, 3, -6), scene);
  camera.minZ = 0.1;
  camera.maxZ = 120;
  camera.fov = 1.0;
  camera.inertia = 0;
  camera.speed = 0;

  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.75;
  hemi.diffuse = new BABYLON.Color3(0.85, 0.88, 1);
  hemi.groundColor = new BABYLON.Color3(0.14, 0.14, 0.18);

  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.55, -1, -0.4), scene);
  dir.position = new BABYLON.Vector3(10, 18, 10);
  dir.intensity = 0.7;

  if (!isMobile) {
    shadowGen = new BABYLON.ShadowGenerator(1024, dir);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 12;
    shadowGen.darkness = 0.55;
  }

  buildRoom(scene);

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    updateLocalPlayer(dt);
    updateRemotePlayers(dt);
    updateCamera(dt);
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => engine.resize(), 250));
}

/* =========================================================
   ПОСТРОЕНИЕ 3D-КОМНАТЫ
   ========================================================= */
function buildRoom(scene) {
  const P = 14; // половина стороны комнаты
  const H = 4;  // высота

  // Материалы
  const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
  floorMat.diffuseColor = new BABYLON.Color3(0.22, 0.22, 0.28);
  floorMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.08);

  const ceilMat = new BABYLON.StandardMaterial('ceilMat', scene);
  ceilMat.diffuseColor = new BABYLON.Color3(0.13, 0.13, 0.17);

  const wallMat = new BABYLON.StandardMaterial('wallMat', scene);
  wallMat.diffuseColor = new BABYLON.Color3(0.30, 0.30, 0.37);
  wallMat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.06);

  const doorMat = new BABYLON.StandardMaterial('doorMat', scene);
  doorMat.diffuseColor = new BABYLON.Color3(0.38, 0.24, 0.14);

  const glassMat = new BABYLON.StandardMaterial('glassMat', scene);
  glassMat.diffuseColor = new BABYLON.Color3(0.28, 0.55, 0.85);
  glassMat.emissiveColor = new BABYLON.Color3(0.10, 0.30, 0.55);
  glassMat.specularColor = new BABYLON.Color3(0.6, 0.6, 0.7);

  const woodMat = new BABYLON.StandardMaterial('woodMat', scene);
  woodMat.diffuseColor = new BABYLON.Color3(0.42, 0.28, 0.16);

  const darkWoodMat = new BABYLON.StandardMaterial('darkWoodMat', scene);
  darkWoodMat.diffuseColor = new BABYLON.Color3(0.26, 0.17, 0.10);

  const sofaMat = new BABYLON.StandardMaterial('sofaMat', scene);
  sofaMat.diffuseColor = new BABYLON.Color3(0.18, 0.22, 0.42);

  const cushionMat = new BABYLON.StandardMaterial('cushionMat', scene);
  cushionMat.diffuseColor = new BABYLON.Color3(0.30, 0.38, 0.62);

  const rugMat = new BABYLON.StandardMaterial('rugMat', scene);
  rugMat.diffuseColor = new BABYLON.Color3(0.42, 0.14, 0.28);

  const metalMat = new BABYLON.StandardMaterial('metalMat', scene);
  metalMat.diffuseColor = new BABYLON.Color3(0.55, 0.55, 0.60);
  metalMat.specularColor = new BABYLON.Color3(0.8, 0.8, 0.85);

  const plantMat = new BABYLON.StandardMaterial('plantMat', scene);
  plantMat.diffuseColor = new BABYLON.Color3(0.14, 0.45, 0.20);

  const potMat = new BABYLON.StandardMaterial('potMat', scene);
  potMat.diffuseColor = new BABYLON.Color3(0.35, 0.18, 0.12);

  const tvMat = new BABYLON.StandardMaterial('tvMat', scene);
  tvMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.07);
  tvMat.emissiveColor = new BABYLON.Color3(0.05, 0.08, 0.16);

  // ===== Пол =====
  const floor = BABYLON.MeshBuilder.CreateBox('floor', { width: P * 2, height: 0.2, depth: P * 2 }, scene);
  floor.position.y = -0.1;
  floor.material = floorMat;
  floor.receiveShadows = true;

  // ===== Потолок =====
  const ceiling = BABYLON.MeshBuilder.CreateBox('ceiling', { width: P * 2, height: 0.2, depth: P * 2 }, scene);
  ceiling.position.y = H + 0.1;
  ceiling.material = ceilMat;

  // ===== Стены =====
  const wallT = 0.3;
  const walls = [
    { name: 'wallN', w: P * 2 + wallT * 2, d: wallT, x: 0, z: -P },
    { name: 'wallS', w: P * 2 + wallT * 2, d: wallT, x: 0, z:  P },
    { name: 'wallW', w: wallT, d: P * 2, x: -P, z: 0 },
    { name: 'wallE', w: wallT, d: P * 2, x:  P, z: 0 },
  ];
  for (const w of walls) {
    const m = BABYLON.MeshBuilder.CreateBox(w.name, { width: w.w, height: H, depth: w.d }, scene);
    m.position.set(w.x, H / 2, w.z);
    m.material = wallMat;
    m.receiveShadows = true;
  }

  // ===== Дверь на северной стене =====
  const door = BABYLON.MeshBuilder.CreateBox('door', { width: 1.7, height: 2.9, depth: 0.08 }, scene);
  door.position.set(0, 1.45, -P + wallT / 2 + 0.05);
  door.material = doorMat;
  const doorFrame = BABYLON.MeshBuilder.CreateBox('doorFrame', { width: 1.95, height: 3.1, depth: 0.05 }, scene);
  doorFrame.position.set(0, 1.55, -P + wallT / 2 - 0.01);
  doorFrame.material = darkWoodMat;
  const knob = BABYLON.MeshBuilder.CreateSphere('knob', { diameter: 0.11 }, scene);
  knob.position.set(0.65, 1.45, -P + wallT / 2 + 0.11);
  knob.material = metalMat;

  // ===== Окна =====
  const windows = [
    { x: -P + wallT / 2 + 0.02, z: -6, ry:  Math.PI / 2 },
    { x: -P + wallT / 2 + 0.02, z:  6, ry:  Math.PI / 2 },
    { x:  P - wallT / 2 - 0.02, z: -6, ry: -Math.PI / 2 },
    { x:  P - wallT / 2 - 0.02, z:  6, ry: -Math.PI / 2 },
  ];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const glass = BABYLON.MeshBuilder.CreatePlane('glass' + i, { width: 3.2, height: 1.9 }, scene);
    glass.position.set(w.x, 2.0, w.z);
    glass.rotation.y = w.ry;
    glass.material = glassMat;
    // рама
    const frame = BABYLON.MeshBuilder.CreateBox('frame' + i, { width: 3.4, height: 2.1, depth: 0.05 }, scene);
    frame.position.set(w.x - Math.sign(w.x) * 0.03, 2.0, w.z);
    frame.rotation.y = w.ry;
    frame.material = darkWoodMat;
  }

  // ===== Ковёр =====
  const rug = BABYLON.MeshBuilder.CreateBox('rug', { width: 6, height: 0.03, depth: 4.5 }, scene);
  rug.position.set(-6, 0.015, -6);
  rug.material = rugMat;

  // ===== Диван =====
  const sofaBase = BABYLON.MeshBuilder.CreateBox('sofaBase', { width: 3.2, height: 0.5, depth: 1.3 }, scene);
  sofaBase.position.set(-6, 0.35, -7);
  sofaBase.material = sofaMat;
  const sofaBack = BABYLON.MeshBuilder.CreateBox('sofaBack', { width: 3.2, height: 0.9, depth: 0.3 }, scene);
  sofaBack.position.set(-6, 0.85, -7.5);
  sofaBack.material = sofaMat;
  for (let i = 0; i < 3; i++) {
    const c = BABYLON.MeshBuilder.CreateBox('cushion' + i, { width: 0.9, height: 0.15, depth: 1.0 }, scene);
    c.position.set(-7.0 + i * 1.0, 0.68, -7.0);
    c.material = cushionMat;
  }
  const armL = BABYLON.MeshBuilder.CreateBox('armL', { width: 0.3, height: 0.7, depth: 1.3 }, scene);
  armL.position.set(-7.75, 0.55, -7);
  armL.material = sofaMat;
  const armR = BABYLON.MeshBuilder.CreateBox('armR', { width: 0.3, height: 0.7, depth: 1.3 }, scene);
  armR.position.set(-4.25, 0.55, -7);
  armR.material = sofaMat;
  OBSTACLES.push({ minX: -7.95, maxX: -4.05, minZ: -7.7, maxZ: -6.3 });

  // ===== Журнальный столик =====
  const table = BABYLON.MeshBuilder.CreateBox('coffee', { width: 1.8, height: 0.1, depth: 1.0 }, scene);
  table.position.set(-6, 0.45, -4);
  table.material = darkWoodMat;
  const legPositions = [
    [-0.78, -0.4], [0.78, -0.4], [-0.78, 0.4], [0.78, 0.4],
  ];
  for (let i = 0; i < legPositions.length; i++) {
    const lp = legPositions[i];
    const leg = BABYLON.MeshBuilder.CreateBox('coffeeLeg' + i, { width: 0.08, height: 0.45, depth: 0.08 }, scene);
    leg.position.set(-6 + lp[0], 0.22, -4 + lp[1]);
    leg.material = darkWoodMat;
  }
  OBSTACLES.push({ minX: -6.9, maxX: -5.1, minZ: -4.5, maxZ: -3.5 });

  // ===== ТВ на северной стене =====
  const tv = BABYLON.MeshBuilder.CreateBox('tv', { width: 3.2, height: 1.8, depth: 0.1 }, scene);
  tv.position.set(-6, 1.6, -P + wallT / 2 + 0.1);
  tv.material = tvMat;
  const tvStand = BABYLON.MeshBuilder.CreateBox('tvStand', { width: 4, height: 0.5, depth: 0.4 }, scene);
  tvStand.position.set(-6, 0.25, -P + wallT / 2 + 0.3);
  tvStand.material = darkWoodMat;
  OBSTACLES.push({ minX: -8, maxX: -4, minZ: -P + 0.2, maxZ: -P + 0.6 });

  // ===== Обеденный стол =====
  const dTable = BABYLON.MeshBuilder.CreateBox('dTable', { width: 2.6, height: 0.12, depth: 1.6 }, scene);
  dTable.position.set(6, 0.82, 6);
  dTable.material = woodMat;
  for (let i = 0; i < 4; i++) {
    const dx = (i % 2 === 0 ? -1 : 1) * 1.15;
    const dz = (i < 2 ? -1 : 1) * 0.65;
    const leg = BABYLON.MeshBuilder.CreateBox('dLeg' + i, { width: 0.1, height: 0.8, depth: 0.1 }, scene);
    leg.position.set(6 + dx, 0.4, 6 + dz);
    leg.material = darkWoodMat;
  }
  OBSTACLES.push({ minX: 4.6, maxX: 7.4, minZ: 5.1, maxZ: 6.9 });

  // ===== Стулья =====
  function makeChair(x, z, ry) {
    const seat = BABYLON.MeshBuilder.CreateBox('chairSeat', { width: 0.55, height: 0.08, depth: 0.55 }, scene);
    seat.position.set(x, 0.5, z);
    seat.rotation.y = ry;
    seat.material = woodMat;
    const back = BABYLON.MeshBuilder.CreateBox('chairBack', { width: 0.55, height: 0.6, depth: 0.08 }, scene);
    back.position.set(x, 0.82, z);
    back.rotation.y = ry;
    back.translate(BABYLON.Axis.Z, -0.23, BABYLON.Space.LOCAL);
    back.material = woodMat;
    for (let i = 0; i < 4; i++) {
      const dx = (i % 2 === 0 ? -1 : 1) * 0.22;
      const dz = (i < 2 ? -1 : 1) * 0.22;
      const leg = BABYLON.MeshBuilder.CreateBox('chairLeg', { width: 0.05, height: 0.5, depth: 0.05 }, scene);
      leg.position.set(x, 0.25, z);
      leg.rotation.y = ry;
      leg.translate(BABYLON.Axis.X, dx, BABYLON.Space.LOCAL);
      leg.translate(BABYLON.Axis.Z, dz, BABYLON.Space.LOCAL);
      leg.material = darkWoodMat;
    }
    OBSTACLES.push({ minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 });
  }
  makeChair(4.3, 6, -Math.PI / 2);
  makeChair(7.7, 6,  Math.PI / 2);
  makeChair(6, 4.3, 0);
  makeChair(6, 7.7, Math.PI);

  // ===== Книжный шкаф =====
  const shelf = BABYLON.MeshBuilder.CreateBox('shelf', { width: 0.5, height: 2.4, depth: 2.2 }, scene);
  shelf.position.set(P - 0.55, 1.2, -8);
  shelf.material = darkWoodMat;
  for (let i = 0; i < 4; i++) {
    const bookRow = BABYLON.MeshBuilder.CreateBox('books' + i, { width: 0.4, height: 0.32, depth: 1.9 }, scene);
    bookRow.position.set(P - 0.55, 0.55 + i * 0.55, -8);
    const bm = new BABYLON.StandardMaterial('bm' + i, scene);
    const hue = 0.05 + i * 0.16;
    bm.diffuseColor = BABYLON.Color3.FromHSV(hue * 360, 0.55, 0.85);
    bookRow.material = bm;
  }
  OBSTACLES.push({ minX: P - 0.85, maxX: P - 0.25, minZ: -9.15, maxZ: -6.85 });

  // ===== Растение в горшке =====
  const pot = BABYLON.MeshBuilder.CreateCylinder('pot', { diameterTop: 0.6, diameterBottom: 0.45, height: 0.5 }, scene);
  pot.position.set(11.5, 0.25, -11.5);
  pot.material = potMat;
  for (let i = 0; i < 6; i++) {
    const leaf = BABYLON.MeshBuilder.CreateSphere('leaf' + i, { diameter: 0.7, segments: 6 }, scene);
    const a = (i / 6) * Math.PI * 2;
    leaf.position.set(11.5 + Math.cos(a) * 0.35, 0.9 + Math.sin(i) * 0.15, -11.5 + Math.sin(a) * 0.35);
    leaf.material = plantMat;
    leaf.scaling.y = 1.4;
  }
  OBSTACLES.push({ minX: 11.0, maxX: 12.0, minZ: -12.0, maxZ: -11.0 });

  // ===== Люстра =====
  const lampRod = BABYLON.MeshBuilder.CreateCylinder('lampRod', { diameter: 0.06, height: 0.4 }, scene);
  lampRod.position.set(0, H - 0.2, 0);
  lampRod.material = metalMat;
  const lamp = BABYLON.MeshBuilder.CreateSphere('lamp', { diameter: 0.5 }, scene);
  lamp.position.set(0, H - 0.5, 0);
  const lampMat = new BABYLON.StandardMaterial('lampMat', scene);
  lampMat.emissiveColor = new BABYLON.Color3(1, 0.92, 0.75);
  lampMat.diffuseColor = new BABYLON.Color3(1, 0.92, 0.75);
  lamp.material = lampMat;
  const pointLight = new BABYLON.PointLight('pl', new BABYLON.Vector3(0, H - 0.6, 0), scene);
  pointLight.intensity = 0.5;
  pointLight.diffuse = new BABYLON.Color3(1, 0.9, 0.75);
  pointLight.range = 18;

  // ===== Кресло-пуфы =====
  const poufPositions = [[3, -3], [-3, 3], [3, 3]];
  for (const [px, pz] of poufPositions) {
    const pouf = BABYLON.MeshBuilder.CreateCylinder('pouf', { diameter: 0.9, height: 0.5 }, scene);
    pouf.position.set(px, 0.25, pz);
    const pm = new BABYLON.StandardMaterial('poufM' + px + '_' + pz, scene);
    pm.diffuseColor = new BABYLON.Color3(0.55, 0.30, 0.55);
    pouf.material = pm;
    OBSTACLES.push({ minX: px - 0.5, maxX: px + 0.5, minZ: pz - 0.5, maxZ: pz + 0.5 });
  }
}

/* =========================================================
   ПЕРСОНАЖ
   ========================================================= */
function createCharacter(scene, color, name) {
  const root = new BABYLON.TransformNode('char-' + name, scene);

  const cloth = new BABYLON.StandardMaterial('cloth-' + name, scene);
  cloth.diffuseColor = BABYLON.Color3.FromHexString(color);
  cloth.specularColor = new BABYLON.Color3(0.08, 0.08, 0.1);

  const skinMat = new BABYLON.StandardMaterial('skin-' + name, scene);
  skinMat.diffuseColor = new BABYLON.Color3(0.94, 0.78, 0.62);

  const pantsMat = new BABYLON.StandardMaterial('pants-' + name, scene);
  pantsMat.diffuseColor = new BABYLON.Color3(0.16, 0.16, 0.22);

  const shoeMat = new BABYLON.StandardMaterial('shoe-' + name, scene);
  shoeMat.diffuseColor = new BABYLON.Color3(0.09, 0.09, 0.12);

  const hairMat = new BABYLON.StandardMaterial('hair-' + name, scene);
  hairMat.diffuseColor = new BABYLON.Color3(0.15, 0.10, 0.07);

  // Туловище
  const torso = BABYLON.MeshBuilder.CreateBox('torso-' + name, { width: 0.55, height: 0.72, depth: 0.30 }, scene);
  torso.position.y = 1.06;
  torso.material = cloth;
  torso.parent = root;

  // Бёдра
  const hips = BABYLON.MeshBuilder.CreateBox('hips-' + name, { width: 0.52, height: 0.22, depth: 0.28 }, scene);
  hips.position.y = 0.62;
  hips.material = pantsMat;
  hips.parent = root;

  // Голова
  const head = BABYLON.MeshBuilder.CreateSphere('head-' + name, { diameter: 0.46, segments: 12 }, scene);
  head.position.y = 1.72;
  head.material = skinMat;
  head.parent = root;

  // Волосы
  const hair = BABYLON.MeshBuilder.CreateSphere('hair-' + name, { diameter: 0.48, segments: 10 }, scene);
  hair.position.y = 1.80;
  hair.scaling.y = 0.75;
  hair.material = hairMat;
  hair.parent = root;

  // Руки (пивот в плече)
  function makeLimb(side) {
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
  const armL = makeLimb(-1);
  const armR = makeLimb(1);

  // Ноги (пивот в бедре)
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

  // Имя над головой
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

  const meshes = [torso, hips, head, hair, namePlane];
  if (shadowGen) {
    shadowGen.addShadowCaster(torso);
    shadowGen.addShadowCaster(hips);
    shadowGen.addShadowCaster(head);
  }

  return { root, armL, armR, legL, legR, walkPhase: 0 };
}

function animateCharacter(char, moving, running, dt) {
  const speed = running ? 13 : 8.5;
  if (moving) {
    char.walkPhase += dt * speed;
  } else {
    char.walkPhase *= Math.pow(0.0001, dt);
  }
  const amp = moving ? (running ? 0.95 : 0.6) : 0;
  const swing = Math.sin(char.walkPhase) * amp;
  char.armL.rotation.x =  swing;
  char.armR.rotation.x = -swing;
  char.legL.rotation.x = -swing;
  char.legR.rotation.x =  swing;
}

/* =========================================================
   ЛОКАЛЬНЫЙ ИГРОК
   ========================================================= */
function updateLocalPlayer(dt) {
  if (!localChar || !state.inRoom) return;

  // Итоговый вектор движения
  let ix = keyMove.x + joyMove.x;
  let iz = keyMove.y + joyMove.y;
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }

  // Направление относительно камеры
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

  // Коллизии
  const pos = { x: nx, z: nz };
  resolveCollisions(pos);

  local.x = pos.x;
  local.z = pos.z;

  const moving = (Math.abs(dx) + Math.abs(dz)) > 0.001;
  local.moving = moving;
  local.running = running && moving;

  if (moving) {
    const targetRy = Math.atan2(dx, dz);
    local.ry = lerpAngle(local.ry, targetRy, 1 - Math.pow(0.0001, dt));
  }

  // Обновляем меш
  localChar.root.position.set(local.x, local.y, local.z);
  localChar.root.rotation.y = local.ry;
  animateCharacter(localChar, local.moving, local.running, dt);

  // Сетевые апдейты
  const now = performance.now();
  if (now - state.lastSent > 50) {
    state.lastSent = now;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'playerMoved',
        x: local.x, y: local.y, z: local.z, ry: local.ry,
        moving: local.moving, running: local.running,
      }));
    }
  }
}

function resolveCollisions(pos) {
  const r = 0.42;
  // Границы комнаты
  const P = 14 - 0.3 / 2 - r;
  pos.x = clamp(pos.x, -P, P);
  pos.z = clamp(pos.z, -P, P);

  // Столкновения с мебелью
  for (const o of OBSTACLES) {
    const cx = clamp(pos.x, o.minX, o.maxX);
    const cz = clamp(pos.z, o.minZ, o.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const push = r - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        // внутри бокса — выталкиваем по ближайшей стороне
        const left = Math.abs(pos.x - o.minX);
        const right = Math.abs(o.maxX - pos.x);
        const top = Math.abs(pos.z - o.minZ);
        const bot = Math.abs(o.maxZ - pos.z);
        const m = Math.min(left, right, top, bot);
        if (m === left) pos.x = o.minX - r;
        else if (m === right) pos.x = o.maxX + r;
        else if (m === top) pos.z = o.minZ - r;
        else pos.z = o.maxZ + r;
      }
    }
  }
}

/* =========================================================
   КАМЕРА
   ========================================================= */
let camCurrent = new BABYLON.Vector3(0, 3, -6);
let camTarget = new BABYLON.Vector3(0, 1.5, 0);

function updateCamera(dt) {
  if (!localChar) return;
  const px = local.x, py = local.y, pz = local.z;

  const fwdX = Math.sin(camYaw) * Math.cos(camPitch);
  const fwdY = Math.sin(camPitch);
  const fwdZ = Math.cos(camYaw) * Math.cos(camPitch);

  const wantTarget = new BABYLON.Vector3(px, py + CAM_TARGET_H, pz);
  const wantPos = new BABYLON.Vector3(
    px - fwdX * CAM_DIST,
    py + CAM_TARGET_H - fwdY * CAM_DIST + 0.15,
    pz - fwdZ * CAM_DIST
  );

  const k = 1 - Math.pow(0.0001, dt);
  camCurrent = BABYLON.Vector3.Lerp(camCurrent, wantPos, k);
  camTarget  = BABYLON.Vector3.Lerp(camTarget, wantTarget, k);

  camera.position.copyFrom(camCurrent);
  camera.setTarget(camTarget);
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
    id: p.id,
    char,
    tx: p.x, ty: p.y, tz: p.z,
    try: p.ry || 0,
    moving: false,
    running: false,
  });
  playersInfo.set(p.id, { id: p.id, name: p.name, color: p.color });
  renderPlayersList();
}

function updateRemotePlayer(msg) {
  const r = remotePlayers.get(msg.id);
  if (!r) return;
  r.tx = msg.x;
  r.ty = msg.y;
  r.tz = msg.z;
  r.try = msg.ry;
  r.moving = !!msg.moving;
  r.running = !!msg.running;
}

function removeRemotePlayer(id) {
  const r = remotePlayers.get(id);
  if (r) {
    r.char.root.dispose(false, true);
    remotePlayers.delete(id);
  }
  playersInfo.delete(id);
  renderPlayersList();
}

function updateRemotePlayers(dt) {
  const k = 1 - Math.pow(0.0001, dt);
  for (const r of remotePlayers.values()) {
    r.char.root.position.x += (r.tx - r.char.root.position.x) * k;
    r.char.root.position.y += (r.ty - r.char.root.position.y) * k;
    r.char.root.position.z += (r.tz - r.char.root.position.z) * k;
    r.char.root.rotation.y = lerpAngle(r.char.root.rotation.y, r.try, k);
    animateCharacter(r.char, r.moving, r.running, dt);
  }
}

/* =========================================================
   РЕНДЕР СПИСКА ИГРОКОВ
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
    if (state.inRoom && state.wantReconnect) {
      scheduleReconnect(payload);
    }
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
    // Пробуем войти заново: если есть код — join, иначе create невозможен
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

      // Очищаем удалённых
      for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
      playersInfo.clear();

      let found = false;
      for (const p of msg.players) {
        if (p.id === state.myId) {
          local.x = p.x; local.y = p.y; local.z = p.z; local.ry = p.ry;
          localChar = createCharacter(scene, msg.you.color, msg.you.name);
          localChar.root.position.set(local.x, local.y, local.z);
          localChar.root.rotation.y = local.ry;
          playersInfo.set(p.id, { id: p.id, name: p.name, color: p.color });
          found = true;
        } else {
          spawnRemotePlayer(p);
        }
      }
      if (!found) {
        // fallback
        localChar = createCharacter(scene, msg.you.color, msg.you.name);
      }

      roomCodeEl.textContent = state.roomCode;
      localNameEl.textContent = state.playerName;
      renderPlayersList();

      // Переключаем экран
      menuEl.classList.add('hidden');
      gameEl.classList.remove('hidden');
      joystickEl.classList.toggle('hidden', !isTouch);
      runBtn.classList.toggle('hidden', !isTouch);

      // Сброс позиции камеры
      camCurrent = new BABYLON.Vector3(local.x, 3, local.z - 6);
      camTarget  = new BABYLON.Vector3(local.x, 1.5, local.z);

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
      // Если не в комнате — закрываем соединение
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
  // ---------- Клавиатура ----------
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

  // ---------- Мышь / свайп камеры ----------
  let dragging = false;
  let dragId = null;
  let lastX = 0, lastY = 0;
  const LOOK_SENS = isTouch ? 0.006 : 0.0035;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.inRoom) return;
    // На тач-устройствах: если попали в область джойстика — обработает сам джойстик
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const rect = canvas.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      // Нижний левый угол — джойстик, не начинаем вращение
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
    camYaw   -= dx * LOOK_SENS;
    camPitch  = clamp(camPitch + dy * LOOK_SENS, -0.6, 1.05);
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
    joystickEl.setPointerCapture(e.pointerId);
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
    runBtn.setPointerCapture(e.pointerId);
  });
  const stopRun = () => { runningBtnHeld = false; runBtn.classList.remove('active'); };
  runBtn.addEventListener('pointerup', stopRun);
  runBtn.addEventListener('pointercancel', stopRun);
  runBtn.addEventListener('pointerleave', stopRun);

  // ---------- Запрет скролла/зума на тач ----------
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (state.inRoom) e.preventDefault();
  });
  document.addEventListener('touchmove', (e) => {
    if (state.inRoom && e.target !== nameInput && e.target !== roomInput) {
      e.preventDefault();
    }
  }, { passive: false });
}

/* =========================================================
   UI: кнопки меню и HUD
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

  leaveBtn.addEventListener('click', () => { hardLeave(); });

  // автосохранение имени
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

  // Убираем чужих игроков
  for (const id of [...remotePlayers.keys()]) removeRemotePlayer(id);
  playersInfo.clear();
  playersListEl.innerHTML = '';
  playersCountEl.textContent = '0';

  // Убираем локального
  if (localChar) {
    localChar.root.dispose(false, true);
    localChar = null;
  }

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
   HEARTBEAT (клиент)
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
