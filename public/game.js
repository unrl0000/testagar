// public/game.js

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const namePrompt = document.getElementById('name-prompt');
const nicknameInput = document.getElementById('nickname-input');
const playButton = document.getElementById('play-button');
const gameOverMessage = document.getElementById('game-over-message');
const respawnButton = document.getElementById('respawn-button');

// --- Глобальные переменные клиента ---
let socket;
let players = {}; // Хранилище данных всех игроков { id: { ... } }
let food = [];
let myPlayerId = null;
let mapWidth = 3000; // Значение по умолчанию, будет перезаписано сервером
let mapHeight = 3000;// Значение по умолчанию, будет перезаписано сервером
let camera = { x: 0, y: 0, zoom: 1 }; // Камера для слежения за игроком
let mousePos = { x: 0, y: 0 }; // Позиция мыши/касания относительно центра экрана
let animationFrameId; // Для остановки/запуска рендеринга
let isGameOver = false;
let isTouchDevice = false; // Флаг для определения типа устройства
let currentTouchId = null; // ID активного касания для multitouch-безопасности

// --- Настройки рендеринга ---
const NICKNAME_FONT_BASE = 14;
const GRID_COLOR = '#444';
const GRID_STEP = 50;

// --- Функции ---

function detectTouchDevice() {
  try {
    document.createEvent('TouchEvent');
    isTouchDevice = true;
    console.log("Touch device detected.");
    // Добавим класс к body для возможной стилизации CSS под тач
    document.body.classList.add('touch-device');
  } catch (e) {
    isTouchDevice = false;
    console.log("Mouse device detected.");
  }
  // Альтернативный/дополнительный способ проверки
  // isTouchDevice = isTouchDevice || ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function drawGrid() {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    const startX = -camera.x % GRID_STEP;
    const startY = -camera.y % GRID_STEP;

    for (let x = startX; x < canvas.width; x += GRID_STEP) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
    }
    for (let y = startY; y < canvas.height; y += GRID_STEP) {
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();
}


function drawCircle(x, y, radius, color) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function drawNickname(x, y, name, size) {
    const fontSize = Math.max(NICKNAME_FONT_BASE, Math.min(24, size / 3));
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
}

function updateCamera() {
    const myPlayer = players[myPlayerId];
    if (!myPlayer) return;

    // Центрирование камеры
    const targetX = myPlayer.x - canvas.width / 2;
    const targetY = myPlayer.y - canvas.height / 2;

    // Плавное следование (можно сделать опциональным)
    const smoothing = 0.1;
    camera.x += (targetX - camera.x) * smoothing;
    camera.y += (targetY - camera.y) * smoothing;

    // Ограничение камеры границами карты (чтобы не видеть пустоту за границами)
    // camera.x = Math.max(-canvas.width / 2, Math.min(mapWidth - canvas.width / 2, camera.x));
    // camera.y = Math.max(-canvas.height / 2, Math.min(mapHeight - canvas.height / 2, camera.y));
}


function drawGame() {
    if (isGameOver && !myPlayerId) return;

    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (players[myPlayerId] && !isGameOver) {
        updateCamera();
    }

    ctx.save();
    // Применяем смещение камеры: Переносим центр мира (игрока) в центр канваса
    ctx.translate(canvas.width / 2, canvas.height / 2);
    // ctx.scale(camera.zoom, camera.zoom); // Если будет зум
    if (players[myPlayerId]) {
        ctx.translate(-camera.x - canvas.width / 2, -camera.y - canvas.height / 2); // Компенсируем смещение updateCamera
    } else {
        // Центрируем карту, если игрок не активен
        ctx.translate(-mapWidth/2, -mapHeight/2);
    }


    // Рисуем сетку и границу карты
    drawGrid();
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);


    // Рисуем еду
    food.forEach(f => {
        drawCircle(f.x, f.y, f.size / 2, f.color);
    });

    // Рисуем игроков (сортировка чтобы меньшие были поверх)
    const sortedPlayers = Object.values(players).sort((a, b) => a.size - b.size);
    sortedPlayers.forEach(p => {
        drawCircle(p.x, p.y, p.size / 2, p.color);
        // Не рисуем ник себе, если он перекрывается (опционально)
        // if (p.id !== myPlayerId || p.size > 50) {
        drawNickname(p.x, p.y, p.name, p.size);
        // }
    });

    ctx.restore();

    animationFrameId = requestAnimationFrame(drawGame);
}


// --- Обработка ввода (Общая функция) ---
function handlePointerMove(clientX, clientY) {
    if (!isGameOver && myPlayerId && socket && socket.connected) {
        const rect = canvas.getBoundingClientRect();
        // Вычисляем вектор от центра экрана к точке касания/мыши
        mousePos.x = clientX - rect.left - canvas.width / 2;
        mousePos.y = clientY - rect.top - canvas.height / 2;
        // Отправляем вектор направления на сервер
        socket.emit('player_move', { x: mousePos.x, y: mousePos.y });
    }
}

function handlePointerEnd() {
    // Когда палец убран (или мышь перестала активно двигаться - не используется для мыши),
    // отправляем нулевой вектор, чтобы остановить движение к последней точке.
    if (!isGameOver && myPlayerId && socket && socket.connected) {
        mousePos.x = 0;
        mousePos.y = 0;
        socket.emit('player_move', { x: 0, y: 0 });
    }
}

// --- Обработчики событий ввода ---
function handleMouseMove(event) {
    // Игнорируем мышь, если активно касание (на устройствах с обоими вводами)
    if (currentTouchId === null) {
         handlePointerMove(event.clientX, event.clientY);
    }
}

function handleTouchStart(event) {
    // Предотвращаем стандартное поведение (скролл, зум)
    event.preventDefault();
    // Отслеживаем только первое касание
    if (currentTouchId === null) {
        const touch = event.changedTouches[0];
        currentTouchId = touch.identifier; // Запоминаем ID касания
        handlePointerMove(touch.clientX, touch.clientY);
    }
}

function handleTouchMove(event) {
    event.preventDefault();
    // Ищем наше активное касание
    for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        if (touch.identifier === currentTouchId) {
            handlePointerMove(touch.clientX, touch.clientY);
            break; // Обработали наше касание, выходим
        }
    }
}

function handleTouchEnd(event) {
    event.preventDefault();
    for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        // Если палец, который мы отслеживали, был убран
        if (touch.identifier === currentTouchId) {
            currentTouchId = null; // Сбрасываем ID активного касания
            handlePointerEnd(); // Отправляем сигнал остановки
            break;
        }
    }
}

// --- Управление игрой ---

function setupInputListeners() {
    // Удаляем старые слушатели на всякий случай
    window.removeEventListener('mousemove', handleMouseMove);
    canvas.removeEventListener('touchstart', handleTouchStart);
    canvas.removeEventListener('touchmove', handleTouchMove);
    canvas.removeEventListener('touchend', handleTouchEnd);
    canvas.removeEventListener('touchcancel', handleTouchEnd); // Добавляем touchcancel

    if (isTouchDevice) {
        console.log("Attaching touch listeners");
        canvas.addEventListener('touchstart', handleTouchStart, { passive: false }); // passive: false для preventDefault()
        canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
        canvas.addEventListener('touchend', handleTouchEnd);
        canvas.addEventListener('touchcancel', handleTouchEnd); // На случай прерывания касания
    } else {
        console.log("Attaching mouse listener");
        window.addEventListener('mousemove', handleMouseMove);
        // Для мыши нет явного "end", движение прекращается, когда мышь останавливается
        // или когда отправлен нулевой вектор при touchend (если был тач)
    }
}

function removeInputListeners() {
     window.removeEventListener('mousemove', handleMouseMove);
     canvas.removeEventListener('touchstart', handleTouchStart);
     canvas.removeEventListener('touchmove', handleTouchMove);
     canvas.removeEventListener('touchend', handleTouchEnd);
     canvas.removeEventListener('touchcancel', handleTouchEnd);
     currentTouchId = null; // Сбрасываем активное касание
     console.log("Input listeners removed.");
}

function startGame(nickname) {
    console.log("Attempting to start game...");
    // Инициализируем соединение Socket.IO, если его нет
    if (!socket || !socket.connected) {
        socket = io(); // URL сервера будет определен автоматически
    } else {
        // Если сокет уже есть (например, после респавна), убедимся что он чист
        socket.off(); // Удаляем ВСЕ предыдущие обработчики на всякий случай
    }

    isGameOver = false;
    myPlayerId = null;
    gameOverMessage.style.display = 'none';
    namePrompt.style.display = 'none';

    // --- Обработчики событий Socket.IO ---
    socket.on('connect', () => {
        console.log('Connected to server! SID:', socket.id);
        socket.emit('join', { name: nickname });
        if (!animationFrameId) startRendering(); // Запускаем рендер
        setupInputListeners(); // Добавляем слушатели ввода
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        if (reason !== 'io client disconnect') {
            alert("Connection lost! Please refresh.");
        }
        stopGame(false);
        namePrompt.style.display = 'block';
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err);
        alert(`Failed to connect to server: ${err.message}`);
        stopGame(false);
        namePrompt.style.display = 'block';
    });

    socket.on('game_setup', (data) => {
        myPlayerId = data.playerId;
        mapWidth = data.mapWidth;
        mapHeight = data.mapHeight;
        console.log(`Game setup complete. My ID: ${myPlayerId}, Map: ${mapWidth}x${mapHeight}`);
    });

    socket.on('current_state', (data) => {
        console.log("Received initial state");
        players = {};
        data.players.forEach(p => players[p.id] = p);
        food = data.food;
        if (players[myPlayerId]) {
           // Инициализируем позицию камеры
           camera.x = players[myPlayerId].x - canvas.width / 2;
           camera.y = players[myPlayerId].y - canvas.height / 2;
        }
    });

    socket.on('game_update', (data) => {
        const serverPlayers = {};
        data.players.forEach(p => serverPlayers[p.id] = p);
        players = serverPlayers; // Просто заменяем (нет интерполяции)
        food = data.food;
    });

    socket.on('player_joined', (newPlayer) => {
        console.log(`Player ${newPlayer.name} joined`);
        if (newPlayer.id !== myPlayerId) {
            players[newPlayer.id] = newPlayer;
        }
    });

    socket.on('player_left', (data) => {
        console.log(`Player ${data.id} left`);
        delete players[data.id];
    });

    socket.on('player_eaten', (data) => {
        console.log(`Player ${data.eaten_id} was eaten`);
        if (data.eaten_id !== myPlayerId) {
             delete players[data.eaten_id];
        }
        // Можно обновить размер едока если он известен и есть в players
    });

    socket.on('game_over', (data) => {
        console.log("Game Over:", data.message);
        isGameOver = true;
        myPlayerId = null; // Потеряли ID
        removeInputListeners(); // Убираем слушатели ввода
        // Не останавливаем рендеринг, чтобы можно было наблюдать
        gameOverMessage.style.display = 'block';
    });
}


function stopGame(shouldDisconnect = true) {
    stopRendering();
    isGameOver = true;
    myPlayerId = null;
    players = {};
    food = [];
    removeInputListeners(); // Убедимся что слушатели убраны

    if (socket && shouldDisconnect) {
        socket.disconnect();
        socket = null;
        console.log("Socket disconnected manually.");
    }
}

function startRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    console.log("Starting rendering loop");
    drawGame();
}

function stopRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Rendering loop stopped");
     }
}


// --- Инициализация при загрузке страницы ---

// Определяем тип устройства ДО начала игры
detectTouchDevice();

playButton.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim() || 'Blob';
    startGame(nickname);
});

respawnButton.addEventListener('click', () => {
     const nickname = nicknameInput.value.trim() || 'Blob';
     if (socket && socket.connected) {
         isGameOver = false;
         gameOverMessage.style.display = 'none';
         // Не нужно пересоздавать сокет, просто снова входим в игру
         // Обработчики сокета будут переназначены в startGame
         startGame(nickname); // Перезапустим startGame, чтобы переназначить обработчики и слушатели ввода
     } else {
         // Если соединение потеряно, запускаем все заново
         startGame(nickname);
     }
});

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

console.log("Game script loaded. Waiting for nickname entry.");

window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});
