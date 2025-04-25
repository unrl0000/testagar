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
const PLAYER_BASE_SPEED = 2.5; // Speed units per tick (~16.67ms) -> Total speed per second = BASE_SPEED * BASE_TICK_RATE (60 ticks/sec) = 150 units/sec
const ORB_RADIUS = 5;
const ORB_COUNT = 150;
const XP_PER_ORB = 10;
const XP_TO_LEVEL_2 = 100;
const PLAYER_MAX_HP = 100;
const PROJECTILE_RADIUS = 5;
const PROJECTILE_BASE_SPEED = 7; // Speed units per tick -> ~420 units/sec
const PROJECTILE_BASE_DAMAGE = 10;
const ATTACK_COOLDOWN = 500; // milliseconds
const MELEE_BASE_RANGE = PLAYER_RADIUS * 2.5;
const LIFESTEAL_PERCENT = 0.1;
const GAME_LOOP_RATE = 1000 / 60; // Target loop rate (ms) -> ~60 FPS
const RESPAWN_TIME = 5000; // 5 seconds
const MAX_XP_DROP = 300;
const XP_LOSS_PERCENT = 0.5;

// --- Game State ---
let players = new Map();
let orbs = new Map();
let projectiles = new Map();
let lastUpdateTime = Date.now();

// --- Player Data Structure ---
function createPlayer(id, ws, name, race) {
    const raceData = getRaceBaseStats(race);
    return {
        id: id,
        ws: ws,
        name: name,
        x: Math.random() * (MAP_WIDTH - 200) + 100, // Spawn further from edges
        y: Math.random() * (MAP_HEIGHT - 200) + 100,
        hp: raceData.hp,
        maxHp: raceData.hp,
        level: 1,
        xp: 0,
        race: race,
        classOrMutation: null,
        color: raceData.color,
        radius: PLAYER_RADIUS,
        speed: raceData.speed, // Store current speed stat
        attackCooldown: 0, // Timestamp when next attack is allowed
        lastInput: { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0, seq: 0 },
        lastProcessedInputSeq: 0,
        isDead: false,
        killCount: 0,
        canChooseLevel2: false,
        stats: { ...raceData.stats } // Store other stats
    };
}

function getRaceBaseStats(race) {
    const base = {
        hp: PLAYER_MAX_HP,
        speed: PLAYER_BASE_SPEED, // Use BASE_SPEED here
        color: '#ffffff',
        stats: {
            damage: 10,
            range: 0,
            lifesteal: 0,
            projectileSpeed: PROJECTILE_BASE_SPEED,
            attackSpeedModifier: 1,
            meleeAngle: Math.PI / 4
        }
    };
    switch (race) {
        case 'human': base.color = '#4287f5'; break;
        case 'elf': base.color = '#34eb4f'; base.speed = PLAYER_BASE_SPEED * 1.1; break; // Set modified speed
        case 'gnome': base.color = '#a67b5b'; base.hp = PLAYER_MAX_HP * 1.1; base.maxHp = base.hp; break; // Set modified HP
        case 'vampire': base.color = '#d92525'; base.stats.lifesteal = 0.02; break;
        case 'goblin': base.color = '#6a706b'; base.speed = PLAYER_BASE_SPEED * 1.05; base.hp = PLAYER_MAX_HP * 0.9; base.maxHp = base.hp; break;
    }
    // Ensure maxHp is set correctly from the potentially modified hp
    base.maxHp = base.hp;
    return base;
}

function applyLevel2Specialization(player, choice) {
    if (!player || player.level !== 2 || !player.canChooseLevel2) return;

    player.classOrMutation = choice;
    player.canChooseLevel2 = false;

    const baseRaceStats = getRaceBaseStats(player.race);
    const hpPercent = player.maxHp > 0 ? player.hp / player.maxHp : 1;

    // Reset and apply stats
    player.speed = baseRaceStats.speed; // Start from base race speed
    player.maxHp = baseRaceStats.hp;   // Start from base race hp
    player.stats = { ...baseRaceStats.stats }; // Reset stats object

    // Apply specialization bonuses/changes
    switch (choice) {
        case 'warrior':
            player.maxHp *= 1.3; player.stats.damage = 15; player.stats.range = MELEE_BASE_RANGE; player.stats.meleeAngle = Math.PI / 3.5; break;
        case 'mage':
            player.maxHp *= 0.9; player.stats.damage = PROJECTILE_BASE_DAMAGE; player.stats.range = 400; player.stats.projectileSpeed = PROJECTILE_BASE_SPEED * 1.1; player.stats.attackSpeedModifier = 0.8; break;
        case 'lord':
            player.maxHp *= 1.1; player.stats.damage = 12; player.stats.range = MELEE_BASE_RANGE * 1.1; player.stats.lifesteal = LIFESTEAL_PERCENT; player.stats.meleeAngle = Math.PI / 4; break;
        case 'higher':
            player.speed *= 1.2; player.stats.damage = 10; player.stats.range = MELEE_BASE_RANGE; player.stats.lifesteal = 0.05; player.stats.attackSpeedModifier = 0.7; player.stats.meleeAngle = Math.PI / 4.5; break;
        case 'king':
            player.maxHp *= 1.4; player.stats.damage = 13; player.stats.range = MELEE_BASE_RANGE * 0.9; player.stats.meleeAngle = Math.PI / 3; break;
        case 'hobgoblin':
            player.maxHp *= 1.2; player.speed *= 0.85; player.stats.damage = 20; player.stats.range = MELEE_BASE_RANGE * 1.1; player.stats.attackSpeedModifier = 1.2; player.stats.meleeAngle = Math.PI / 4; break;
    }

    player.hp = Math.max(1, Math.round(player.maxHp * hpPercent));

    safeSend(player.ws, JSON.stringify({ type: 'classSelected', player: getPlayerDataForClient(player) }));
    console.log(`Player ${player.name} specialized into ${choice}. Stats: HP=${player.hp}/${player.maxHp}, Speed=${player.speed.toFixed(2)}, Dmg=${player.stats.damage}, Range=${player.stats.range}`);
}

// --- Orb Logic ---
function spawnOrb() {
    if (orbs.size >= ORB_COUNT) return;
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
    if (currentTime < owner.attackCooldown || !owner.stats.range || owner.stats.range <= MELEE_BASE_RANGE * 1.2 || owner.lastInput.mouseX === undefined) return;

    const projId = uuidv4();
    const angle = Math.atan2(owner.lastInput.mouseY - owner.y, owner.lastInput.mouseX - owner.x);
    const speed = owner.stats.projectileSpeed || PROJECTILE_BASE_SPEED;
    const damage = owner.stats.damage || PROJECTILE_BASE_DAMAGE;

    projectiles.set(projId, {
        id: projId,
        ownerId: owner.id,
        x: owner.x + Math.cos(angle) * (owner.radius + PROJECTILE_RADIUS + 1), // Spawn just outside player radius
        y: owner.y + Math.sin(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        radius: PROJECTILE_RADIUS,
        damage: damage,
        color: lightenDarkenColor(owner.color, 30),
        rangeLeft: owner.stats.range
    });

    owner.attackCooldown = currentTime + (ATTACK_COOLDOWN / (owner.stats.attackSpeedModifier || 1));
    // console.log(`Player ${owner.name} fired projectile. Next attack at: ${owner.attackCooldown.toFixed(0)}`); // DEBUG
}

// --- Melee Attack Logic ---
function performMeleeAttack(attacker, currentTime) {
    if (currentTime < attacker.attackCooldown || !attacker.stats.range || attacker.stats.range > MELEE_BASE_RANGE * 1.2 || attacker.lastInput.mouseX === undefined) return;

    const attackAngle = Math.atan2(attacker.lastInput.mouseY - attacker.y, attacker.lastInput.mouseX - attacker.x);
    const reach = attacker.stats.range || MELEE_BASE_RANGE;
    const swingArc = attacker.stats.meleeAngle || (Math.PI / 4);
    const halfArc = swingArc / 2;
    const damage = attacker.stats.damage || 5;

    // console.log(`Player ${attacker.name} attempting melee at ${currentTime.toFixed(0)}`); // DEBUG

    let hit = false;
    const combinedReachSq = (reach + PLAYER_RADIUS * 0.5) * (reach + PLAYER_RADIUS * 0.5); // Slightly larger hitbox? Or just use target radius
     const combinedReachWithTargetRadiusSq = (reach + PLAYER_RADIUS + PLAYER_RADIUS) * (reach + PLAYER_RADIUS + PLAYER_RADIUS); // Using player radius as estimate for targets

    for (const target of players.values()) {
        if (target.id === attacker.id || target.isDead) continue;

        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const distSq = dx*dx + dy*dy;

        // Check distance first (using target's actual radius)
        const combinedRadiusSq = (reach + target.radius) * (reach + target.radius);
        if (distSq < combinedRadiusSq) {
            const targetAngle = Math.atan2(dy, dx);
            const angleDiff = Math.abs(normalizeAngle(attackAngle - targetAngle));

            // Check if within angle
            if (angleDiff < halfArc) {
                // console.log(`   > Melee HIT! Target: ${target.name} (dist: ${Math.sqrt(distSq).toFixed(1)}, angleDiff: ${angleDiff.toFixed(2)})`); // DEBUG
                dealDamage(target, damage, attacker);
                hit = true;
                // break; // Uncomment if melee hits only one target
            } // else { console.log(`   > Melee MISS (Angle)! Target: ${target.name} (angleDiff: ${angleDiff.toFixed(2)} >= ${halfArc.toFixed(2)})`); } // DEBUG
        } // else { console.log(`   > Melee MISS (Range)! Target: ${target.name} (dist: ${Math.sqrt(distSq).toFixed(1)} >= ${Math.sqrt(combinedRadiusSq).toFixed(1)})`); } // DEBUG
    }

    attacker.attackCooldown = currentTime + (ATTACK_COOLDOWN / (attacker.stats.attackSpeedModifier || 1));
    // if (!hit) console.log(`   > Melee swing processed (missed). Next attack at: ${attacker.attackCooldown.toFixed(0)}`); // DEBUG
    // else console.log(`   > Melee swing processed (hit). Next attack at: ${attacker.attackCooldown.toFixed(0)}`); // DEBUG
}

// --- Damage & Death ---
function dealDamage(target, damage, dealer) {
    if (!target || target.isDead || damage <= 0) return;

    const actualDamage = Math.round(damage);
    target.hp -= actualDamage;
    // console.log(`${dealer ? dealer.name : 'Unknown'} dealt ${actualDamage} damage to ${target.name} (HP: ${target.hp}/${target.maxHp})`); // DEBUG

    // Lifesteal
    if (dealer && players.has(dealer.id) && !dealer.isDead && dealer.stats?.lifesteal > 0) {
        const healAmount = Math.max(1, Math.round(actualDamage * dealer.stats.lifesteal));
        dealer.hp = Math.min(dealer.maxHp, dealer.hp + healAmount);
        // console.log(`   > ${dealer.name} lifesteals ${healAmount} HP (now ${dealer.hp}/${dealer.maxHp})`); // DEBUG
    }

    // Check for death
    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        // Reset input state on death
        target.lastInput = { up:false, down:false, left:false, right:false, attack:false, mouseX: target.x, mouseY: target.y, seq: target.lastInput.seq }; // Keep seq, but reset movement
        console.log(`!!! ${target.name} killed by ${dealer ? dealer.name : 'Unknown'}`);

        // Grant XP
        if (dealer && players.has(dealer.id) && !dealer.isDead) {
             const xpDrop = Math.min(Math.floor(target.xp * (1 - XP_LOSS_PERCENT) + 50), MAX_XP_DROP);
             dealer.xp += xpDrop;
             dealer.killCount = (dealer.killCount || 0) + 1;
             // console.log(`   > ${dealer.name} gains ${xpDrop} XP (Total: ${dealer.xp}). Kills: ${dealer.killCount}`); // DEBUG
             checkLevelUp(dealer);
        }

        // Schedule respawn
        setTimeout(() => respawnPlayer(target.id), RESPAWN_TIME);
    }
}

function respawnPlayer(playerId) {
    const player = players.get(playerId);
    if (!player || !player.isDead) { // Player disconnected or already respawned
        // console.log(`Respawn cancelled for ID ${playerId}: not found or not dead.`); // DEBUG
        return;
    }

    console.log(`Respawning ${player.name}...`);
    const raceData = getRaceBaseStats(player.race);
    player.x = Math.random() * (MAP_WIDTH - 200) + 100;
    player.y = Math.random() * (MAP_HEIGHT - 200) + 100;
    player.isDead = false;
    player.xp = Math.floor(player.xp * XP_LOSS_PERCENT); // Lose XP
    player.level = 1;
    player.classOrMutation = null;
    player.canChooseLevel2 = false;
    player.stats = { ...raceData.stats }; // Reset stats
    player.maxHp = raceData.hp;
    player.hp = player.maxHp; // Full HP
    player.speed = raceData.speed;
    player.color = raceData.color;
    player.killCount = 0;
    player.attackCooldown = 0; // Reset cooldown
    // lastProcessedInputSeq should be updated in the game loop after processing the first non-dead input
    console.log(`${player.name} respawned at ${player.x.toFixed(0)},${player.y.toFixed(0)} with ${player.xp} XP.`);
}


// --- Leveling ---
function checkLevelUp(player) {
    if (player.level === 1 && player.xp >= XP_TO_LEVEL_2 && !player.canChooseLevel2) {
        player.level = 2;
        player.canChooseLevel2 = true;
        safeSend(player.ws, JSON.stringify({ type: 'levelUpReady' }));
        console.log(`${player.name} reached Level 2! Choice enabled.`);
    }
}

// --- Utility Functions ---
function distanceSq(x1, y1, x2, y2) { const dx = x1 - x2; const dy = y1 - y2; return dx*dx + dy*dy; }
function normalizeAngle(angle) { while (angle <= -Math.PI) angle += 2 * Math.PI; while (angle > Math.PI) angle -= 2 * Math.PI; return angle; }
function lightenDarkenColor(col, amt) { let usePound = false; if (col[0] == "#") { col = col.slice(1); usePound = true; } let num = parseInt(col, 16); let r = (num >> 16) + amt; if (r > 255) r = 255; else if (r < 0) r = 0; let b = ((num >> 8) & 0x00FF) + amt; if (b > 255) b = 255; else if (b < 0) b = 0; let g = (num & 0x0000FF) + amt; if (g > 255) g = 255; else if (g < 0) g = 0; return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0'); }
function safeSend(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(data); } }

// --- Game Loop ---
function gameLoop() {
    const currentTime = Date.now();
    const deltaTime = (currentTime - lastUpdateTime) / 1000.0;
    lastUpdateTime = currentTime;
    const cappedDeltaTime = Math.min(deltaTime, 0.05); // Cap at 50ms
    const speedMultiplier = (1000 / GAME_LOOP_RATE) * cappedDeltaTime; // Multiplier based on fixed tick rate and delta time

    // --- Update Players ---
    players.forEach(player => {
        if (player.isDead) {
             // Update lastProcessedInputSeq even if dead, using the input received while dead
             player.lastProcessedInputSeq = player.lastInput.seq;
             return; // Skip movement/attack processing if dead
        }

        // 1. Apply Movement
        let moveX = 0;
        let moveY = 0;
        // Use the last received *valid* input
        if (player.lastInput.up) moveY -= 1;
        if (player.lastInput.down) moveY += 1;
        if (player.lastInput.left) moveX -= 1;
        if (player.lastInput.right) moveX += 1;

        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
        if (magnitude > 0) {
            const actualSpeed = player.speed; // Use player's current speed stat
            const moveAmount = actualSpeed * speedMultiplier;
            player.x += (moveX / magnitude) * moveAmount;
            player.y += (moveY / magnitude) * moveAmount;
            // Clamp to map boundaries
            player.x = Math.max(player.radius, Math.min(MAP_WIDTH - player.radius, player.x));
            player.y = Math.max(MAP_HEIGHT - player.radius, Math.min(MAP_HEIGHT - player.radius, player.y)); // Fix: clamp between radius and MAP_HEIGHT - radius
             player.y = Math.max(player.radius, Math.min(MAP_HEIGHT - player.radius, player.y)); // Corrected Clamp


            // DEBUG: Log movement for a specific player ID
             // if (player.id === 'YOUR_DEBUG_PLAYER_ID') {
             //     console.log(`[Server] ${player.name} Input: ${JSON.stringify(player.lastInput)} Mag: ${magnitude.toFixed(2)}, Speed: ${actualSpeed.toFixed(2)}, Multiplier: ${speedMultiplier.toFixed(2)}, Moved: ${moveAmount.toFixed(2)}. Pos: ${player.x.toFixed(1)}, ${player.y.toFixed(1)}`);
             // }

        } else {
             // DEBUG: Log no movement
             // if (player.id === 'YOUR_DEBUG_PLAYER_ID') {
             //      console.log(`[Server] ${player.name} Input: ${JSON.stringify(player.lastInput)} Magnitude 0. No movement.`);
             // }
        }


        // 2. Process Attack Input
        if (player.lastInput.attack) {
            if (player.level < 2 || !player.classOrMutation) {
                // Level 1 basic melee stats (redundant assignment, just use values directly?)
                 const lvl1Range = MELEE_BASE_RANGE * 0.7;
                 const lvl1Damage = 5;
                 const lvl1Angle = Math.PI / 5;
                 // Temporarily override stats for the attack call if needed, or pass parameters
                 const tempStats = { ...player.stats, range: lvl1Range, damage: lvl1Damage, meleeAngle: lvl1Angle, attackSpeedModifier: 1 };
                 if (currentTime >= player.attackCooldown) { // Check cooldown here explicitly
                     performMeleeAttack({ ...player, stats: tempStats }, currentTime); // Pass player with temp stats
                 }
            } else { // Specialized classes
                 if (player.stats.range > MELEE_BASE_RANGE * 1.2) { // Ranged check
                     if (currentTime >= player.attackCooldown) { // Check cooldown
                         createProjectile(player, currentTime);
                     }
                 } else { // Melee attack
                      if (currentTime >= player.attackCooldown) { // Check cooldown
                         performMeleeAttack(player, currentTime);
                     }
                 }
            }
             // The attack flag in lastInput stays true until the client sends input=false.
             // The server's cooldown mechanism limits the *rate* of attacks.
        }

        // 3. Update last processed input sequence
        player.lastProcessedInputSeq = player.lastInput.seq;
    });

    // --- Update Projectiles ---
    const projectilesToRemove = [];
    projectiles.forEach(proj => {
        const moveAmount = Math.sqrt(proj.dx*proj.dx + proj.dy*proj.dy) * speedMultiplier; // Distance per tick
        proj.x += proj.dx * speedMultiplier;
        proj.y += proj.dy * speedMultiplier;
        proj.rangeLeft -= moveAmount;

        if (proj.rangeLeft <= 0 || proj.x < -100 || proj.x > MAP_WIDTH + 100 || proj.y < -100 || proj.y > MAP_HEIGHT + 100) { // Check slightly outside bounds
            projectilesToRemove.push(proj.id);
            return;
        }

        for (const target of players.values()) {
            if (target.id === proj.ownerId || target.isDead) continue;

            const hitDistSq = (target.radius + proj.radius) * (target.radius + proj.radius);
            if (distanceSq(proj.x, proj.y, target.x, target.y) < hitDistSq) {
                // console.log(`Projectile ${proj.id} HIT ${target.name}`); // DEBUG
                const owner = players.get(proj.ownerId); // Get owner ref for lifesteal
                dealDamage(target, proj.damage, owner);
                projectilesToRemove.push(proj.id);
                return; // Projectile hits one target
            }
        }
    });
    new Set(projectilesToRemove).forEach(id => projectiles.delete(id));

    // --- Update Orbs ---
    const orbsToRemove = new Set(); // Use a Set directly for removal IDs
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return;

        const collectRadiusSq = (player.radius + ORB_RADIUS) * (player.radius + ORB_RADIUS);
        // Simple collision check for all orbs - could be optimized
        orbs.forEach(orb => {
            if (distanceSq(player.x, player.y, orb.x, orb.y) < collectRadiusSq) {
                player.xp += orb.value;
                orbsToRemove.add(orb.id);
                // console.log(`${player.name} collected orb, XP: ${player.xp}`); // DEBUG
                checkLevelUp(player);
            }
        });
    });
    orbsToRemove.forEach(id => orbs.delete(id));


    // --- Spawn new orbs ---
    if (orbs.size < ORB_COUNT && Math.random() < 0.15) {
        spawnOrb();
    }

    // --- Prepare & Broadcast State ---
    const playersData = [];
    players.forEach(p => playersData.push(getPlayerDataForClient(p)));
    const orbsData = Array.from(orbs.values());
    const projectilesData = Array.from(projectiles.values());

    const gameState = {
        type: 'gameState',
        timestamp: currentTime,
        players: playersData,
        orbs: orbsData,
        projectiles: projectilesData
    };
    const gameStateString = JSON.stringify(gameState);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(gameStateString);
        }
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
        lastProcessedInputSeq: player.lastProcessedInputSeq,
        speed: player.speed, // Include speed for client prediction accuracy
        killCount: player.killCount
    };
}


// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const tempId = uuidv4().substring(0, 8);
    console.log(`Client connecting... (Temp ID: ${tempId})`);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let playerId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

             if (!playerId && data.type !== 'join') {
                 console.warn(`(${tempId}) Non-join message before joining. Type: ${data.type}. Ignoring.`);
                 return;
             }

            const player = players.get(playerId);

            switch (data.type) {
                case 'join':
                    if (playerId) {
                        console.warn(`(${player?.name || tempId}) Attempted to join again. Ignoring.`);
                        return;
                    }
                     playerId = uuidv4();
                     ws.playerId = playerId;

                     const name = data.name ? data.name.substring(0, 16).trim() : 'Anon';
                     let race = data.race || 'human';
                     if (!['human', 'elf', 'gnome', 'vampire', 'goblin'].includes(race)) {
                         console.warn(`(${tempId}) Invalid race "${race}". Defaulting to human.`);
                         race = 'human';
                     }

                     const newPlayer = createPlayer(playerId, ws, name, race);
                     players.set(playerId, newPlayer);
                     console.log(`Player ${newPlayer.name} (${newPlayer.race}) joined with ID ${playerId}`);

                    safeSend(ws, JSON.stringify({
                        type: 'welcome',
                        playerId: playerId,
                        mapWidth: MAP_WIDTH,
                        mapHeight: MAP_HEIGHT,
                        initialState: {
                            players: Array.from(players.values()).map(getPlayerDataForClient),
                            orbs: Array.from(orbs.values()),
                            projectiles: Array.from(projectiles.values())
                        },
                         constants: {
                              PLAYER_BASE_SPEED: PLAYER_BASE_SPEED, // Send base speed
                              BASE_TICK_RATE: 1000 / GAME_LOOP_RATE // Send ticks per second
                         }
                    }));
                    break;

                case 'input':
                    if (!player || typeof data.input?.seq !== 'number') {
                         // console.warn(`(${playerId || tempId}) Invalid input received (player: ${!!player}, seq: ${data.input?.seq}). Ignoring.`); // DEBUG
                         return;
                    }
                    // Update player's last input state
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
                     if (!player) return;
                     const validChoices = {
                         human: ['warrior', 'mage'], elf: ['warrior', 'mage'], gnome: ['warrior', 'mage'],
                         vampire: ['lord', 'higher'], goblin: ['king', 'hobgoblin']
                     };
                     if (player.level === 2 && player.canChooseLevel2 && validChoices[player.race]?.includes(data.choice)) {
                         console.log(`Player ${player.name} selected class/mutation: ${data.choice}`);
                         applyLevel2Specialization(player, data.choice);
                     } else {
                         console.warn(`(${player?.name || playerId}) Invalid class selection attempt: choice=${data.choice}, level=${player?.level}, canChoose=${player?.canChooseLevel2}, race=${player?.race}`);
                     }
                     break;

                case 'ping':
                    safeSend(ws, JSON.stringify({ type: 'pong', clientTime: data.time }));
                    break;
            }
        } catch (error) {
            console.error(`Failed to process message for player ${playerId || tempId}:`, message, error);
        }
    });

    ws.on('close', () => {
        const closedPlayerId = ws.playerId;
        if (closedPlayerId && players.has(closedPlayerId)) {
            const player = players.get(closedPlayerId);
            console.log(`Player ${player.name} (${closedPlayerId}) disconnected.`);
            players.delete(closedPlayerId);
        } else {
            console.log(`Client (${tempId}) disconnected before joining.`);
        }
    });

    ws.onerror = (error) => {
        console.error(`WebSocket error for ${ws.playerId || tempId}: `, error);
        if (ws.playerId && players.has(ws.playerId)) {
             console.log(`Removing player ${players.get(ws.playerId).name} (${ws.playerId}) due to error.`);
             players.delete(ws.playerId);
        }
    };
});

// --- Heartbeat/Ping ---
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
             console.log(`Client ${ws.playerId || '(unidentified)'} failed heartbeat. Terminating.`);
             // Check if a player was associated before terminating
             if(ws.playerId && players.has(ws.playerId)) {
                 console.log(`Removing player ${players.get(ws.playerId).name} (${ws.playerId}) due to failed heartbeat.`);
                 players.delete(ws.playerId);
             }
             ws.terminate();
             return;
        }
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, 30000);

wss.on('close', () => { clearInterval(heartbeatInterval); });


// --- Static File Serving & Server Start ---
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Game
console.log("Initializing game state...");
for (let i = 0; i < ORB_COUNT * 0.8; i++) { spawnOrb(); }
console.log(`Spawned ${orbs.size} initial orbs.`);

lastUpdateTime = Date.now();
setInterval(gameLoop, GAME_LOOP_RATE);
console.log(`Game loop started at ${GAME_LOOP_RATE.toFixed(2)}ms interval (~${(1000/GAME_LOOP_RATE).toFixed(1)} FPS)`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- RuneRealms.io Server listening on port ${PORT} ---`);
});

// --- Utility Functions (kept here for single file) ---
function distanceSq(x1, y1, x2, y2) { const dx = x1 - x2; const dy = y1 - y2; return dx*dx + dy*dy; }
function normalizeAngle(angle) { while (angle <= -Math.PI) angle += 2 * Math.PI; while (angle > Math.PI) angle -= 2 * Math.PI; return angle; }
function lightenDarkenColor(col, amt) { let usePound = false; if (col[0] == "#") { col = col.slice(1); usePound = true; } let num = parseInt(col, 16); let r = (num >> 16) + amt; if (r > 255) r = 255; else if (r < 0) r = 0; let b = ((num >> 8) & 0x00FF) + amt; if (b > 255) b = 255; else if (b < 0) b = 0; let g = (num & 0x0000FF) + amt; if (g > 255) g = 255; else if (g < 0) g = 0; return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0'); }
function safeSend(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(data); } }
