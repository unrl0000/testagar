// Весь код game.js из предыдущего ответа должен работать здесь без изменений.
// Убедитесь, что имена событий ('connect', 'disconnect', 'join', 'player_move',
// 'game_setup', 'current_state', 'game_update', 'player_joined', 'player_left',
// 'player_eaten', 'game_over') точно совпадают с теми, что используются в server.js.

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
    ctx.lineWidth = 0.5; // Сделаем сетку тоньше
    ctx.beginPath();
    // Смещение сетки относительно камеры и мира
    const zoomedGridStep = GRID_STEP; // * camera.zoom; // Учесть зум, если будет
    const startX = -camera.x % zoomedGridStep;
    const startY = -camera.y % zoomedGridStep;

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
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function drawNickname(x, y, name, size) {
    // Размер шрифта может зависеть от размера игрока
    const fontSize = Math.max(14, Math.min(24, size / 3)); // Примерная зависимость
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Добавим черную обводку для читаемости
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
}

function updateCamera() {
    const myPlayer = players[myPlayerId];
    if (!myPlayer) return;

    // Плавное следование камеры (опционально, можно оставить жесткое)
    const targetX = myPlayer.x - canvas.width / 2;
    const targetY = myPlayer.y - canvas.height / 2;
    camera.x += (targetX - camera.x) * 0.1; // 0.1 - коэффициент плавности
    camera.y += (targetY - camera.y) * 0.1;

    // Ограничиваем камеру границами карты (опционально)
    // camera.x = Math.max(0, Math.min(mapWidth - canvas.width, camera.x));
    // camera.y = Math.max(0, Math.min(mapHeight - canvas.height, camera.y));
}


function drawGame() {
    if (isGameOver && !myPlayerId) return; // Не рисуем если игра окончена И мы еще не респавнулись

    // 1. Очистка и установка размеров
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 2. Обновление камеры (только если мы играем)
    if (players[myPlayerId] && !isGameOver) {
        updateCamera();
    }
    // Если игра окончена, камера может оставаться на месте смерти или центрироваться

    // 3. Сохраняем контекст и смещаем мир под камеру
    ctx.save();
    // Применяем смещение камеры
    ctx.translate(canvas.width / 2, canvas.height / 2); // Переносим 0,0 в центр
    // ctx.scale(camera.zoom, camera.zoom); // Если будет зум
    if (players[myPlayerId]) { // Центрируемся относительно игрока
        ctx.translate(-players[myPlayerId].x, -players[myPlayerId].y);
    } else if (camera.x !== 0 || camera.y !== 0) { // Или используем последнее положение камеры
         ctx.translate(-camera.x - canvas.width / 2 , -camera.y - canvas.height / 2);
    } else { // Или просто (0,0) мира в центре экрана
        ctx.translate(-mapWidth/2, -mapHeight/2); // Центрируем карту, если игрок не определен
    }


    // 4. Рисуем фон/сетку (по желанию)
     // drawGrid(); // Рисуем сетку (координаты теперь мировые)

    // 5. Рисуем границы карты (опционально)
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);


    // 6. Рисуем еду
    food.forEach(f => {
        drawCircle(f.x, f.y, f.size / 2, f.color);
    });

    // 7. Рисуем всех игроков
    const sortedPlayers = Object.values(players).sort((a, b) => a.size - b.size);
    sortedPlayers.forEach(p => {
        drawCircle(p.x, p.y, p.size / 2, p.color);
        drawNickname(p.x, p.y, p.name, p.size);
    });

    // 8. Восстанавливаем контекст
    ctx.restore();

    // Запрашиваем следующий кадр анимации
    animationFrameId = requestAnimationFrame(drawGame);
}

function startGame(nickname) {
    console.log("Attempting to connect...");
    // Инициализируем соединение Socket.IO
    // Если сокет уже есть и подключен, переиспользуем его (для респавна)
    if (!socket || !socket.connected) {
        socket = io(); // URL сервера будет определен автоматически или можно указать io('http://your-render-url.com')
    }

    isGameOver = false;
    // Не сбрасываем players и food здесь, их обновит сервер
    myPlayerId = null; // Сбросим ID, пока сервер не выдаст новый
    gameOverMessage.style.display = 'none';
    namePrompt.style.display = 'none';


    // --- Обработчики событий Socket.IO ---
    // (удаляем старые обработчики перед добавлением новых, чтобы избежать дублирования при респавне)
    if (socket._callbacks) { // Проверка на существование внутренних обработчиков
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


    socket.on('connect', () => {
        console.log('Connected to server! SID:', socket.id);
        // Отправляем ник на сервер для входа в игру СРАЗУ после коннекта
        socket.emit('join', { name: nickname });
        // Начинаем рендеринг сразу, чтобы видеть поле до получения ID
        if (!animationFrameId) startRendering();
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        if (reason !== 'io client disconnect') { // Не показываем alert, если сами отключились
            alert("Connection lost!");
        }
        stopGame(false); // Останавливаем игру, но не отключаем сокет явно
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
        // Рендеринг уже должен быть запущен
    });

    socket.on('current_state', (data) => {
        console.log("Received initial state");
        players = {}; // Очищаем перед получением полного состояния
        data.players.forEach(p => players[p.id] = p);
        food = data.food;
        // Если мы только что подключились и уже есть наш ID, обновим камеру
        if (players[myPlayerId]) {
           camera.x = players[myPlayerId].x;
           camera.y = players[myPlayerId].y;
        }
    });

    socket.on('game_update', (data) => {
        // Плавно обновить позиции или просто заменить? Для простоты - заменяем.
        const serverPlayers = {};
        data.players.forEach(p => {
            // Можно добавить интерполяцию для плавности
            serverPlayers[p.id] = p;
        });
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
        // Если съели нас, сервер пришлет 'game_over'
        if (data.eaten_id !== myPlayerId) {
             delete players[data.eaten_id];
        }
        // Можно найти едока и визуально увеличить его
        // if (data.eater_id && players[data.eater_id]) { ... }
    });

    socket.on('game_over', (data) => {
        console.log("Game Over:", data.message);
        isGameOver = true;
        myPlayerId = null; // Теряем свой ID
        // Не останавливаем рендеринг, чтобы видеть других
        // stopRendering();
        gameOverMessage.style.display = 'block';
        // Не отключаемся от сокета
    });


    // --- Обработка ввода пользователя ---
    // Удаляем старый листенер, если он был
    window.removeEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousemove', handleMouseMove);
}

function handleMouseMove(event) {
     if (!isGameOver && myPlayerId && socket && socket.connected) {
         // Координаты мыши относительно центра канваса
         const rect = canvas.getBoundingClientRect();
         mousePos.x = event.clientX - rect.left - canvas.width / 2;
         mousePos.y = event.clientY - rect.top - canvas.height / 2;
         // Отправляем вектор направления на сервер
         socket.emit('player_move', { x: mousePos.x, y: mousePos.y });
     }
}

function stopGame(shouldDisconnect = true) {
    stopRendering(); // Останавливаем отрисовку
    isGameOver = true;
    myPlayerId = null; // Сбрасываем ID
    // Очищаем локальное состояние, чтобы не видеть "призраков"
    players = {};
    food = [];

    if (socket && shouldDisconnect) {
        socket.disconnect();
        socket = null;
        console.log("Socket disconnected manually.");
    }
     window.removeEventListener('mousemove', handleMouseMove); // Убираем листенер
}

function startRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    console.log("Starting rendering loop");
    drawGame(); // Начать цикл отрисовки
}

function stopRendering() {
     if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Rendering loop stopped");
     }
}


// --- Инициализация при загрузке страницы ---

playButton.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim() || 'Blob';
    startGame(nickname);
});

respawnButton.addEventListener('click', () => {
     const nickname = nicknameInput.value.trim() || 'Blob';
     // Просто перезапускаем игру с тем же ником. Сокет должен быть жив.
     if (socket && socket.connected) {
         isGameOver = false;
         gameOverMessage.style.display = 'none';
         socket.emit('join', { name: nickname }); // Повторный вход
         if (!animationFrameId) startRendering(); // Начинаем рендеринг, если остановлен
     } else {
         // Если соединение потеряно, запускаем все заново
         startGame(nickname);
     }
});


// Подгоняем размер канваса при загрузке и изменении размера окна
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Первичная установка размера

console.log("Game script loaded. Waiting for nickname entry.");

// Убедимся, что при закрытии вкладки происходит дисконнект
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});
