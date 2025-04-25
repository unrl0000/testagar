// server.js
// ... (начало файла без изменений) ...
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Game Constants ---
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const PLAYER_RADIUS = 15;
const PLAYER_SPEED = 2.5; // Base speed units per tick (approx) - Adjust based on loop frequency!
const ORB_RADIUS = 5;
const ORB_COUNT = 150;
const XP_PER_ORB = 10;
const XP_TO_LEVEL_2 = 100;
const PLAYER_MAX_HP = 100;
const PROJECTILE_RADIUS = 5;
const PROJECTILE_BASE_SPEED = 7; // Base speed
const PROJECTILE_BASE_DAMAGE = 10;
const ATTACK_COOLDOWN = 500; // milliseconds
const MELEE_BASE_RANGE = PLAYER_RADIUS * 2.5;
const LIFESTEAL_PERCENT = 0.1; // 10% for Lord Vampires
const GAME_LOOP_RATE = 1000 / 60; // Target loop rate (ms) -> ~60 FPS

// --- Game State ---
let players = new Map();
let orbs = new Map();
let projectiles = new Map();
let lastUpdateTime = Date.now(); // Moved outside loop for delta time calc

// --- Player Data Structure ---
function createPlayer(id, ws, name, race) {
    const raceData = getRaceBaseStats(race);
    return {
        id: id,
        ws: ws,
        name: name,
        x: Math.random() * (MAP_WIDTH - 100) + 50,
        y: Math.random() * (MAP_HEIGHT - 100) + 50,
        // Client Prediction relevant: Server stores authoritative state
        // Velocities are less important server-side if client sends directional input
        hp: raceData.hp,
        maxHp: raceData.hp,
        level: 1,
        xp: 0,
        race: race,
        classOrMutation: null,
        color: raceData.color,
        radius: PLAYER_RADIUS,
        speed: raceData.speed, // Player's specific speed stat
        attackCooldown: 0,
        lastInput: { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0, seq: 0 }, // Added sequence number
        lastProcessedInputSeq: 0, // For prediction reconciliation
        isDead: false,
        killCount: 0,
        canChooseLevel2: false,
        stats: { ...raceData.stats }
    };
}

function getRaceBaseStats(race) {
    const base = { hp: PLAYER_MAX_HP, speed: PLAYER_SPEED, color: '#ffffff', stats: { damage: 10, range: 0, lifesteal: 0, projectileSpeed: PROJECTILE_BASE_SPEED, attackSpeedModifier: 1, meleeAngle: Math.PI / 4 } }; // Added meleeAngle
    switch (race) {
        case 'human': base.color = '#4287f5'; break;
        case 'elf': base.color = '#34eb4f'; base.speed *= 1.1; break;
        case 'gnome': base.color = '#a67b5b'; base.hp *= 1.1; break;
        case 'vampire': base.color = '#d92525'; base.stats.lifesteal = 0.02; break;
        case 'goblin': base.color = '#6a706b'; base.speed *= 1.05; base.hp *= 0.9; break;
    }
    base.maxHp = base.hp;
    return base;
}

function applyLevel2Specialization(player, choice) {
    player.classOrMutation = choice;
    player.canChooseLevel2 = false;

    const baseRaceStats = getRaceBaseStats(player.race);
    // Retain current HP percentage
    const hpPercent = player.maxHp > 0 ? player.hp / player.maxHp : 1;

    // Reset stats derived from race/base before applying class/mutation specifics
    player.speed = baseRaceStats.speed;
    player.maxHp = baseRaceStats.hp;
    player.stats = { ...baseRaceStats.stats }; // Crucial: reset derived stats

    switch (choice) {
        case 'warrior':
            player.maxHp *= 1.3;
            player.stats.damage = 15; // Base Warrior Damage
            player.stats.range = MELEE_BASE_RANGE;
            player.stats.meleeAngle = Math.PI / 3.5; // Wider swing
            player.color = lightenDarkenColor(player.color, -20);
            break;
        case 'mage':
            player.maxHp *= 0.9;
            player.stats.damage = PROJECTILE_BASE_DAMAGE; // Mage projectile damage
            player.stats.range = 400; // Mage projectile range
            player.stats.projectileSpeed = PROJECTILE_BASE_SPEED * 1.1;
            player.stats.attackSpeedModifier = 0.8;
            player.color = lightenDarkenColor(player.color, 20);
            break;
        case 'lord':
            player.maxHp *= 1.1;
            player.stats.damage = 12; // Lord melee damage
            player.stats.range = MELEE_BASE_RANGE * 1.1; // Slightly longer reach
            player.stats.lifesteal = LIFESTEAL_PERCENT;
            player.stats.meleeAngle = Math.PI / 4; // Standard swing
            player.color = '#a11b1b';
            break;
        case 'higher':
            player.speed *= 1.2;
            player.stats.damage = 10; // Higher Vamp melee damage (faster attacks compensate)
            player.stats.range = MELEE_BASE_RANGE;
            player.stats.lifesteal = 0.05;
            player.stats.attackSpeedModifier = 0.7; // Faster attacks
            player.stats.meleeAngle = Math.PI / 4.5; // Narrower, faster swing
            player.color = '#f75454';
            break;
        case 'king':
            player.maxHp *= 1.4;
            player.stats.damage = 13; // King melee damage
            player.stats.range = MELEE_BASE_RANGE * 0.9; // Shorter reach
            player.stats.meleeAngle = Math.PI / 3; // Wide swing
            player.color = '#494d4a';
            break;
        case 'hobgoblin':
            player.maxHp *= 1.2;
            player.speed *= 0.85;
            player.stats.damage = 20; // Hobgoblin high melee damage
            player.stats.range = MELEE_BASE_RANGE * 1.1;
            player.stats.attackSpeedModifier = 1.2; // Slower attacks
            player.stats.meleeAngle = Math.PI / 4; // Standard swing, but slow/heavy
            player.color = '#819185';
            break;
    }

     // Set HP based on the new maxHp and old percentage
    player.hp = Math.max(1, Math.round(player.maxHp * hpPercent)); // Ensure at least 1 HP

    // Notify client about the update
    safeSend(player.ws, JSON.stringify({ type: 'classSelected', player: getPlayerDataForClient(player) }));
}

// --- Orb Logic ---
function spawnOrb() {
    if (orbs.size < ORB_COUNT) {
        const orbId = uuidv4();
        orbs.set(orbId, {
            id: orbId,
            x: Math.random() * MAP_WIDTH,
            y: Math.random() * MAP_HEIGHT,
            radius: ORB_RADIUS,
            value: XP_PER_ORB,
            color: '#f0e370'
        });
    }
}

// --- Projectile Logic ---
function createProjectile(owner) {
    // Check range > melee threshold, cooldown, and if aiming coords exist
    if (!owner.lastInput || owner.attackCooldown > 0 || !owner.stats.range || owner.stats.range <= MELEE_BASE_RANGE * 1.2 || owner.lastInput.mouseX === undefined) {
        // console.log(`Projectile creation blocked for ${owner.name}: cd=${owner.attackCooldown > 0}, range=${owner.stats.range}, input=${!!owner.lastInput}, mouseX=${owner.lastInput?.mouseX}`);
        return;
    }

    const projId = uuidv4();
    // Calculate angle based on the *world coordinates* sent by client's input
    const angle = Math.atan2(owner.lastInput.mouseY - owner.y, owner.lastInput.mouseX - owner.x);
    const speed = owner.stats.projectileSpeed || PROJECTILE_BASE_SPEED;
    const damage = owner.stats.damage || PROJECTILE_BASE_DAMAGE;

    projectiles.set(projId, {
        id: projId,
        ownerId: owner.id,
        x: owner.x + Math.cos(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        y: owner.y + Math.sin(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        radius: PROJECTILE_RADIUS,
        damage: damage,
        color: lightenDarkenColor(owner.color, 30),
        rangeLeft: owner.stats.range // Use the player's range stat
    });

     console.log(`Player ${owner.name} fired projectile ${projId} at angle ${angle.toFixed(2)}`);

    owner.attackCooldown = ATTACK_COOLDOWN / (owner.stats.attackSpeedModifier || 1);
}

// --- Melee Attack Logic ---
function performMeleeAttack(attacker) {
     if (!attacker.lastInput || attacker.attackCooldown > 0 || !attacker.stats.range || attacker.stats.range > MELEE_BASE_RANGE * 1.2 || attacker.lastInput.mouseX === undefined) {
        // console.log(`Melee blocked for ${attacker.name}: cd=${attacker.attackCooldown > 0}, range=${attacker.stats.range}, input=${!!attacker.lastInput}, mouseX=${attacker.lastInput?.mouseX}`);
         return;
     }

    attacker.attackCooldown = ATTACK_COOLDOWN / (attacker.stats.attackSpeedModifier || 1);
    const attackAngle = Math.atan2(attacker.lastInput.mouseY - attacker.y, attacker.lastInput.mouseX - attacker.x);
    const reach = attacker.stats.range || MELEE_BASE_RANGE;
    const swingArc = attacker.stats.meleeAngle || (Math.PI / 4); // Use specific angle or default

    console.log(`Player ${attacker.name} attempting melee: angle=${attackAngle.toFixed(2)}, reach=${reach.toFixed(1)}, arc=${swingArc.toFixed(2)}`);

    let hitSomeone = false;
     for (const [targetId, target] of players) {
         if (targetId === attacker.id || target.isDead) continue;

         const dist = distance(attacker.x, attacker.y, target.x, target.y);
         // Check if target is within reach + target radius
         if (dist < reach + target.radius) {
              const targetAngle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
              const angleDiff = Math.abs(normalizeAngle(attackAngle - targetAngle));

             // Check if target is within the attack cone (swing arc)
             if (angleDiff < swingArc / 2) { // Check within half the arc on either side
                 console.log(`   > Melee HIT! Target: ${target.name}, dist=${dist.toFixed(1)}, angleDiff=${angleDiff.toFixed(2)} vs arc/2=${(swingArc/2).toFixed(2)}`);
                 dealDamage(target, attacker.stats.damage, attacker);
                 hitSomeone = true;
                 // break; // Decide if melee hits multiple targets or just the first one in arc
             } else {
                  // console.log(`   > Melee MISS (Angle): Target: ${target.name}, dist=${dist.toFixed(1)}, angleDiff=${angleDiff.toFixed(2)} > arc/2=${(swingArc/2).toFixed(2)}`);
             }
         } //else { console.log(`   > Melee MISS (Range): Target: ${target.name}, dist=${dist.toFixed(1)} > reach+radius=${(reach + target.radius).toFixed(1)}`); }
     }
     if (!hitSomeone) {
         console.log(`   > Melee swing missed all targets.`);
     }
     // Optional: Send visual effect indication for melee broadcast?
}


// --- Damage & Death ---
function dealDamage(target, damage, dealer) {
    if (!target || target.isDead || damage <= 0) return;

    const actualDamage = Math.round(damage); // Ensure whole numbers for HP
    target.hp -= actualDamage;
    console.log(`Dealing ${actualDamage} damage to ${target.name} (HP: ${target.hp}/${target.maxHp}) from ${dealer ? dealer.name : 'Unknown'}`);


    // Lifesteal (check if dealer exists and has the stat)
    if (dealer && players.has(dealer.id) && dealer.stats && dealer.stats.lifesteal > 0 && !dealer.isDead) {
        const healAmount = Math.max(1, Math.round(actualDamage * dealer.stats.lifesteal));
        dealer.hp = Math.min(dealer.maxHp, dealer.hp + healAmount);
        // console.log(`   > ${dealer.name} lifesteals ${healAmount} HP (now ${dealer.hp}/${dealer.maxHp})`);
    }

    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        // Stop movement on death
        target.lastInput = { ...target.lastInput, up:false, down:false, left:false, right:false, attack:false };
        console.log(`!!! ${target.name} killed by ${dealer ? dealer.name : 'Unknown'}`);

        // Grant XP to dealer if they exist and are alive
        if (dealer && players.has(dealer.id) && !dealer.isDead) {
             const xpDrop = Math.min(Math.floor(target.xp / 2 + 50), 500); // Drop XP based on victim's XP
             console.log(`   > ${dealer.name} gains ${xpDrop} XP for the kill.`);
             dealer.xp += xpDrop;
             dealer.killCount = (dealer.killCount || 0) + 1; // Initialize killCount if undefined
             checkLevelUp(dealer);
        } else {
            console.log("   > Killer not found or dead, no XP awarded.");
        }

        // Respawn logic
        setTimeout(() => {
            if (players.has(target.id)) { // Check player still connected
                 console.log(`Respawning ${target.name}...`);
                 const raceData = getRaceBaseStats(target.race);
                 target.x = Math.random() * (MAP_WIDTH - 100) + 50;
                 target.y = Math.random() * (MAP_HEIGHT - 100) + 50;
                 target.isDead = false;
                 target.xp = Math.floor(target.xp * 0.5); // Lose 50% XP on death
                 target.level = 1; // Reset to level 1 always? Or keep level 2+ status? Let's reset class for now.
                 target.classOrMutation = null;
                 target.stats = { ...raceData.stats }; // Reset stats to base race
                 target.maxHp = raceData.hp;
                 target.hp = target.maxHp; // Respawn with full base HP
                 target.speed = raceData.speed;
                 target.color = raceData.color;
                 target.killCount = 0;
                 target.canChooseLevel2 = false; // Reset level up flag
                 target.attackCooldown = 0; // Reset attack cooldown

                 // Send respawn confirmation/full update?
                 // The regular game state update should handle showing them again.
                 console.log(`${target.name} respawned.`);
            } else {
                console.log(`Player ${target.id} disconnected before respawn.`);
            }
        }, 5000); // 5 second respawn timer
    } else {
        // Send HP update (included in regular state update)
    }
}

// --- Leveling ---
function checkLevelUp(player) {
    if (player.level === 1 && player.xp >= XP_TO_LEVEL_2 && !player.canChooseLevel2) {
        player.level = 2;
        player.canChooseLevel2 = true; // Set flag
        safeSend(player.ws, JSON.stringify({ type: 'levelUpReady' }));
        console.log(`${player.name} reached Level 2! Waiting for class selection.`);
    }
    // Future levels...
}

// --- Utility Functions ---
// distance, normalizeAngle, lightenDarkenColor, safeSend (no changes needed)
function distance(x1, y1, x2, y2) { return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2)); }
function normalizeAngle(angle) { while (angle <= -Math.PI) angle += 2 * Math.PI; while (angle > Math.PI) angle -= 2 * Math.PI; return angle; }
function lightenDarkenColor(col, amt) { let usePound = false; if (col[0] == "#") { col = col.slice(1); usePound = true; } let num = parseInt(col, 16); let r = (num >> 16) + amt; if (r > 255) r = 255; else if (r < 0) r = 0; let b = ((num >> 8) & 0x00FF) + amt; if (b > 255) b = 255; else if (b < 0) b = 0; let g = (num & 0x0000FF) + amt; if (g > 255) g = 255; else if (g < 0) g = 0; return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0'); }
function safeSend(ws, data) { if (ws.readyState === WebSocket.OPEN) { ws.send(data); } }

// --- Game Loop ---
function gameLoop() {
    const now = Date.now();
    // Use fixed delta time for physics consistency, or calculate actual delta
    // Using actual delta time might be smoother if loop rate varies
    const deltaTime = (now - lastUpdateTime) / 1000.0; // Delta time in seconds
    lastUpdateTime = now;
    // Cap delta time to prevent huge jumps if server lags
    const cappedDeltaTime = Math.min(deltaTime, 0.05); // Cap at 50ms (20 FPS min)


    // 1. Process Inputs & Update Player States (Movement, Cooldowns)
    players.forEach(player => {
        if (player.isDead) return;

        // Apply movement based on last received input
        let moveX = 0;
        let moveY = 0;
        if (player.lastInput.up) moveY -= 1;
        if (player.lastInput.down) moveY += 1;
        if (player.lastInput.left) moveX -= 1;
        if (player.lastInput.right) moveX += 1;

        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
        let actualSpeed = player.speed * 60; // Adjust speed based on expected ticks/sec (60)

        if (magnitude > 0) {
            // Normalize and apply speed * delta time
            player.x += (moveX / magnitude) * actualSpeed * cappedDeltaTime;
            player.y += (moveY / magnitude) * actualSpeed * cappedDeltaTime;
        }

        // Clamp position to map boundaries
        player.x = Math.max(player.radius, Math.min(MAP_WIDTH - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(MAP_HEIGHT - player.radius, player.y));

        // Attack Cooldown Update
        if (player.attackCooldown > 0) {
            player.attackCooldown -= cappedDeltaTime * 1000; // Decrease cooldown in ms
        }

        // Process Attack Input (Server validates)
        if (player.lastInput.attack && player.attackCooldown <= 0) {
            if (player.level < 2 || !player.classOrMutation) {
                 // Basic level 1 melee attack
                 player.stats.range = MELEE_BASE_RANGE * 0.7; // Shorter range
                 player.stats.damage = 5; // Low damage
                 player.stats.meleeAngle = Math.PI / 5; // Narrow arc
                 performMeleeAttack(player);
             } else if (player.stats.range > MELEE_BASE_RANGE * 1.2) { // Ranged check threshold
                 createProjectile(player);
             } else { // Melee attack for specialized classes/mutations
                 performMeleeAttack(player);
             }
             // Consume the attack flag for this tick if it was processed
             // Note: Client might send attack=true multiple times, cooldown handles rate limit
             // player.lastInput.attack = false; // Probably not needed server side, cooldown is king
        }
         // Store the sequence number of the last processed input for client reconciliation
         player.lastProcessedInputSeq = player.lastInput.seq;
    });

    // 2. Update Projectiles & Check Collisions
    const projectilesToRemove = [];
    projectiles.forEach(proj => {
        // Move projectile based on its velocity * delta time
        const moveDist = Math.sqrt(proj.dx*proj.dx + proj.dy*proj.dy) * cappedDeltaTime * 60; // Adjust speed based on 60fps baseline
        proj.x += proj.dx * cappedDeltaTime * 60;
        proj.y += proj.dy * cappedDeltaTime * 60;
        proj.rangeLeft -= moveDist; // Decrease range by distance traveled

        if (proj.rangeLeft <= 0 || proj.x < 0 || proj.x > MAP_WIDTH || proj.y < 0 || proj.y > MAP_HEIGHT) {
            projectilesToRemove.push(proj.id);
            return;
        }

        // Check projectile collision with players
        for (const [targetId, target] of players) {
            if (targetId === proj.ownerId || target.isDead) continue;

            const dist = distance(proj.x, proj.y, target.x, target.y);
            if (dist < target.radius + proj.radius) {
                console.log(`Projectile ${proj.id} HIT ${target.name}`);
                const owner = players.get(proj.ownerId); // Get owner ref for lifesteal etc.
                dealDamage(target, proj.damage, owner);
                projectilesToRemove.push(proj.id);
                 break; // Projectile hits one target and is removed
            }
        }
    });
    projectilesToRemove.forEach(id => projectiles.delete(id));

    // 3. Check Player-Orb Collisions
    const orbsToRemove = [];
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return;

        orbs.forEach(orb => {
            const dist = distance(player.x, player.y, orb.x, orb.y);
            if (dist < player.radius + orb.radius) {
                player.xp += orb.value;
                orbsToRemove.push(orb.id);
                console.log(`${player.name} collected orb, XP: ${player.xp}`);
                checkLevelUp(player);
            }
        });
    });
    orbsToRemove.forEach(id => orbs.delete(id));

    // 4. Spawn new orbs periodically
    if (Math.random() < 0.15) { // Slightly higher chance
        spawnOrb();
    }

    // 5. Prepare State Update for Clients
    const playersData = [];
    players.forEach(p => {
        playersData.push(getPlayerDataForClient(p)); // Send dead player state too, client can handle rendering
    });
    const orbsData = Array.from(orbs.values());
    const projectilesData = Array.from(projectiles.values());

    const gameState = {
        type: 'gameState',
        timestamp: Date.now(), // Add server timestamp
        players: playersData,
        orbs: orbsData,
        projectiles: projectilesData
        // Add lastProcessedInputSeq for self? Handled per player in playersData
    };
    const gameStateString = JSON.stringify(gameState);

    // 6. Broadcast State to all connected clients
    wss.clients.forEach(client => {
        // Add check for player existence? Or just send state always.
        safeSend(client, gameStateString);
    });
}

// Function to get player data suitable for sending to clients
function getPlayerDataForClient(player) {
    return {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        hp: player.hp,
        maxHp: player.maxHp,
        level: player.level,
        xp: player.xp,
        race: player.race,
        classOrMutation: player.classOrMutation,
        color: player.color,
        radius: player.radius,
        isDead: player.isDead,
        canChooseLevel2: player.canChooseLevel2,
        lastProcessedInputSeq: player.lastProcessedInputSeq // Include for client prediction reconciliation
        // Don't send speed/stats unless needed for display, calculation is server-side
    };
}


// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Client attempting connection... ID assigned: ${playerId}`);
    let currentPlayer = null; // Set only after 'join' message

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

             // First message must be 'join' to associate WS with a player
             if (!currentPlayer && data.type !== 'join') {
                 console.warn(`Received non-join message from uninitialized client ${playerId}. Ignoring.`);
                 return;
             }

            switch (data.type) {
                case 'join':
                    if (!players.has(playerId)) { // Prevent re-joining
                         const name = data.name ? data.name.substring(0, 16) : 'Anon';
                         const race = data.race || 'human';
                         if (!['human', 'elf', 'gnome', 'vampire', 'goblin'].includes(race)) {
                             console.warn(`Invalid race "${race}" for player ${playerId}. Defaulting to human.`);
                             race = 'human';
                         }
                         currentPlayer = createPlayer(playerId, ws, name, race);
                         players.set(playerId, currentPlayer);
                         ws.playerId = playerId; // Associate player ID with the WebSocket object
                         console.log(`Player ${currentPlayer.name} (${currentPlayer.race}) joined with ID ${playerId}`);

                        // Send welcome message with initial data
                        safeSend(ws, JSON.stringify({
                            type: 'welcome',
                            playerId: playerId,
                            mapWidth: MAP_WIDTH,
                            mapHeight: MAP_HEIGHT,
                            initialState: { // Send initial state immediately
                                players: Array.from(players.values()).map(getPlayerDataForClient),
                                orbs: Array.from(orbs.values()),
                                projectiles: Array.from(projectiles.values())
                            }
                        }));
                    } else {
                        console.warn(`Player ${playerId} attempted to join again.`);
                    }
                    break;

                case 'input':
                    // Ensure currentPlayer is set (should be after 'join')
                    if (currentPlayer && players.has(playerId) && data.input && typeof data.input.seq === 'number') {
                        // Basic validation/sanitization?
                        currentPlayer.lastInput = {
                            up: !!data.input.up,
                            down: !!data.input.down,
                            left: !!data.input.left,
                            right: !!data.input.right,
                            attack: !!data.input.attack,
                            mouseX: parseFloat(data.input.mouseX) || currentPlayer.x, // Default to current pos if invalid
                            mouseY: parseFloat(data.input.mouseY) || currentPlayer.y,
                            seq: data.input.seq // Store sequence number
                        };
                         // Input is processed in the next gameLoop tick
                    } else if (!currentPlayer) {
                        console.warn(`Received input from uninitialized client ${playerId}.`);
                    }
                    break;

                 case 'selectClass':
                     if (currentPlayer && players.has(playerId) && currentPlayer.level === 2 && currentPlayer.canChooseLevel2 && data.choice) {
                         // Validate choice based on race?
                         // TODO: Add validation logic here based on currentPlayer.race
                         console.log(`Player ${currentPlayer.name} selected class/mutation: ${data.choice}`);
                         applyLevel2Specialization(currentPlayer, data.choice);
                     }
                     break;

                case 'ping': // Simple ping mechanism for latency check (optional)
                    safeSend(ws, JSON.stringify({ type: 'pong', clientTime: data.time }));
                    break;

            }
        } catch (error) {
            console.error(`Failed to process message for player ${playerId || 'Unknown'}:`, message, error);
        }
    });

    ws.on('close', () => {
        const closedPlayerId = ws.playerId; // Get ID associated during join
        if (closedPlayerId && players.has(closedPlayerId)) {
            const player = players.get(closedPlayerId);
            console.log(`Client disconnected: ${player.name} (${closedPlayerId})`);
            players.delete(closedPlayerId);
             // Broadcast disconnect? Optional. Game state update will remove them.
        } else {
            console.log(`Unidentified client disconnected (ID: ${playerId}).`);
        }
    });

    ws.onerror = (error) => {
         const errorPlayerId = ws.playerId;
        if (errorPlayerId && players.has(errorPlayerId)) {
             const player = players.get(errorPlayerId);
             console.error(`WebSocket error for ${player.name} (${errorPlayerId}): `, error);
             players.delete(errorPlayerId); // Remove player on error
        } else {
             console.error(`WebSocket error for unidentified client (Assigned ID: ${playerId}): `, error);
        }
    };
});

// --- Static File Serving & Server Start ---
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Game (Spawn Orbs, Start Loop)
console.log("Initializing game state...");
for (let i = 0; i < ORB_COUNT * 0.8; i++) { spawnOrb(); }
console.log(`Spawned ${orbs.size} initial orbs.`);

lastUpdateTime = Date.now(); // Initialize lastUpdateTime before first loop call
setInterval(gameLoop, GAME_LOOP_RATE); // Use constant loop rate
console.log(`Game loop started with rate: ${GAME_LOOP_RATE.toFixed(2)}ms`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- RuneRealms.io Server listening on port ${PORT} ---`);
    console.log(`Access the game at http://localhost:${PORT} (or your Render URL)`);
});
