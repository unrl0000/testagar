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
let mapWidth = 3000;
let mapHeight = 3000;
let camera = { x: 0, y: 0, zoom: 1 }; // Камера для слежения за игроком
let mousePos = { x: 0, y: 0 }; // Позиция мыши относительно центра экрана
let animationFrameId; // Для остановки/запуска рендеринга
let isGameOver = false;

// --- Настройки рендеринга ---
const NICKNAME_FONT = '14px Arial';
const GRID_COLOR = '#444';
const GRID_STEP = 50;

// --- Функции ---

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function drawGrid() {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    // Вертикальные линии с учетом смещения камеры
    const startX = -camera.x % GRID_STEP;
    for (let x = startX; x < canvas.width; x += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    // Горизонтальные линии
    const startY = -camera.y % GRID_STEP;
    for (let y = startY; y < canvas.height; y += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

function drawCircle(x, y, radius, color) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // ctx.strokeStyle = 'rgba(0,0,0,0.1)'; // Обводка (опционально)
    // ctx.lineWidth = 2;
    // ctx.stroke();
}

function drawNickname(x, y, name) {
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = NICKNAME_FONT;
    ctx.fillText(name, x, y);
}

function updateCamera() {
    const myPlayer = players[myPlayerId];
    if (!myPlayer) return;

    // Центрируем камеру на игроке
    camera.x = myPlayer.x - canvas.width / 2;
    camera.y = myPlayer.y - canvas.height / 2;

    // Ограничиваем камеру границами карты
    // (Не обязательно, можно позволить видеть за пределами)
    camera.x = Math.max(0, Math.min(mapWidth - canvas.width, camera.x));
    camera.y = Math.max(0, Math.min(mapHeight - canvas.height, camera.y));

    // Можно добавить зум в зависимости от размера игрока (сложнее)
    // camera.zoom = ...
}


function drawGame() {
    if (isGameOver) return; // Не рисуем, если игра окончена для этого клиента

    // 1. Очистка и установка размеров
    resizeCanvas(); // Обновляем размер канваса на случай изменения окна
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 2. Обновление камеры
    updateCamera();

    // 3. Сохраняем контекст и смещаем мир под камеру
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // 4. Рисуем фон/сетку (по желанию)
     drawGrid(); // Рисуем сетку до объектов

    // 5. Рисуем еду
    food.forEach(f => {
        drawCircle(f.x, f.y, f.size / 2, f.color);
    });

    // 6. Рисуем всех игроков
    // Сортируем по размеру, чтобы меньшие рисовались поверх больших (не обязательно)
    const sortedPlayers = Object.values(players).sort((a, b) => a.size - b.size);
    sortedPlayers.forEach(p => {
        drawCircle(p.x, p.y, p.size / 2, p.color);
        drawNickname(p.x, p.y, p.name);
    });

    // 7. Восстанавливаем контекст
    ctx.restore();

    // Запрашиваем следующий кадр анимации
    animationFrameId = requestAnimationFrame(drawGame);
}

function startGame(nickname) {
    console.log("Attempting to connect...");
    // Инициализируем соединение Socket.IO
    socket = io(); // URL сервера будет определен автоматически

    isGameOver = false;
    players = {};
    food = [];
    myPlayerId = null;
    gameOverMessage.style.display = 'none'; // Скрыть сообщение об окончании игры
    namePrompt.style.display = 'none'; // Скрыть ввод ника

    // --- Обработчики событий Socket.IO ---

    socket.on('connect', () => {
        console.log('Connected to server! SID:', socket.id);
        // Отправляем ник на сервер для входа в игру
        socket.emit('join', { name: nickname });
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        // Можно показать сообщение об ошибке или попытаться переподключиться
        alert("Connection lost!");
        stopGame();
        namePrompt.style.display = 'block'; // Показать ввод ника снова
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err);
        alert(`Failed to connect to server: ${err.message}`);
        stopGame();
        namePrompt.style.display = 'block';
    });


    // Получаем свой ID и размер карты при успешном входе
    socket.on('game_setup', (data) => {
        myPlayerId = data.playerId;
        mapWidth = data.mapWidth;
        mapHeight = data.mapHeight;
        console.log(`Game setup complete. My ID: ${myPlayerId}, Map: ${mapWidth}x${mapHeight}`);
        // Запускаем игровой цикл только после получения ID
        startRendering();
    });

    // Получаем начальное состояние всех объектов при входе
    socket.on('current_state', (data) => {
        console.log("Received initial state");
        // Сразу обновляем локальные данные
        players = {}; // Очищаем на всякий случай
        data.players.forEach(p => players[p.id] = p);
        food = data.food;
    });

    // Получаем периодические обновления состояния
    socket.on('game_update', (data) => {
         // Обновляем игроков: добавляем новых, обновляем существующих
        const serverPlayers = {};
        data.players.forEach(p => serverPlayers[p.id] = p);
        players = serverPlayers; // Просто заменяем старый список новым (простейший способ)

        // Обновляем еду
        food = data.food;
    });

    // Кто-то новый подключился
    socket.on('player_joined', (newPlayer) => {
        console.log(`Player ${newPlayer.name} joined`);
        if (newPlayer.id !== myPlayerId) { // Не добавляем себя снова
            players[newPlayer.id] = newPlayer;
        }
    });

    // Кто-то отключился
    socket.on('player_left', (data) => {
        console.log(`Player ${data.id} left`);
        delete players[data.id];
    });

    // Кого-то съели
    socket.on('player_eaten', (data) => {
        console.log(`Player ${data.eaten_id} was eaten`);
        delete players[data.eaten_id];
        // Можно добавить логику обновления счета едока (data.eater_id)
    });

    // Сервер сообщил, что нас съели
    socket.on('game_over', (data) => {
        console.log("Game Over:", data.message);
        isGameOver = true;
        stopRendering(); // Останавливаем отрисовку
        gameOverMessage.style.display = 'block'; // Показываем сообщение
        // Не отключаемся от сокета, чтобы видеть других игроков (или можно отключиться)
        // socket.disconnect();
    });


    // --- Обработка ввода пользователя ---
    window.addEventListener('mousemove', (event) => {
        if (!isGameOver && myPlayerId && socket && socket.connected) {
            // Координаты мыши относительно центра экрана
            mousePos.x = event.clientX - canvas.width / 2;
            mousePos.y = event.clientY - canvas.height / 2;
            // Отправляем вектор направления на сервер
            socket.emit('player_move', { x: mousePos.x, y: mousePos.y });
        }
    });
}

function stopGame() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    stopRendering();
    isGameOver = true; // Устанавливаем флаг
    players = {};
    food = [];
}

function startRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    drawGame(); // Начать цикл отрисовки
}

function stopRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    // Можно дополнительно очистить канвас
    // ctx.clearRect(0, 0, canvas.width, canvas.height);
}


// --- Инициализация при загрузке страницы ---

// Обработчик кнопки Play
playButton.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim() || 'Blob';
    startGame(nickname);
});

// Обработчик кнопки Respawn/Play Again
respawnButton.addEventListener('click', () => {
     const nickname = nicknameInput.value.trim() || 'Blob'; // Берем ник снова
     // Не нужно создавать новый сокет, просто перезапускаем игру с тем же ником
     // Если сокет был отключен в stopGame(), то нужно пересоздать его как в startGame()
     // В текущей реализации сокет не отключается при game_over, поэтому просто эмитим join
     if (socket && socket.connected) {
         isGameOver = false;
         gameOverMessage.style.display = 'none';
         socket.emit('join', { name: nickname }); // Повторный вход
         startRendering(); // Начинаем рендеринг снова
     } else {
         // Если соединение было потеряно, запускаем все заново
         startGame(nickname);
     }
});


// Подгоняем размер канваса при загрузке и изменении размера окна
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Первичная установка размера

console.log("Game script loaded. Waiting for nickname entry.");
