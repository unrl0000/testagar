// --- Начало файла game.js (переменные и базовые функции остаются такими же) ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const namePrompt = document.getElementById('name-prompt');
const nicknameInput = document.getElementById('nickname-input');
const playButton = document.getElementById('play-button');
const gameOverMessage = document.getElementById('game-over-message');
const respawnButton = document.getElementById('respawn-button');

// Элементы джойстика
const joystickBase = document.getElementById('joystick-base');
const joystickHandle = document.getElementById('joystick-handle');

// --- Глобальные переменные клиента ---
let socket;
let players = {};
let food = [];
let myPlayerId = null;
let mapWidth = 3000;
let mapHeight = 3000;
let camera = { x: 0, y: 0, zoom: 1 };
let mousePos = { x: 0, y: 0 }; // Оставляем для десктопа
let animationFrameId;
let isGameOver = false;

// Переменные для джойстика
let joystickActive = false;
let joystickTouchId = null;
let joystickStartX = 0;
let joystickStartY = 0;
let joystickBaseCenterX = 0;
let joystickBaseCenterY = 0;
let joystickRadius = 0; // Будет вычислено

// --- Определение типа устройства ---
const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
console.log("Is mobile:", isMobile);

// --- Настройки рендеринга ---
const NICKNAME_FONT = '14px Arial';
const GRID_COLOR = '#444';
const GRID_STEP = 50;

// --- Функции рисования (drawGrid, drawCircle, drawNickname, updateCamera, drawGame) ---
// --- остаются без изменений, как в предыдущем ответе ---

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // Пересчитываем параметры джойстика при ресайзе
    if (joystickBase.offsetParent) { // Проверяем, видим ли мы джойстик
         calculateJoystickParams();
    }
}

function drawGrid() {
    // ... (код без изменений)
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    const zoomedGridStep = GRID_STEP;
    const startX = (-camera.x * camera.zoom + canvas.width / 2) % zoomedGridStep;
    const startY = (-camera.y * camera.zoom + canvas.height / 2) % zoomedGridStep;

    for (let x = startX; x < canvas.width; x += zoomedGridStep) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
    }
    for (let y = startY; y < canvas.height; y += zoomedGridStep) {
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();
}


function drawCircle(x, y, radius, color) {
    // ... (код без изменений)
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function drawNickname(x, y, name, size) {
    // ... (код без изменений)
    const fontSize = Math.max(14, Math.min(24, size / 3));
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
    // ... (код без изменений)
    const myPlayer = players[myPlayerId];
    if (!myPlayer) return;

    const targetX = myPlayer.x - canvas.width / (2 * camera.zoom); // Учитываем зум
    const targetY = myPlayer.y - canvas.height / (2 * camera.zoom);
    // Плавное следование
    camera.x += (targetX - camera.x) * 0.1;
    camera.y += (targetY - camera.y) * 0.1;

    // Плавный зум (пример)
    const targetZoom = Math.pow(Math.min(64 / myPlayer.size, 1), 0.4);
    camera.zoom += (targetZoom - camera.zoom) * 0.05;
    camera.zoom = Math.max(canvas.height / mapHeight, Math.min(camera.zoom, 2)); // Ограничения зума
}


function drawGame() {
    // ... (почти без изменений, но используем camera.zoom)
    if (isGameOver && !myPlayerId) return;

    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (players[myPlayerId] && !isGameOver) {
        updateCamera();
    }

    ctx.save();
    // Центрируем канвас и применяем зум/смещение
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);


    // drawGrid(); // Сетка теперь должна рисоваться с учетом мировых координат

    // Границы карты
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 5 / camera.zoom; // Ширина линии не зависит от зума
    ctx.strokeRect(0, 0, mapWidth, mapHeight);


    food.forEach(f => {
        drawCircle(f.x, f.y, f.size / 2, f.color);
    });

    const sortedPlayers = Object.values(players).sort((a, b) => a.size - b.size);
    sortedPlayers.forEach(p => {
        drawCircle(p.x, p.y, p.size / 2, p.color);
        // Не рисуем ник, если игрок слишком мал на экране
        if (p.size / 2 * camera.zoom > 5) {
             drawNickname(p.x, p.y, p.name, p.size);
        }
    });

    ctx.restore();

    animationFrameId = requestAnimationFrame(drawGame);
}

// --- Функции управления джойстиком ---

function calculateJoystickParams() {
    const rect = joystickBase.getBoundingClientRect();
    joystickBaseCenterX = rect.left + rect.width / 2;
    joystickBaseCenterY = rect.top + rect.height / 2;
    joystickRadius = rect.width / 2; // База круглая
    console.log("Joystick params calculated:", joystickBaseCenterX, joystickBaseCenterY, joystickRadius);
}

function handleJoystickStart(event) {
    event.preventDefault(); // Предотвратить стандартное поведение (скролл, зум)
    if (isGameOver || !myPlayerId) return;

    const touch = event.changedTouches[0]; // Берем первое касание
    if (touch) {
        joystickTouchId = touch.identifier;
        joystickActive = true;
        // Позиция начала касания (не используется для расчета направления, но может быть полезна)
        joystickStartX = touch.clientX;
        joystickStartY = touch.clientY;
        // Рассчитываем параметры базы, если еще не сделали этого
        if (joystickRadius === 0) {
             calculateJoystickParams();
        }
        // Сразу обновляем позицию ручки и отправляем данные
        handleJoystickMove(event);
    }
}

function handleJoystickMove(event) {
    event.preventDefault();
    if (!joystickActive || isGameOver || !myPlayerId) return;

    let touch = null;
    for (let i = 0; i < event.changedTouches.length; i++) {
        if (event.changedTouches[i].identifier === joystickTouchId) {
            touch = event.changedTouches[i];
            break;
        }
    }

    if (touch) {
        // Вектор от центра базы до точки касания
        let deltaX = touch.clientX - joystickBaseCenterX;
        let deltaY = touch.clientY - joystickBaseCenterY;

        // Дистанция от центра базы
        const distance = Math.hypot(deltaX, deltaY);

        // Нормализованный вектор направления
        let normalizedX = 0;
        let normalizedY = 0;
        if (distance > 0) {
            normalizedX = deltaX / distance;
            normalizedY = deltaY / distance;
        }

        // Ограничиваем дистанцию радиусом джойстика
        const clampedDistance = Math.min(distance, joystickRadius);

        // Новые координаты для ручки джойстика (относительно центра базы)
        const handleX = normalizedX * clampedDistance;
        const handleY = normalizedY * clampedDistance;

        // Обновляем визуальное положение ручки
        joystickHandle.style.transform = `translate(calc(-50% + ${handleX}px), calc(-50% + ${handleY}px))`;

        // Отправляем вектор на сервер
        // Вектор такой же, как от мыши - смещение от центра
        // Масштабируем вектор, чтобы максимальное отклонение джойстика
        // соответствовало некоторой "максимальной скорости" (например, 100 пикселей от центра)
        const outputScale = 1.5; // Коэффициент чувствительности джойстика
        const outputX = normalizedX * clampedDistance * outputScale;
        const outputY = normalizedY * clampedDistance * outputScale;

        if (socket && socket.connected) {
             socket.emit('player_move', { x: outputX, y: outputY });
        }
    }
}

function handleJoystickEnd(event) {
    event.preventDefault();
    if (!joystickActive) return;

    let touchEnded = false;
    for (let i = 0; i < event.changedTouches.length; i++) {
        if (event.changedTouches[i].identifier === joystickTouchId) {
            touchEnded = true;
            break;
        }
    }

    if (touchEnded) {
        joystickActive = false;
        joystickTouchId = null;

        // Возвращаем ручку в центр
        joystickHandle.style.transform = 'translate(-50%, -50%)';

        // Отправляем нулевой вектор для остановки
        if (socket && socket.connected && !isGameOver) {
            socket.emit('player_move', { x: 0, y: 0 });
        }
    }
}

// --- Основная логика игры (startGame, stopGame) ---

function startGame(nickname) {
    console.log("Attempting to start game...");
    // --- (Сокеты и обработчики событий остаются почти такими же) ---
    if (!socket || !socket.connected) {
        socket = io();
    } else {
         // Очищаем старые обработчики перед респавном
         socket.off('connect');
         socket.off('disconnect');
         socket.off('connect_error');
         socket.off('game_setup');
         socket.off('current_state');
         socket.off('game_update');
         socket.off('player_joined');
         socket.off('player_left');
         socket.off('player_eaten');
         socket.off('game_over');
    }

    isGameOver = false;
    myPlayerId = null;
    gameOverMessage.classList.add('hidden'); // Используем класс для скрытия
    namePrompt.classList.add('hidden');      // Используем класс для скрытия

    // Показываем джойстик, если мобильное устройство
    if (isMobile) {
        joystickBase.style.display = 'block';
        calculateJoystickParams(); // Рассчитать позицию/размер
    } else {
        joystickBase.style.display = 'none';
    }

    // --- Обработчики событий Socket.IO ---
    socket.on('connect', () => {
        console.log('Connected to server! SID:', socket.id);
        socket.emit('join', { name: nickname });
        if (!animationFrameId) startRendering();
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        if (reason !== 'io client disconnect') {
            alert("Connection lost!");
        }
        stopGame(false); // Не отключаем сокет вручную
        namePrompt.classList.remove('hidden'); // Показываем форму входа
        joystickBase.style.display = 'none'; // Прячем джойстик
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err);
        alert(`Failed to connect to server: ${err.message}`);
        stopGame(false);
        namePrompt.classList.remove('hidden');
        joystickBase.style.display = 'none';
    });

    socket.on('game_setup', (data) => {
        myPlayerId = data.playerId;
        mapWidth = data.mapWidth;
        mapHeight = data.mapHeight;
        console.log(`Game setup complete. My ID: ${myPlayerId}`);
        // Начальная установка камеры на игрока
        if (players[myPlayerId]) {
           camera.x = players[myPlayerId].x;
           camera.y = players[myPlayerId].y;
        } else {
            // Если игрока еще нет в players, центрируемся на карте
            camera.x = mapWidth / 2;
            camera.y = mapHeight / 2;
        }
        camera.zoom = 1; // Сброс зума
    });

    socket.on('current_state', (data) => {
        console.log("Received initial state");
        players = {};
        data.players.forEach(p => players[p.id] = p);
        food = data.food;
         // Обновляем камеру, если наш игрок появился
        if (players[myPlayerId] && camera.x === mapWidth / 2) { // Если камера еще не настроена
           camera.x = players[myPlayerId].x;
           camera.y = players[myPlayerId].y;
        }
    });

    socket.on('game_update', (data) => {
        // Просто заменяем данные (можно добавить интерполяцию для плавности)
        const serverPlayers = {};
        data.players.forEach(p => serverPlayers[p.id] = p);
        players = serverPlayers;
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
    });

    socket.on('game_over', (data) => {
        console.log("Game Over:", data.message);
        isGameOver = true;
        myPlayerId = null; // Теряем ID
        gameOverMessage.classList.remove('hidden'); // Показываем сообщение
        joystickBase.style.display = 'none'; // Прячем джойстик
        // stopRendering(); // Не останавливаем рендеринг, чтобы видеть поле
    });

    // --- Обработка ввода пользователя ---
    setupInputListeners(); // Выносим установку листенеров в отдельную функцию
}

function stopGame(shouldDisconnect = true) {
    // stopRendering(); // Оставляем рендеринг?
    isGameOver = true;
    myPlayerId = null;
    players = {}; // Очищаем локальное состояние
    food = [];
    joystickBase.style.display = 'none'; // Прячем джойстик

    removeInputListeners(); // Снимаем листенеры

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

// --- Управление листенерами ввода ---
function setupInputListeners() {
    removeInputListeners(); // Сначала удаляем старые, на всякий случай

    if (isMobile) {
        console.log("Setting up TOUCH listeners");
        joystickBase.addEventListener('touchstart', handleJoystickStart, { passive: false });
        joystickBase.addEventListener('touchmove', handleJoystickMove, { passive: false });
        joystickBase.addEventListener('touchend', handleJoystickEnd, { passive: false });
        joystickBase.addEventListener('touchcancel', handleJoystickEnd, { passive: false }); // На случай прерывания
    } else {
        console.log("Setting up MOUSE listener");
        window.addEventListener('mousemove', handleMouseMove);
    }
     window.addEventListener('resize', resizeCanvas); // Всегда нужен
}

function removeInputListeners() {
    console.log("Removing input listeners");
    // Удаляем все возможные листенеры
    joystickBase.removeEventListener('touchstart', handleJoystickStart);
    joystickBase.removeEventListener('touchmove', handleJoystickMove);
    joystickBase.removeEventListener('touchend', handleJoystickEnd);
    joystickBase.removeEventListener('touchcancel', handleJoystickEnd);
    window.removeEventListener('mousemove', handleMouseMove);
    // window.removeEventListener('resize', resizeCanvas); // Ресайз лучше не удалять
}

// Обработчик для мыши (остается для десктопа)
function handleMouseMove(event) {
     if (!isGameOver && myPlayerId && socket && socket.connected) {
         const rect = canvas.getBoundingClientRect();
         mousePos.x = event.clientX - rect.left - canvas.width / 2;
         mousePos.y = event.clientY - rect.top - canvas.height / 2;
         socket.emit('player_move', { x: mousePos.x, y: mousePos.y });
     }
}


// --- Инициализация при загрузке страницы ---

playButton.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim() || 'Blob';
    startGame(nickname);
});

respawnButton.addEventListener('click', () => {
     const nickname = nicknameInput.value.trim() || 'Blob';
     if (socket && socket.connected) {
         // Просто снова отправляем join
         isGameOver = false;
         gameOverMessage.classList.add('hidden');
         if (isMobile) joystickBase.style.display = 'block'; // Показываем джойстик
         socket.emit('join', { name: nickname });
         if (!animationFrameId) startRendering();
     } else {
         startGame(nickname); // Если соединения нет, начинаем заново
     }
});

// Первичная установка размера и скрытие/показ UI
resizeCanvas();
gameOverMessage.classList.add('hidden');
namePrompt.classList.remove('hidden'); // Показать форму входа при загрузке
joystickBase.style.display = 'none'; // Джойстик скрыт при загрузке

console.log("Game script loaded. Waiting for nickname entry.");

// Дисконнект при закрытии вкладки
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});
