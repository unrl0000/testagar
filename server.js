const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// --- Настройки ---
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const INITIAL_PLAYER_SIZE = 20;
const FOOD_COUNT = 150;
const FOOD_SIZE = 8;
const PLAYER_SPEED_FACTOR = 8; // Чем меньше, тем быстрее
const EAT_RATIO = 1.1; // Нужно быть больше в X раз, чтобы съесть
const SERVER_TICK_RATE = 30; // Обновлений в секунду

// --- Приложение Express и сервер HTTP ---
const app = express();
const server = http.createServer(app);
// --- Socket.IO ---
// Настроим CORS для локальной разработки (на Render может не понадобиться, но не повредит)
const io = new Server(server, {
    cors: {
        origin: "*", // Разрешить все источники (для простоты)
        methods: ["GET", "POST"]
    }
});

// --- Обслуживание статических файлов ---
// Отдаем файлы из папки 'public' (index.html, game.js, style.css)
app.use(express.static(path.join(__dirname, 'public')));

// --- Маршрут для главной страницы ---
// Express сам найдет index.html в папке public, но можно и явно указать
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Игровое состояние ---
let players = {}; // { socket.id: { id: socket.id, name: name, x: x, y: y, size: size, color: color, targetX: x, targetY: y } }
let food = [];

// --- Вспомогательные функции ---
function getRandomColor() {
    return `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`;
}

function generateFood() {
    const needed = FOOD_COUNT - food.length;
    for (let i = 0; i < needed; i++) {
        food.push({
            id: Math.random().toString(36).substring(7), // Простой ID для еды
            x: Math.random() * (MAP_WIDTH - FOOD_SIZE * 2) + FOOD_SIZE,
            y: Math.random() * (MAP_HEIGHT - FOOD_SIZE * 2) + FOOD_SIZE,
            size: FOOD_SIZE,
            color: getRandomColor()
        });
    }
}

function getPlayerById(playerId) {
    return players[playerId];
}

function getDistance(obj1, obj2) {
    const dx = obj1.x - obj2.x;
    const dy = obj1.y - obj2.y;
    return Math.sqrt(dx * dx + dy * dy);
    // или return Math.hypot(dx, dy); // Более точный и читаемый способ
}

// --- Инициализация игры ---
generateFood();

// --- Обработка подключений Socket.IO ---
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Игрок входит в игру
    socket.on('join', (data) => {
        const name = (data.name || 'Blob').substring(0, 15); // Ограничим ник
        console.log(`Player ${name} (${socket.id}) joining.`);

        // Создаем нового игрока
        const player = {
            id: socket.id,
            name: name,
            x: Math.random() * (MAP_WIDTH - INITIAL_PLAYER_SIZE * 2) + INITIAL_PLAYER_SIZE,
            y: Math.random() * (MAP_HEIGHT - INITIAL_PLAYER_SIZE * 2) + INITIAL_PLAYER_SIZE,
            size: INITIAL_PLAYER_SIZE,
            color: getRandomColor(),
            targetX: 0, // Вектор направления от мыши
            targetY: 0
        };
        players[socket.id] = player;

        // 1. Отправляем новому игроку его ID и размер карты
        socket.emit('game_setup', { playerId: socket.id, mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT });

        // 2. Отправляем новому игроку текущее состояние ВСЕХ игроков и еды
        socket.emit('current_state', { players: Object.values(players), food: food });

        // 3. Оповещаем ВСЕХ ОСТАЛЬНЫХ о новом игроке
        socket.broadcast.emit('player_joined', player); // broadcast = всем, кроме отправителя
    });

    // Получаем направление движения от клиента
    socket.on('player_move', (data) => {
        const player = getPlayerById(socket.id);
        if (player) {
            // data.x, data.y - координаты мыши относительно центра ЭКРАНА КЛИЕНТА
            player.targetX = data.x || 0;
            player.targetY = data.y || 0;
        }
    });

    // Клиент отключился
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        const player = players[socket.id];
        if (player) {
            delete players[socket.id]; // Удаляем игрока из объекта
            // Оповещаем всех остальных, что игрок ушел
            io.emit('player_left', { id: socket.id }); // io.emit = всем подключенным
        }
    });
});

// --- Игровой цикл ---
function gameLoop() {
    let foodEatenIndices = new Set();
    let playersToRemove = new Set();
    let playerUpdates = []; // Для оптимизации можно собирать только изменения

    // 1. Движение и границы карты
    Object.values(players).forEach(player => {
        const targetX = player.targetX;
        const targetY = player.targetY;
        const distanceToTarget = Math.hypot(targetX, targetY);

        let directionX = 0;
        let directionY = 0;
        if (distanceToTarget > 1) { // Двигаемся, только если курсор не в центре
            directionX = targetX / distanceToTarget;
            directionY = targetY / distanceToTarget;
        }

        // Скорость зависит от размера
        const speed = PLAYER_SPEED_FACTOR / (1 + Math.log1p(player.size / INITIAL_PLAYER_SIZE));

        const newX = player.x + directionX * speed;
        const newY = player.y + directionY * speed;

        // Ограничение по карте (учитываем радиус)
        const radius = player.size / 2;
        player.x = Math.max(radius, Math.min(MAP_WIDTH - radius, newX));
        player.y = Math.max(radius, Math.min(MAP_HEIGHT - radius, newY));
    });

    const playerList = Object.values(players); // Для итераций

    // 2. Поедание еды
    playerList.forEach(player => {
        if (playersToRemove.has(player.id)) return; // Пропускаем уже съеденных

        const playerRadius = player.size / 2;
        food.forEach((f, index) => {
            if (foodEatenIndices.has(index)) return;

            const dist = getDistance(player, f);
            if (dist < playerRadius - f.size / 3) { // Касание для поедания
                player.size += f.size * 0.2;
                foodEatenIndices.add(index);
            }
        });
    });

    // 3. Поедание игроков
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        const idA = playerIds[i];
        if (playersToRemove.has(idA)) continue;
        const playerA = players[idA];

        for (let j = i + 1; j < playerIds.length; j++) {
            const idB = playerIds[j];
            if (playersToRemove.has(idB)) continue;
            const playerB = players[idB];

            const dist = getDistance(playerA, playerB);
            const radiusA = playerA.size / 2;
            const radiusB = playerB.size / 2;

            if (dist < radiusA - radiusB * 0.8 && playerA.size > playerB.size * EAT_RATIO) {
                // A ест B
                playerA.size += playerB.size;
                playersToRemove.add(idB);
                console.log(`${playerA.name} ate ${playerB.name}`);
            } else if (dist < radiusB - radiusA * 0.8 && playerB.size > playerA.size * EAT_RATIO) {
                // B ест A
                playerB.size += playerA.size;
                playersToRemove.add(idA);
                console.log(`${playerB.name} ate ${playerA.name}`);
                break; // A съели, нет смысла проверять его дальше
            }
        }
    }

    // 4. Удаление съеденных игроков
    if (playersToRemove.size > 0) {
        playersToRemove.forEach(sid => {
            const eatenPlayer = players[sid]; // Получаем данные перед удалением
            if (eatenPlayer) {
                 delete players[sid];
                 io.emit('player_eaten', { eaten_id: sid }); // Оповещаем всех
                 // Отправляем сообщение 'game_over' конкретному съеденному игроку
                 io.to(sid).emit('game_over', { message: `You were eaten!` });
            }
        });
    }


    // 5. Удаление съеденной еды и генерация новой
    if (foodEatenIndices.size > 0) {
        // Фильтруем еду - создаем новый массив без съеденных элементов
        food = food.filter((_, index) => !foodEatenIndices.has(index));
        generateFood(); // Добавляем новую еду
    }

    // 6. Отправка обновленного состояния всем клиентам
    io.emit('game_update', {
        players: Object.values(players), // Отправляем актуальный список игроков
        food: food // Отправляем всю еду (проще для начала)
    });
}

// Запускаем игровой цикл с заданной частотой
setInterval(gameLoop, 1000 / SERVER_TICK_RATE);

// --- Запуск сервера ---
const PORT = process.env.PORT || 3000; // Render предоставит process.env.PORT
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
