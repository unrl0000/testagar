// server.js
const WebSocket = require('ws');
const http = require('http');

// --- Settings ---
const PORT = process.env.PORT || 3000; // Важно для Render.com
const TICK_RATE = 30; // Updates per second
const MAP_SIZE = 2000;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 250 / TICK_RATE; // Pixels per tick
const BULLET_RADIUS = 8;
const BULLET_SPEED = 500 / TICK_RATE; // Pixels per tick
const BULLET_LIFESPAN = 1.5 * TICK_RATE; // Ticks
const PLAYER_MAX_HEALTH = 100;
const BULLET_DAMAGE = 10;
const RESPAWN_TIME = 3 * 1000; // milliseconds

// --- Game State ---
const players = {}; // { id: { x, y, angle, health, color, name, lastInputTime, dead, respawnTimer } }
const bullets = {}; // { id: { x, y, angle, ownerId, life } }
let nextBulletId = 0;

// --- Helper Functions ---
function generateId() {
    return Math.random().toString(36).substring(2, 15);
}

function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function distance(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// --- Server Setup ---
const server = http.createServer((req, res) => {
    // Простая заглушка для HTTP запросов, если нужно будет отдавать HTML не через WS
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ server });

console.log(`WebSocket server started on port ${PORT}`);

wss.on('connection', (ws) => {
    const playerId = generateId();
    const player = {
        id: playerId,
        x: Math.random() * (MAP_SIZE - 100) + 50,
        y: Math.random() * (MAP_SIZE - 100) + 50,
        angle: 0,
        health: PLAYER_MAX_HEALTH,
        color: getRandomColor(),
        name: "Player " + Math.floor(Math.random() * 1000),
        inputs: { left: false, right: false, up: false, down: false },
        mouse: { x: 0, y: 0, down: false },
        lastUpdateTime: Date.now(),
        dead: false,
        respawnTimer: null,
        score: 0, // Добавим счет
    };
    players[playerId] = player;
    ws.playerId = playerId; // Связываем ID с WebSocket соединением

    console.log(`Player ${playerId} (${player.name}) connected.`);

    // Отправляем новому игроку его ID и текущее состояние игры
    ws.send(JSON.stringify({
        type: 'init',
        payload: {
            playerId: playerId,
            players: players,
            bullets: bullets,
            settings: { MAP_SIZE, PLAYER_RADIUS, BULLET_RADIUS, PLAYER_MAX_HEALTH }
        }
    }));

    // Оповещаем всех остальных о новом игроке
    broadcast({
        type: 'playerJoined',
        payload: { player: players[playerId] }
    }, ws); // Отправляем всем, кроме нового игрока

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[ws.playerId];
            if (!player || player.dead) return; // Игнорировать ввод от мертвого или несуществующего игрока

            player.lastUpdateTime = Date.now(); // Обновляем время активности

            switch (data.type) {
                case 'input':
                    player.inputs = data.payload.keys;
                    player.mouse = data.payload.mouse;
                    // Обновляем угол игрока на сервере
                    player.angle = Math.atan2(player.mouse.y - player.y, player.mouse.x - player.x);
                    break;
                case 'shoot':
                    if (!player.dead) {
                        spawnBullet(player);
                    }
                    break;
                case 'setName':
                    if (data.payload && typeof data.payload.name === 'string') {
                        player.name = data.payload.name.substring(0, 16); // Ограничиваем длину имени
                        broadcast({ type: 'nameUpdate', payload: { id: playerId, name: player.name } });
                    }
                    break;
                case 'ping': // Для замера задержки (не обязательно)
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (error) {
            console.error('Failed to process message:', message, error);
        }
    });

    ws.on('close', () => {
        console.log(`Player ${ws.playerId} disconnected.`);
        const disconnectedPlayer = players[ws.playerId];
        delete players[ws.playerId];
        // Оповещаем всех остальных об отключении
        broadcast({
            type: 'playerLeft',
            payload: { id: ws.playerId, name: disconnectedPlayer ? disconnectedPlayer.name : 'Unknown' }
        });
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${ws.playerId}:`, error);
        // Можно также обработать отключение здесь
        if (players[ws.playerId]) {
             const disconnectedPlayer = players[ws.playerId];
             delete players[ws.playerId];
             broadcast({ type: 'playerLeft', payload: { id: ws.playerId, name: disconnectedPlayer ? disconnectedPlayer.name : 'Unknown' } });
        }
    });
});

function spawnBullet(player) {
    const bulletId = `b${nextBulletId++}`;
    const bullet = {
        id: bulletId,
        ownerId: player.id,
        x: player.x + Math.cos(player.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1),
        y: player.y + Math.sin(player.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1),
        angle: player.angle,
        life: BULLET_LIFESPAN
    };
    bullets[bulletId] = bullet;
}

function updatePlayerPosition(player, dt) {
    let dx = 0;
    let dy = 0;
    if (player.inputs.left) dx -= 1;
    if (player.inputs.right) dx += 1;
    if (player.inputs.up) dy -= 1;
    if (player.inputs.down) dy += 1;

    // Нормализация диагонального движения
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    if (magnitude > 0) {
        dx = (dx / magnitude);
        dy = (dy / magnitude);
    }

    player.x += dx * PLAYER_SPEED;
    player.y += dy * PLAYER_SPEED;

    // Ограничение по карте
    player.x = clamp(player.x, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    player.y = clamp(player.y, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
}

function updateBulletPosition(bullet, dt) {
    bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
    bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
    bullet.life -= 1;
}

function checkCollisions() {
    const bulletIds = Object.keys(bullets);
    const playerIds = Object.keys(players);

    for (const bulletId of bulletIds) {
        const bullet = bullets[bulletId];
        if (!bullet) continue;

        // Столкновение пули со стенами
        if (bullet.x < 0 || bullet.x > MAP_SIZE || bullet.y < 0 || bullet.y > MAP_SIZE || bullet.life <= 0) {
            delete bullets[bulletId];
            continue;
        }

        // Столкновение пули с игроками
        for (const playerId of playerIds) {
            const player = players[playerId];
            if (!player || player.dead || player.id === bullet.ownerId) continue; // Не сталкиваться с собой или мертвыми

            const dist = distance(bullet.x, bullet.y, player.x, player.y);
            if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
                player.health -= BULLET_DAMAGE;
                delete bullets[bulletId]; // Пуля исчезает

                if (player.health <= 0) {
                    console.log(`Player ${player.id} (${player.name}) killed by ${bullet.ownerId}`);
                    player.dead = true;
                    player.health = 0;
                    // Добавляем очки убийце
                    if (players[bullet.ownerId]) {
                        players[bullet.ownerId].score += 1; // Увеличиваем счет убийцы
                    }
                    // Запускаем таймер респавна
                    player.respawnTimer = setTimeout(() => {
                        respawnPlayer(player);
                    }, RESPAWN_TIME);

                    // Оповещаем всех о смерти и обновлении счета
                    broadcast({ type: 'playerDied', payload: { victimId: player.id, killerId: bullet.ownerId, killerScore: players[bullet.ownerId]?.score ?? 0 } });
                } else {
                     // Оповещаем об изменении здоровья
                     broadcast({ type: 'healthUpdate', payload: { id: player.id, health: player.health }});
                }
                break; // Пуля может поразить только одного игрока
            }
        }
    }
}

function respawnPlayer(player) {
    if (!players[player.id]) return; // Игрок мог отключиться

    player.x = Math.random() * (MAP_SIZE - 100) + 50;
    player.y = Math.random() * (MAP_SIZE - 100) + 50;
    player.health = PLAYER_MAX_HEALTH;
    player.dead = false;
    player.respawnTimer = null;
    console.log(`Player ${player.id} respawned.`);

    // Оповещаем всех о респавне
    broadcast({ type: 'playerRespawned', payload: { player: player } });
}

// --- Game Loop ---
function gameLoop() {
    const now = Date.now();
    const dt = (now - (lastUpdateTime || now)) / 1000; // Delta time in seconds (не используется пока, но полезно)
    lastUpdateTime = now;

    // Update players
    for (const playerId in players) {
        const player = players[playerId];
        if (player.dead) continue;
        updatePlayerPosition(player, dt);
         // Обновляем угол игрока (можно делать и здесь, если не обновлять по каждому движению мыши)
        // player.angle = Math.atan2(player.mouse.y - player.y, player.mouse.x - player.x);
    }

    // Update bullets
    for (const bulletId in bullets) {
        updateBulletPosition(bullets[bulletId], dt);
    }

    // Check collisions
    checkCollisions();

    // Prepare state for broadcast
    const gameState = {
        players: {},
        bullets: bullets // Можно отправлять все пули или только изменения
    };
    // Отправляем только нужные данные об игроках
    for (const pId in players) {
        const p = players[pId];
        gameState.players[pId] = {
            x: p.x,
            y: p.y,
            angle: p.angle,
            color: p.color,
            name: p.name,
            health: p.health,
            dead: p.dead,
            score: p.score // Добавляем счет
        };
    }

    // Broadcast game state to all clients
    broadcast({ type: 'update', payload: gameState });

    // Проверка неактивных игроков (опционально)
    const kickTimeout = 60000; // 1 минута неактивности
     for (const playerId in players) {
         if (now - players[playerId].lastUpdateTime > kickTimeout) {
            const wsToKick = Array.from(wss.clients).find(client => client.playerId === playerId);
             if (wsToKick) {
                 console.log(`Kicking inactive player ${playerId}`);
                 wsToKick.close(1000, "Kicked due to inactivity"); // Закрываем соединение
             }
             // Удаление произойдет в ws.on('close')
         }
     }

}

let lastUpdateTime = Date.now();
setInterval(gameLoop, 1000 / TICK_RATE);

// --- Broadcast Function ---
function broadcast(message, senderWs = null) {
    const messageString = JSON.stringify(message);
    wss.clients.forEach((client) => {
        // Отправляем всем, кроме senderWs, если он указан
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT} (for WebSocket upgrades)`);
});
