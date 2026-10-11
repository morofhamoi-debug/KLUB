# 3D Online Multiplayer Room (HTML5 + Babylon.js + Node.js)

Многопользовательская 3D-игра в браузере. Работает через **один Web Service на Render**.
Клиентская часть (`index.html`, `style.css`, `client.js`) раздаётся тем же Node.js-сервером,
что и WebSocket.

## Что внутри

- `server.js` — Express + WebSocket-сервер. Раздаёт статику и синхронизирует игроков.
- `index.html` — HTML5-страница с Canvas и интерфейсом.
- `style.css` — стили интерфейса, мобильный джойстик, тёмная тема.
- `client.js` — Babylon.js-сцена, персонажи, камера, управление, WebSocket-клиент.

---

## 1. Установка Node.js

Скачай и установи Node.js LTS с https://nodejs.org (версия 18 или выше).
Проверь установку:

```bash
node -v
npm -v
```

## 2. Создай папку проекта

```bash
mkdir mp-3d-room
cd mp-3d-room
```

## 3. Создай файлы

В корне папки создай семь файлов (полное содержимое — в этом проекте):
`server.js`, `index.html`, `style.css`, `client.js`, `package.json`, `README.md`, `.gitignore`.

## 4. Установи зависимости

```bash
npm install
```

## 5. Запусти локально

```bash
npm start
```

Сервер запустится на `http://localhost:3000`.

## 6. Открой игру в браузере

Открой `http://localhost:3000`.

## 7. Проверь двух игроков локально

- Открой две вкладки (или обычное окно + приватное).
- В первой: введи имя → «Создать комнату» → скопируй код.
- Во второй: введи другое имя → вставь код → «Войти по коду».
- Оба персонажа появятся в одной комнате. Проверь движение WASD и мышь.

## 8. Создай репозиторий GitHub

На https://github.com нажми **New repository**, задай имя (например, `mp-3d-room`), создай.

## 9. Загрузи проект на GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/mp-3d-room.git
git push -u origin main
```

## 10. Создай Web Service на Render

1. Зайди на https://render.com → **New** → **Web Service**.
2. Подключи GitHub и выбери репозиторий.

## 11. Выбери репозиторий

Render сам подтянет код из репозитория.

## 12. Build Command

```
npm install
```

## 13. Start Command

```
npm start
```

## 14. Тариф

Выбери **Free** (если доступен в твоём регионе).

## 15. Открой публичный адрес

После деплоя Render да
