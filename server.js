// server.js
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
const PLAYER_BASE_SPEED = 2.5; // Base speed units per tick (~16.67ms) -> 150 units/sec
const ORB_RADIUS = 5;
const ORB_COUNT = 150;
const XP_PER_ORB = 10;
const XP_TO_LEVEL_2 = 100;
const PLAYER_MAX_HP = 100;
const PROJECTILE_RADIUS = 5;
const PROJECTILE_BASE_SPEED = 7; // ~420 units/sec
const PROJECTILE_BASE_DAMAGE = 10;
const ATTACK_COOLDOWN = 500; // milliseconds
const MELEE_BASE_RANGE = PLAYER_RADIUS * 2.5;
const LIFESTEAL_PERCENT = 0.1;
const GAME_LOOP_RATE = 1000 / 60; // Target loop rate (ms) -> ~60 FPS
const RESPAWN_TIME = 5000; // 5 seconds
const MAX_XP_DROP = 300; // Max XP dropped on death
const XP_LOSS_PERCENT = 0.5; // Lose 50% XP on death

// --- Game State ---
// Using Maps for efficient addition/removal/lookup by ID
let players = new Map(); // Map<playerId, playerData>
let orbs = new Map(); // Map<orbId, orbData>
let projectiles = new Map(); // Map<projectileId, projectileData>
let lastUpdateTime = Date.now();

// --- Player Data Structure ---
// Keep essential state needed for simulation and client updates
function createPlayer(id, ws, name, race) {
    const raceData = getRaceBaseStats(race);
    return {
        id: id,
        ws: ws, // WebSocket connection reference
        name: name,
        x: Math.random() * (MAP_WIDTH - 100) + 50,
        y: Math.random() * (MAP_HEIGHT - 100) + 50,
        hp: raceData.hp,
        maxHp: raceData.hp,
        level: 1,
        xp: 0,
        race: race,
        classOrMutation: null,
        color: raceData.color,
        radius: PLAYER_RADIUS,
        speed: raceData.speed, // Current speed stat
        attackCooldown: 0, // Timestamp when next attack is allowed
        lastInput: { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0, seq: 0 },
        lastProcessedInputSeq: 0, // For client prediction reconciliation
        isDead: false,
        killCount: 0,
        canChooseLevel2: false,
        stats: { ...raceData.stats } // Holds damage, range, lifesteal, etc.
    };
}

function getRaceBaseStats(race) {
    // Define base stats shared by all races
    const base = {
        hp: PLAYER_MAX_HP,
        speed: PLAYER_BASE_SPEED,
        color: '#ffffff',
        stats: {
            damage: 10, // Base damage for calculations
            range: 0,   // Base range (0 for default melee?)
            lifesteal: 0,
            projectileSpeed: PROJECTILE_BASE_SPEED,
            attackSpeedModifier: 1, // 1 = normal, <1 = faster, >1 = slower
            meleeAngle: Math.PI / 4 // Default attack arc
        }
    };
    // Apply race-specific modifications
    switch (race) {
        case 'human': base.color = '#4287f5'; break;
        case 'elf': base.color = '#34eb4f'; base.speed *= 1.1; break; // Faster
        case 'gnome': base.color = '#a67b5b'; base.hp *= 1.1; break; // Tankier
        case 'vampire': base.color = '#d92525'; base.stats.lifesteal = 0.02; break; // Innate lifesteal
        case 'goblin': base.color = '#6a706b'; base.speed *= 1.05; base.hp *= 0.9; break; // Faster, less HP
    }
    base.maxHp = base.hp; // Ensure maxHp matches initial HP
    return base;
}

function applyLevel2Specialization(player, choice) {
    if (!player || player.level !== 2 || !player.canChooseLevel2) return; // Guard condition

    player.classOrMutation = choice;
    player.canChooseLevel2 = false; // Mark choice as made

    const baseRaceStats = getRaceBaseStats(player.race);
    const hpPercent = player.maxHp > 0 ? player.hp / player.maxHp : 1; // Preserve HP percentage

    // Reset core stats before applying specialization
    player.speed = baseRaceStats.speed;
    player.maxHp = baseRaceStats.hp;
    player.stats = { ...baseRaceStats.stats }; // CRITICAL: Reset stats object

    // Apply specialization bonuses/changes (Ensure these match client prediction estimates if used)
    switch (choice) {
        case 'warrior':
            player.maxHp *= 1.3;
            player.stats.damage = 15; player.stats.range = MELEE_BASE_RANGE; player.stats.meleeAngle = Math.PI / 3.5;
            player.color = lightenDarkenColor(player.color, -20); break;
        case 'mage':
            player.maxHp *= 0.9;
            player.stats.damage = PROJECTILE_BASE_DAMAGE; player.stats.range = 400; player.stats.projectileSpeed = PROJECTILE_BASE_SPEED * 1.1; player.stats.attackSpeedModifier = 0.8;
            player.color = lightenDarkenColor(player.color, 20); break;
        case 'lord':
            player.maxHp *= 1.1;
            player.stats.damage = 12; player.stats.range = MELEE_BASE_RANGE * 1.1; player.stats.lifesteal = LIFESTEAL_PERCENT; player.stats.meleeAngle = Math.PI / 4;
            player.color = '#a11b1b'; break;
        case 'higher':
            player.speed *= 1.2;
            player.stats.damage = 10; player.stats.range = MELEE_BASE_RANGE; player.stats.lifesteal = 0.05; player.stats.attackSpeedModifier = 0.7; player.stats.meleeAngle = Math.PI / 4.5;
            player.color = '#f75454'; break;
        case 'king':
            player.maxHp *= 1.4;
            player.stats.damage = 13; player.stats.range = MELEE_BASE_RANGE * 0.9; player.stats.meleeAngle = Math.PI / 3;
            player.color = '#494d4a'; break;
        case 'hobgoblin':
            player.maxHp *= 1.2; player.speed *= 0.85;
            player.stats.damage = 20; player.stats.range = MELEE_BASE_RANGE * 1.1; player.stats.attackSpeedModifier = 1.2; player.stats.meleeAngle = Math.PI / 4;
            player.color = '#819185'; break;
    }

    player.hp = Math.max(1, Math.round(player.maxHp * hpPercent)); // Recalculate HP

    safeSend(player.ws, JSON.stringify({ type: 'classSelected', player: getPlayerDataForClient(player) }));
    console.log(`Player ${player.name} specialized into ${choice}. HP: ${player.hp}/${player.maxHp}`);
}

// --- Orb Logic ---
function spawnOrb() {
    if (orbs.size >= ORB_COUNT) return; // Optimization: Check count early
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

// --- Projectile Logic ---
function createProjectile(owner, currentTime) {
    // Guard conditions: Check cooldown, if ranged, has target coords
    if (currentTime < owner.attackCooldown || !owner.stats.range || owner.stats.range <= MELEE_BASE_RANGE * 1.2 || owner.lastInput.mouseX === undefined) return;

    const projId = uuidv4();
    const angle = Math.atan2(owner.lastInput.mouseY - owner.y, owner.lastInput.mouseX - owner.x);
    const speed = owner.stats.projectileSpeed || PROJECTILE_BASE_SPEED;
    const damage = owner.stats.damage || PROJECTILE_BASE_DAMAGE;

    projectiles.set(projId, {
        id: projId,
        ownerId: owner.id,
        x: owner.x + Math.cos(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        y: owner.y + Math.sin(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        dx: Math.cos(angle) * speed, // Store velocity components
        dy: Math.sin(angle) * speed,
        radius: PROJECTILE_RADIUS,
        damage: damage,
        color: lightenDarkenColor(owner.color, 30),
        rangeLeft: owner.stats.range
    });

    // Set next allowed attack time
    owner.attackCooldown = currentTime + (ATTACK_COOLDOWN / (owner.stats.attackSpeedModifier || 1));
    // console.log(`Player ${owner.name} fired projectile ${projId}. Next attack at: ${owner.attackCooldown.toFixed(0)}`); // DEBUG
}

// --- Melee Attack Logic ---
function performMeleeAttack(attacker, currentTime) {
    // Guard conditions: Check cooldown, if melee, has target coords
    if (currentTime < attacker.attackCooldown || !attacker.stats.range || attacker.stats.range > MELEE_BASE_RANGE * 1.2 || attacker.lastInput.mouseX === undefined) return;

    const attackAngle = Math.atan2(attacker.lastInput.mouseY - attacker.y, attacker.lastInput.mouseX - attacker.x);
    const reach = attacker.stats.range || MELEE_BASE_RANGE;
    const swingArc = attacker.stats.meleeAngle || (Math.PI / 4);
    const halfArc = swingArc / 2;
    const damage = attacker.stats.damage || 5; // Use stat damage or fallback

    // console.log(`Player ${attacker.name} attempting melee at ${currentTime.toFixed(0)}`); // DEBUG

    let hit = false;
    // Optimization: Iterate using players.values() might be slightly faster if Map order doesn't matter
    for (const target of players.values()) {
        if (target.id === attacker.id || target.isDead) continue; // Skip self and dead players

        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const distSq = dx*dx + dy*dy; // Optimization: Use squared distance check first
        const combinedRadius = reach + target.radius;

        if (distSq < combinedRadius * combinedRadius) { // Check distance first
            const targetAngle = Math.atan2(dy, dx);
            const angleDiff = Math.abs(normalizeAngle(attackAngle - targetAngle));

            if (angleDiff < halfArc) { // Check if within angle
                // console.log(`   > Melee HIT! Target: ${target.name}`); // DEBUG
                dealDamage(target, damage, attacker); // Pass attacker for lifesteal etc.
                hit = true;
                // break; // Uncomment if melee should only hit one target per swing
            }
        }
    }

    // Set next allowed attack time regardless of hit or miss
    attacker.attackCooldown = currentTime + (ATTACK_COOLDOWN / (attacker.stats.attackSpeedModifier || 1));
    // if (!hit) console.log(`   > Melee swing missed.`); // DEBUG
}

// --- Damage & Death ---
function dealDamage(target, damage, dealer) {
    if (!target || target.isDead || damage <= 0) return;

    const actualDamage = Math.round(damage);
    target.hp -= actualDamage;
    // console.log(`Dealing ${actualDamage} damage to ${target.name} (HP: ${target.hp}/${target.maxHp})`); // DEBUG

    // Lifesteal (check dealer exists, is alive, and has lifesteal stat)
    if (dealer && players.has(dealer.id) && !dealer.isDead && dealer.stats?.lifesteal > 0) {
        const healAmount = Math.max(1, Math.round(actualDamage * dealer.stats.lifesteal));
        dealer.hp = Math.min(dealer.maxHp, dealer.hp + healAmount);
        // console.log(`   > ${dealer.name} lifesteals ${healAmount} HP`); // DEBUG
    }

    // Check for death
    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        // Reset input state on death server-side to stop ghost movement processing
        target.lastInput = { ...target.lastInput, up:false, down:false, left:false, right:false, attack:false };
        console.log(`!!! ${target.name} killed by ${dealer ? dealer.name : 'Unknown'}`);

        // Grant XP to dealer
        if (dealer && players.has(dealer.id) && !dealer.isDead) {
             const xpDrop = Math.min(Math.floor(target.xp * (1 - XP_LOSS_PERCENT) + 50), MAX_XP_DROP); // Drop XP based on victim's XP (after loss)
             dealer.xp += xpDrop;
             dealer.killCount = (dealer.killCount || 0) + 1;
             console.log(`   > ${dealer.name} gains ${xpDrop} XP (Total: ${dealer.xp}). Kills: ${dealer.killCount}`);
             checkLevelUp(dealer);
        }

        // Schedule respawn
        setTimeout(() => respawnPlayer(target.id), RESPAWN_TIME);
    }
}

function respawnPlayer(playerId) {
    const player = players.get(playerId);
    if (!player) { // Player might have disconnected
        console.log(`Player ${playerId} not found for respawn.`);
        return;
    }
    if (!player.isDead) { // Already respawned or didn't die?
        console.log(`Player ${player.name} is not dead, skipping respawn.`);
        return;
    }

    console.log(`Respawning ${player.name}...`);
    const raceData = getRaceBaseStats(player.race);
    player.x = Math.random() * (MAP_WIDTH - 100) + 50;
    player.y = Math.random() * (MAP_HEIGHT - 100) + 50;
    player.isDead = false;
    player.xp = Math.floor(player.xp * XP_LOSS_PERCENT); // Lose XP
    player.level = 1; // Reset level and class/mutation
    player.classOrMutation = null;
    player.canChooseLevel2 = false;
    player.stats = { ...raceData.stats }; // Reset stats
    player.maxHp = raceData.hp;
    player.hp = player.maxHp; // Full HP
    player.speed = raceData.speed;
    player.color = raceData.color;
    player.killCount = 0;
    player.attackCooldown = 0; // Reset attack cooldown
    player.lastProcessedInputSeq = player.lastInput.seq; // Sync sequence number on respawn

    console.log(`${player.name} respawned at ${player.x.toFixed(0)},${player.y.toFixed(0)} with ${player.xp} XP.`);
    // Player state will be updated in the next broadcast
}


// --- Leveling ---
function checkLevelUp(player) {
    // Only handle level 1 -> 2 for now
    if (player.level === 1 && player.xp >= XP_TO_LEVEL_2 && !player.canChooseLevel2) {
        player.level = 2;
        player.canChooseLevel2 = true;
        safeSend(player.ws, JSON.stringify({ type: 'levelUpReady' }));
        console.log(`${player.name} reached Level 2! Choice enabled.`);
    }
}

// --- Utility Functions ---
function distanceSq(x1, y1, x2, y2) { const dx = x1 - x2; const dy = y1 - y2; return dx*dx + dy*dy; } // Use squared distance for comparisons
function normalizeAngle(angle) { while (angle <= -Math.PI) angle += 2 * Math.PI; while (angle > Math.PI) angle -= 2 * Math.PI; return angle; }
function lightenDarkenColor(col, amt) { let usePound = false; if (col[0] == "#") { col = col.slice(1); usePound = true; } let num = parseInt(col, 16); let r = (num >> 16) + amt; if (r > 255) r = 255; else if (r < 0) r = 0; let b = ((num >> 8) & 0x00FF) + amt; if (b > 255) b = 255; else if (b < 0) b = 0; let g = (num & 0x0000FF) + amt; if (g > 255) g = 255; else if (g < 0) g = 0; return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0'); }
function safeSend(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(data); } } // Added check for ws existence

// --- Game Loop ---
function gameLoop() {
    const currentTime = Date.now();
    const deltaTime = (currentTime - lastUpdateTime) / 1000.0; // Delta time in seconds
    lastUpdateTime = currentTime;
    // Cap delta time to prevent physics explosion on lag spikes
    const cappedDeltaTime = Math.min(deltaTime, 0.05); // Max 50ms step (equiv. to 20 FPS)
    const speedMultiplier = 60 * cappedDeltaTime; // Multiplier to adjust speed based on 60fps baseline

    // --- Update Players ---
    players.forEach(player => {
        if (player.isDead) return; // Skip dead players

        // 1. Apply Movement based on last input
        let moveX = 0;
        let moveY = 0;
        if (player.lastInput.up) moveY -= 1;
        if (player.lastInput.down) moveY += 1;
        if (player.lastInput.left) moveX -= 1;
        if (player.lastInput.right) moveX += 1;

        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
        if (magnitude > 0) {
            const actualSpeed = player.speed; // Use the player's current speed stat
            player.x += (moveX / magnitude) * actualSpeed * speedMultiplier;
            player.y += (moveY / magnitude) * actualSpeed * speedMultiplier;
            // Clamp to map boundaries
            player.x = Math.max(player.radius, Math.min(MAP_WIDTH - player.radius, player.x));
            player.y = Math.max(player.radius, Math.min(MAP_HEIGHT - player.radius, player.y));
        }

        // 2. Process Attack Input (Server validates cooldown & type)
        if (player.lastInput.attack) {
            if (player.level < 2 || !player.classOrMutation) {
                // Level 1 basic melee
                player.stats.range = MELEE_BASE_RANGE * 0.7; player.stats.damage = 5; player.stats.meleeAngle = Math.PI / 5;
                performMeleeAttack(player, currentTime);
            } else if (player.stats.range > MELEE_BASE_RANGE * 1.2) { // Ranged check
                createProjectile(player, currentTime);
            } else { // Melee attack for specialized classes
                performMeleeAttack(player, currentTime);
            }
             // Attack flag processed, server relies on cooldown for rate limiting
        }

        // 3. Update last processed input sequence for client reconciliation
        player.lastProcessedInputSeq = player.lastInput.seq;
    });

    // --- Update Projectiles ---
    const projectilesToRemove = [];
    projectiles.forEach(proj => {
        // Move projectile
        proj.x += proj.dx * speedMultiplier;
        proj.y += proj.dy * speedMultiplier;
        // Calculate distance traveled (approximation)
        const distTraveled = Math.sqrt(proj.dx*proj.dx + proj.dy*proj.dy) * speedMultiplier;
        proj.rangeLeft -= distTraveled;

        // Check range or out of bounds
        if (proj.rangeLeft <= 0 || proj.x < 0 || proj.x > MAP_WIDTH || proj.y < 0 || proj.y > MAP_HEIGHT) {
            projectilesToRemove.push(proj.id);
            return;
        }

        // Check collision with players
        // Optimization: Check only against players potentially nearby (requires spatial partitioning - skipping for now)
        for (const target of players.values()) {
            if (target.id === proj.ownerId || target.isDead) continue; // Skip owner and dead

            const hitDistSq = (target.radius + proj.radius) * (target.radius + proj.radius);
            if (distanceSq(proj.x, proj.y, target.x, target.y) < hitDistSq) {
                // console.log(`Projectile ${proj.id} HIT ${target.name}`); // DEBUG
                const owner = players.get(proj.ownerId);
                dealDamage(target, proj.damage, owner);
                projectilesToRemove.push(proj.id); // Remove projectile on hit
                return; // Projectile hits one target and is removed
            }
        }
    });
    // Remove projectiles marked for deletion
    projectilesToRemove.forEach(id => projectiles.delete(id));

    // --- Update Orbs ---
    const orbsToRemove = [];
    // Iterate players first, then check nearby orbs (minor optimization if player count << orb count)
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return; // Skip dead or choosing class

        const collectRadiusSq = (player.radius + ORB_RADIUS) * (player.radius + ORB_RADIUS);
        // Check orbs (Optimization: check only nearby orbs - requires spatial partitioning)
        orbs.forEach(orb => {
            if (distanceSq(player.x, player.y, orb.x, orb.y) < collectRadiusSq) {
                player.xp += orb.value;
                orbsToRemove.push(orb.id);
                // console.log(`${player.name} collected orb, XP: ${player.xp}`); // DEBUG
                checkLevelUp(player);
            }
        });
    });
    // Remove collected orbs (use Set for efficient unique removal if many players collect same orb in one tick)
    new Set(orbsToRemove).forEach(id => orbs.delete(id));


    // --- Spawn new orbs ---
    // Only spawn if needed and add some randomness
    if (orbs.size < ORB_COUNT && Math.random() < 0.2) {
        spawnOrb();
    }

    // --- Prepare State Update ---
    // Optimization: Prepare data arrays directly
    const playersData = [];
    players.forEach(p => playersData.push(getPlayerDataForClient(p))); // Include dead players for client UI
    const orbsData = Array.from(orbs.values()); // Simple array is fine
    const projectilesData = Array.from(projectiles.values());

    const gameState = {
        type: 'gameState',
        timestamp: currentTime, // Include server timestamp for interpolation
        players: playersData,
        orbs: orbsData,
        projectiles: projectilesData
    };
    // Optimization: Avoid stringifying multiple times if sending same data to many clients
    // Consider pre-stringifying or using a more efficient broadcast method if available
    const gameStateString = JSON.stringify(gameState);

    // --- Broadcast State ---
    // Optimization: Iterate wss.clients only once
    wss.clients.forEach(client => {
        // Check if client is OPEN and potentially associated with a player (ws.playerId is set)
        // Although sending to connecting clients before 'join' is harmless here.
        if (client.readyState === WebSocket.OPEN) {
             // Consider sending delta updates or using client-specific culling here for major optimization
            client.send(gameStateString); // Using safeSend is redundant if we check readyState here
        }
    });
}

// Function to get player data suitable for sending to clients
// Only include data the client actually needs for rendering and basic prediction/UI
function getPlayerDataForClient(player) {
    return {
        id: player.id,
        name: player.name,
        x: player.x, // Authoritative position
        y: player.y,
        hp: player.hp,
        maxHp: player.maxHp,
        level: player.level,
        xp: player.xp, // Needed for XP bar UI
        race: player.race, // Needed for class choice logic on client
        classOrMutation: player.classOrMutation,
        color: player.color,
        radius: player.radius,
        isDead: player.isDead,
        canChooseLevel2: player.canChooseLevel2,
        lastProcessedInputSeq: player.lastProcessedInputSeq // Essential for prediction reconciliation
        // killCount: player.killCount // Optional: needed for kill count UI
    };
}


// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const tempId = uuidv4().substring(0, 8); // Temporary ID for logging before join
    console.log(`Client connecting... (Temp ID: ${tempId})`);
    ws.isAlive = true; // For heartbeat/ping
    ws.on('pong', () => { ws.isAlive = true; }); // Heartbeat response

    let playerId = null; // Will be set on 'join' message

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

             // Client must join first
             if (!playerId && data.type !== 'join') {
                 console.warn(`(${tempId}) Non-join message before joining. Type: ${data.type}. Ignoring.`);
                 return;
             }

            const player = players.get(playerId); // Get player reference *after* check

            switch (data.type) {
                case 'join':
                    if (playerId) { // Already joined
                        console.warn(`(${player.name}) Attempted to join again. Ignoring.`);
                        return;
                    }
                     // Assign permanent ID based on UUID
                     playerId = uuidv4();
                     ws.playerId = playerId; // Associate WS with player ID

                     const name = data.name ? data.name.substring(0, 16).trim() : 'Anon';
                     let race = data.race || 'human';
                     if (!['human', 'elf', 'gnome', 'vampire', 'goblin'].includes(race)) {
                         console.warn(`(${tempId}) Invalid race "${race}". Defaulting to human.`);
                         race = 'human';
                     }

                     const newPlayer = createPlayer(playerId, ws, name, race);
                     players.set(playerId, newPlayer);
                     console.log(`Player ${newPlayer.name} (${newPlayer.race}) joined with ID ${playerId}`);

                    // Send welcome message with initial state needed by client IMMEDIATELY
                    safeSend(ws, JSON.stringify({
                        type: 'welcome',
                        playerId: playerId,
                        mapWidth: MAP_WIDTH,
                        mapHeight: MAP_HEIGHT,
                        // Send current state so client doesn't start blank
                        initialState: {
                            players: Array.from(players.values()).map(getPlayerDataForClient),
                            orbs: Array.from(orbs.values()),
                            projectiles: Array.from(projectiles.values())
                        },
                         // Send necessary constants for prediction
                         constants: {
                              PLAYER_BASE_SPEED: PLAYER_BASE_SPEED,
                              BASE_TICK_RATE: 1000 / GAME_LOOP_RATE // Ticks per second
                         }
                    }));
                    break;

                case 'input':
                    // Basic validation
                    if (!player || typeof data.input?.seq !== 'number') {
                         console.warn(`(${playerId}) Invalid input received. Ignoring.`);
                         return;
                    }
                    // Update player's last input state (processed in next game loop)
                    // Sanitize boolean inputs, parse floats for mouse coords
                    player.lastInput = {
                        up: !!data.input.up,
                        down: !!data.input.down,
                        left: !!data.input.left,
                        right: !!data.input.right,
                        attack: !!data.input.attack,
                        mouseX: parseFloat(data.input.mouseX) || player.x,
                        mouseY: parseFloat(data.input.mouseY) || player.y,
                        seq: data.input.seq
                    };
                    break;

                 case 'selectClass':
                     if (!player) return; // Should not happen if joined
                     // Validate choice based on race and level state
                     const validChoices = {
                         human: ['warrior', 'mage'], elf: ['warrior', 'mage'], gnome: ['warrior', 'mage'],
                         vampire: ['lord', 'higher'], goblin: ['king', 'hobgoblin']
                     };
                     if (player.level === 2 && player.canChooseLevel2 && validChoices[player.race]?.includes(data.choice)) {
                         console.log(`Player ${player.name} selected class/mutation: ${data.choice}`);
                         applyLevel2Specialization(player, data.choice);
                     } else {
                         console.warn(`(${player.name}) Invalid class selection attempt: choice=${data.choice}, level=${player.level}, canChoose=${player.canChooseLevel2}, race=${player.race}`);
                     }
                     break;

                case 'ping': // Client-side ping request
                    safeSend(ws, JSON.stringify({ type: 'pong', clientTime: data.time }));
                    break;
            }
        } catch (error) {
            console.error(`Failed to process message for player ${playerId || tempId}:`, message, error);
            // Consider disconnecting client on repeated errors?
        }
    });

    ws.on('close', () => {
        if (playerId && players.has(playerId)) {
            const player = players.get(playerId);
            console.log(`Player ${player.name} (${playerId}) disconnected.`);
            players.delete(playerId);
             // Broadcast disconnect? Not strictly necessary, game state update handles removal
        } else {
            console.log(`Client (${tempId}) disconnected before joining.`);
        }
    });

    ws.onerror = (error) => {
        console.error(`WebSocket error for ${playerId || tempId}: `, error);
        // Clean up player if connection breaks unexpectedly
        if (playerId && players.has(playerId)) {
             const player = players.get(playerId);
             console.log(`Removing player ${player.name} (${playerId}) due to error.`);
             players.delete(playerId);
        }
    };
});

// --- Heartbeat/Ping ---
// Periodically check for dead connections
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
             console.log(`Client ${ws.playerId || '(unidentified)'} failed heartbeat. Terminating.`);
             ws.terminate(); // Force close connection
             // Cleanup player associated with this ws if needed (handled by ws.on('close'))
             return;
        }
        ws.isAlive = false; // Expect a pong back before next check
        ws.ping(() => {}); // Send ping
    });
}, 30000); // Check every 30 seconds

wss.on('close', () => { // Clear interval when server stops
    clearInterval(heartbeatInterval);
});


// --- Static File Serving & Server Start ---
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Game
console.log("Initializing game state...");
for (let i = 0; i < ORB_COUNT * 0.8; i++) { spawnOrb(); }
console.log(`Spawned ${orbs.size} initial orbs.`);

lastUpdateTime = Date.now(); // Initialize before starting loop
setInterval(gameLoop, GAME_LOOP_RATE); // Use constant loop rate
console.log(`Game loop started at ${GAME_LOOP_RATE.toFixed(2)}ms interval (~${(1000/GAME_LOOP_RATE).toFixed(1)} FPS)`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- RuneRealms.io Server listening on port ${PORT} ---`);
});

// --- Utility Functions (Keep at end or move to separate file) ---
// distanceSq, normalizeAngle, lightenDarkenColor, safeSend defined above near usage
