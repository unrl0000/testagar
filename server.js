// server.js
const WebSocket = require('ws');

// --- Конфигурация и константы ---
const PORT = process.env.PORT || 3000; // Важно для Render.com
const TICK_RATE = 60; // Обновлений состояния в секунду
const MAP_SIZE = 2000;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 200 / TICK_RATE; // Пикселей за тик
const BULLET_RADIUS = 8;
const BULLET_SPEED = 450 / TICK_RATE; // Пикселей за тик
const BULLET_LIFESPAN = 1.5 * TICK_RATE; // Время жизни пули в тиках
const BULLET_DAMAGE = 10;
const PLAYER_MAX_HP = 100;
const SHOOT_COOLDOWN = 0.25 * TICK_RATE; // Тиков между выстрелами
const RESPAWN_DELAY = 3 * TICK_RATE; // Тиков до респавна

// --- Состояние игры ---
let gameState = {
    players: {}, // { id: { x, y, angle, hp, maxHp, color, lastShotTick, kills, dead, respawnTick } }
    bullets: [], // { id, ownerId, x, y, angle, speed, radius, damage, ticksLeft }
};
let nextPlayerId = 0;
let nextBulletId = 0;
let currentTick = 0;

// --- WebSocket Сервер ---
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server started on port ${PORT}`);

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    console.log(`Player ${playerId} connected.`);

    // --- Инициализация нового игрока ---
    const startX = Math.random() * (MAP_SIZE - 100) + 50;
    const startY = Math.random() * (MAP_SIZE - 100) + 50;
    const startColor = `hsl(${Math.random() * 360}, 70%, 60%)`;

    gameState.players[playerId] = {
        id: playerId,
        x: startX,
        y: startY,
        radius: PLAYER_RADIUS,
        angle: 0, // Угол пушки (направление взгляда)
        hp: PLAYER_MAX_HP,
        maxHp: PLAYER_MAX_HP,
        color: startColor,
        kills: 0,
        keys: {}, // { w: false, a: false, s: false, d: false }
        isShooting: false,
        lastShotTick: 0,
        dead: false,
        respawnTick: 0,
    };
    ws.playerId = playerId; // Сохраняем ID для легкого доступа при дисконнекте

    // Отправляем новому игроку его ID и текущее состояние игры
    ws.send(JSON.stringify({ type: 'init', payload: { id: playerId, initialState: gameState } }));

    // --- Обработка сообщений от клиента ---
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = gameState.players[playerId];
            if (!player || player.dead) return; // Не обрабатывать сообщения от мертвых или несуществующих

            switch (data.type) {
                case 'input':
                    // Обновляем состояние клавиш и угла прицеливания
                    if (data.payload.keys) {
                        player.keys = data.payload.keys;
                    }
                    if (typeof data.payload.angle === 'number') {
                         // Ограничиваем угол для безопасности
                        player.angle = Math.max(-Math.PI, Math.min(Math.PI, data.payload.angle));
                    }
                    if (typeof data.payload.shooting === 'boolean') {
                        player.isShooting = data.payload.shooting;
                    }
                    break;
                // Можно добавить другие типы сообщений (чат и т.д.)
            }
        } catch (error) {
            console.error('Failed to parse message or invalid message format:', message, error);
        }
    });

    // --- Обработка отключения клиента ---
    ws.on('close', () => {
        console.log(`Player ${playerId} disconnected.`);
        delete gameState.players[playerId];
        // Можно добавить broadcast об отключении другим игрокам
        broadcast({ type: 'player_left', payload: { id: playerId } });
    });

     ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId}:`, error);
        // Попробуем корректно удалить игрока при ошибке
        if (gameState.players[playerId]) {
            delete gameState.players[playerId];
            broadcast({ type: 'player_left', payload: { id: playerId } });
        }
    });
});

// --- Главный игровой цикл (Game Loop) ---
function gameLoop() {
    currentTick++;

    // --- Обновление состояния ---
    updatePlayers();
    updateBullets();
    checkCollisions();
    handleRespawns();

    // --- Рассылка состояния всем клиентам ---
    // Оптимизация: можно отправлять только изменения (дельты), но для простоты шлем всё
    broadcast({ type: 'update', payload: gameState });

    // --- Запуск следующего тика ---
    // Используем setTimeout вместо setInterval для большей точности при нагрузке
    setTimeout(gameLoop, 1000 / TICK_RATE);
}

// --- Вспомогательные функции обновления ---

function updatePlayers() {
    for (const id in gameState.players) {
        const player = gameState.players[id];
        if (player.dead) continue;

        // Движение
        let dx = 0;
        let dy = 0;
        if (player.keys.w) dy -= PLAYER_SPEED;
        if (player.keys.s) dy += PLAYER_SPEED;
        if (player.keys.a) dx -= PLAYER_SPEED;
        if (player.keys.d) dx += PLAYER_SPEED;

        // Нормализация диагонального движения (чтобы не было быстрее)
        if (dx !== 0 && dy !== 0) {
            const magnitude = Math.sqrt(dx * dx + dy * dy);
            dx = (dx / magnitude) * PLAYER_SPEED;
            dy = (dy / magnitude) * PLAYER_SPEED;
        }

        player.x += dx;
        player.y += dy;

        // Ограничение по карте
        player.x = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.y));

        // Стрельба
        if (player.isShooting && currentTick - player.lastShotTick >= SHOOT_COOLDOWN) {
            player.lastShotTick = currentTick;
            createBullet(player);
        }
    }
}

function createBullet(player) {
    const bulletId = nextBulletId++;
    const bullet = {
        id: bulletId,
        ownerId: player.id,
        x: player.x + Math.cos(player.angle) * (player.radius + BULLET_RADIUS + 1), // Позиция чуть впереди пушки
        y: player.y + Math.sin(player.angle) * (player.radius + BULLET_RADIUS + 1),
        radius: BULLET_RADIUS,
        angle: player.angle,
        speed: BULLET_SPEED,
        damage: BULLET_DAMAGE,
        ticksLeft: BULLET_LIFESPAN,
    };
    gameState.bullets.push(bullet);
}

function updateBullets() {
    gameState.bullets = gameState.bullets.filter(bullet => {
        bullet.x += Math.cos(bullet.angle) * bullet.speed;
        bullet.y += Math.sin(bullet.angle) * bullet.speed;
        bullet.ticksLeft--;

        // Удаляем пули за границами карты или с истекшим временем жизни
        return bullet.ticksLeft > 0 &&
               bullet.x > -bullet.radius && bullet.x < MAP_SIZE + bullet.radius &&
               bullet.y > -bullet.radius && bullet.y < MAP_SIZE + bullet.radius;
    });
}

function checkCollisions() {
    const bulletsToRemove = new Set();

    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        if (bulletsToRemove.has(bullet.id)) continue;

        for (const playerId in gameState.players) {
            const player = gameState.players[playerId];
            // Нельзя попасть в себя, в мертвых или в игроков на респавне
            if (player.id === bullet.ownerId || player.dead) continue;

            const dx = player.x - bullet.x;
            const dy = player.y - bullet.y;
            const distanceSq = dx * dx + dy * dy; // Сравниваем квадраты для оптимизации (избегаем sqrt)
            const radiiSumSq = (player.radius + bullet.radius) * (player.radius + bullet.radius);

            if (distanceSq < radiiSumSq) {
                // Попадание!
                player.hp -= bullet.damage;
                bulletsToRemove.add(bullet.id); // Помечаем пулю на удаление

                if (player.hp <= 0) {
                    player.hp = 0;
                    player.dead = true;
                    player.respawnTick = currentTick + RESPAWN_DELAY;
                    console.log(`Player ${player.id} killed by Player ${bullet.ownerId}`);

                    // Даем килл стрелявшему, если он еще существует
                    const killer = gameState.players[bullet.ownerId];
                    if (killer) {
                        killer.kills++;
                    }
                    // Можно добавить broadcast о смерти
                    broadcast({ type: 'player_died', payload: { victimId: player.id, killerId: bullet.ownerId } });
                }
                // Выходим из внутреннего цикла, т.к. пуля уже попала
                break;
            }
        }
    }
    // Удаляем пули, которые попали
     if (bulletsToRemove.size > 0) {
        gameState.bullets = gameState.bullets.filter(bullet => !bulletsToRemove.has(bullet.id));
    }
}

function handleRespawns() {
     for (const id in gameState.players) {
        const player = gameState.players[id];
        if (player.dead && currentTick >= player.respawnTick) {
            player.dead = false;
            player.hp = player.maxHp;
            player.x = Math.random() * (MAP_SIZE - 100) + 50;
            player.y = Math.random() * (MAP_SIZE - 100) + 50;
            player.keys = {}; // Сброс нажатых клавиш
            player.isShooting = false;
             console.log(`Player ${player.id} respawned.`);
             // Можно добавить broadcast о респавне
            broadcast({ type: 'player_respawn', payload: { id: player.id, x: player.x, y: player.y, hp: player.hp } });
        }
    }
}

// --- Функция рассылки сообщений всем клиентам ---
function broadcast(message) {
    const messageString = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
}

// --- Запуск игрового цикла ---
gameLoop();
