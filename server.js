// server.js
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Server Setup ---
const server = http.createServer((req, res) => {
    // Serve the index.html file
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

// --- Game Constants ---
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 3;
const PLAYER_MAX_HEALTH = 100;
const BULLET_RADIUS = 8;
const BULLET_SPEED = 7;
const BULLET_DAMAGE = 10;
const BULLET_LIFESPAN = 1000; // ms
const SHOOT_COOLDOWN = 200; // ms
const RESPAWN_DELAY = 3000; // ms
const GAME_TICK_RATE = 1000 / 60; // 60 FPS

// --- Game State ---
let players = {}; // Store player data { id: { ws, x, y, angle, health, score, lastShotTime, input, dead, respawnTimer } }
let bullets = {}; // Store bullet data { id: { ownerId, x, y, vx, vy, damage, creationTime } }
let nextPlayerId = 0;
let nextBulletId = 0;

// --- Helper Functions ---
function generatePlayerId() {
    return `p_${nextPlayerId++}`;
}

function generateBulletId() {
    return `b_${nextBulletId++}`;
}

function getRandomPosition() {
    return {
        x: Math.random() * (MAP_WIDTH - PLAYER_RADIUS * 2) + PLAYER_RADIUS,
        y: Math.random() * (MAP_HEIGHT - PLAYER_RADIUS * 2) + PLAYER_RADIUS
    };
}

function distance(obj1, obj2) {
    return Math.sqrt(Math.pow(obj1.x - obj2.x, 2) + Math.pow(obj1.y - obj2.y, 2));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

// --- WebSocket Logic ---
wss.on('connection', (ws) => {
    const playerId = generatePlayerId();
    console.log(`Player ${playerId} connected.`);

    const startPos = getRandomPosition();
    players[playerId] = {
        ws: ws,
        id: playerId,
        x: startPos.x,
        y: startPos.y,
        angle: 0,
        health: PLAYER_MAX_HEALTH,
        maxHealth: PLAYER_MAX_HEALTH,
        score: 0,
        lastShotTime: 0,
        input: { left: false, right: false, up: false, down: false },
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        dead: false,
        respawnTimer: null
    };

    // Send the new player their ID and initial game state
    ws.send(JSON.stringify({ type: 'welcome', playerId: playerId, initialState: getFullGameState() }));

    // Send the new player info to all other players
    broadcast({ type: 'playerJoined', player: getPublicPlayerData(players[playerId]) }, ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const player = players[playerId];
            if (!player || player.dead) return; // Ignore input if player doesn't exist or is dead

            switch (data.type) {
                case 'input':
                    player.input = data.input;
                    break;
                case 'angle':
                    // Basic validation
                    if (typeof data.angle === 'number') {
                        player.angle = data.angle;
                    }
                    break;
                case 'shoot':
                    handleShoot(player);
                    break;
            }
        } catch (error) {
            console.error(`Failed to parse message or invalid message format: ${message}`, error);
        }
    });

    ws.on('close', () => {
        console.log(`Player ${playerId} disconnected.`);
        if (players[playerId] && players[playerId].respawnTimer) {
             clearTimeout(players[playerId].respawnTimer);
        }
        delete players[playerId];
        // Notify other players
        broadcast({ type: 'playerLeft', playerId: playerId });
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId}: ${error}`);
        // Handle disconnection on error as well
        if (players[playerId] && players[playerId].respawnTimer) {
             clearTimeout(players[playerId].respawnTimer);
        }
        delete players[playerId];
        broadcast({ type: 'playerLeft', playerId: playerId });
    });
});

// --- Game Logic Functions ---

function handleShoot(player) {
    const now = Date.now();
    if (now - player.lastShotTime >= SHOOT_COOLDOWN) {
        player.lastShotTime = now;
        const bulletId = generateBulletId();

        // Calculate bullet velocity based on player angle
        const vx = Math.cos(player.angle) * BULLET_SPEED;
        const vy = Math.sin(player.angle) * BULLET_SPEED;

        // Spawn bullet slightly in front of the player
        const bulletX = player.x + Math.cos(player.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1);
        const bulletY = player.y + Math.sin(player.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 1);

        bullets[bulletId] = {
            id: bulletId,
            ownerId: player.id,
            x: bulletX,
            y: bulletY,
            vx: vx,
            vy: vy,
            damage: BULLET_DAMAGE,
            creationTime: now,
        };
    }
}

function updatePlayerPosition(player) {
    if (player.dead) return;

    let dx = 0;
    let dy = 0;
    if (player.input.left) dx -= 1;
    if (player.input.right) dx += 1;
    if (player.input.up) dy -= 1;
    if (player.input.down) dy += 1;

    // Normalize diagonal movement
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    if (magnitude > 0) {
        dx = (dx / magnitude) * PLAYER_SPEED;
        dy = (dy / magnitude) * PLAYER_SPEED;
    }

    player.x += dx;
    player.y += dy;

    // Clamp position to map boundaries
    player.x = clamp(player.x, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    player.y = clamp(player.y, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);
}

function updateBulletPositions() {
    const now = Date.now();
    for (const bulletId in bullets) {
        const bullet = bullets[bulletId];
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        // Remove bullets that go out of bounds or expire
        if (bullet.x < 0 || bullet.x > MAP_WIDTH ||
            bullet.y < 0 || bullet.y > MAP_HEIGHT ||
            now - bullet.creationTime > BULLET_LIFESPAN) {
            delete bullets[bulletId];
        }
    }
}

function handleCollisions() {
    const bulletIdsToRemove = [];
    const playersHit = {}; // Track hits per player per tick { playerId: damage }

    for (const bulletId in bullets) {
        const bullet = bullets[bulletId];
        if (bulletIdsToRemove.includes(bulletId)) continue; // Already marked for removal

        for (const playerId in players) {
            const player = players[playerId];
            if (player.dead || player.id === bullet.ownerId) continue; // Can't shoot self or dead players

            const dist = distance(bullet, player);
            if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
                // Hit detected
                if (!playersHit[playerId]) {
                    playersHit[playerId] = 0;
                }
                playersHit[playerId] += bullet.damage;

                // Mark bullet for removal
                bulletIdsToRemove.push(bulletId);

                 // Give score to the shooter
                const shooter = players[bullet.ownerId];
                if (shooter && !shooter.dead) { // Check if shooter still exists and is not dead
                    shooter.score += 1; // Simple score per hit
                }
                break; // A bullet hits only one player
            }
        }
    }

    // Apply damage and check for deaths
    for (const playerId in playersHit) {
        const player = players[playerId];
        if (player) { // Player might have disconnected between collision check and damage application
            player.health -= playersHit[playerId];
            if (player.health <= 0 && !player.dead) {
                 handlePlayerDeath(player, players[bullets[Object.keys(bullets).find(bid => bullets[bid].ownerId === playerId)].ownerId]); // Find the killer (approximation)
            }
        }
    }

    // Remove hit bullets
    bulletIdsToRemove.forEach(id => delete bullets[id]);
}

function handlePlayerDeath(player, killer) {
    console.log(`Player ${player.id} died.`);
    player.dead = true;
    player.health = 0;

    if(killer && killer !== player) { // Killer exists and is not the player themselves
       killer.score += 10; // Bonus score for the kill
    }


    // Send death notification immediately
    broadcast({ type: 'playerDied', playerId: player.id, killerId: killer ? killer.id : null });

    // Schedule respawn
    player.respawnTimer = setTimeout(() => {
        if (players[player.id]) { // Check if player still connected
             const respawnPos = getRandomPosition();
             player.x = respawnPos.x;
             player.y = respawnPos.y;
             player.health = PLAYER_MAX_HEALTH;
             player.dead = false;
             player.input = { left: false, right: false, up: false, down: false }; // Reset input
             player.angle = 0;
             player.respawnTimer = null;
             console.log(`Player ${player.id} respawned.`);
             // Notify everyone about the respawn (implicitly handled by next state update)
        }
    }, RESPAWN_DELAY);
}


// --- Game Loop ---
function gameLoop() {
    // 1. Update Player Positions
    for (const playerId in players) {
        updatePlayerPosition(players[playerId]);
    }

    // 2. Update Bullet Positions
    updateBulletPositions();

    // 3. Handle Collisions
    handleCollisions();

    // 4. Broadcast Game State
    broadcast(getFullGameState());

    // Schedule next tick
    setTimeout(gameLoop, GAME_TICK_RATE);
}

// --- State Transmission ---
function getPublicPlayerData(player) {
    // Only send necessary data to clients
    return {
        id: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle,
        health: player.health,
        maxHealth: player.maxHealth,
        score: player.score,
        color: player.color,
        dead: player.dead
    };
}

function getPublicBulletData(bullet) {
     return {
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
     };
}


function getFullGameState() {
    const state = {
        type: 'update',
        players: {},
        bullets: {}
    };
    for (const playerId in players) {
        state.players[playerId] = getPublicPlayerData(players[playerId]);
    }
     for (const bulletId in bullets) {
        state.bullets[bulletId] = getPublicBulletData(bullets[bulletId]);
    }
    return state;
}

function broadcast(data, senderWs = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        // Broadcast to clients that are ready and optionally skip the sender
        if (client.readyState === WebSocket.OPEN && client !== senderWs) {
            client.send(message);
        }
    });
}

// --- Start Server ---
const PORT = process.env.PORT || 3000; // Use Render's port or 3000 locally
server.listen(PORT, '0.0.0.0', () => { // Listen on 0.0.0.0 for Render
    console.log(`Server listening on port ${PORT}`);
    // Start the game loop
    gameLoop();
});

console.log('Dipper.io server starting...');
