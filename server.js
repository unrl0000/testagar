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
const BASE_PLAYER_SPEED = 2.5; // Base speed before race/class modifiers
const ORB_RADIUS = 5;
const ORB_COUNT = 150;
const XP_PER_ORB = 10;
const XP_TO_LEVEL_2 = 100; // Experience needed for level 2
const BASE_PLAYER_MAX_HP = 100;
const PROJECTILE_RADIUS = 5;
const BASE_PROJECTILE_SPEED = 7;
const BASE_PROJECTILE_DAMAGE = 10;
const BASE_ATTACK_COOLDOWN = 500; // milliseconds
const MELEE_RANGE = PLAYER_RADIUS * 2.5;
const BASE_LIFESTEAL_PERCENT = 0.02; // 2% base for Vampire
const LIFESTEAL_LORD_BONUS = 0.08; // Additional 8% for Lord Vampire (total 10%)
const GAME_TICK_RATE = 33; // Server game loop ticks per second (approx 30ms)

// --- Game State ---
let players = new Map(); // Map<playerId, playerData>
let orbs = new Map(); // Map<orbId, orbData>
let projectiles = new Map(); // Map<projectileId, projectileData>

let lastUpdateTime = Date.now();

// --- Player Data Structure ---
function createPlayer(id, ws, name, race) {
    const raceData = getRaceBaseStats(race);
    return {
        id: id,
        ws: ws, // Keep a reference to the WebSocket connection
        name: name,
        x: Math.random() * (MAP_WIDTH - 100) + 50,
        y: Math.random() * (MAP_HEIGHT - 100) + 50,
        vx: 0, // Velocity x
        vy: 0, // Velocity y
        hp: raceData.maxHp, // Start with full HP
        maxHp: raceData.maxHp,
        level: 1,
        xp: 0,
        race: race,
        classOrMutation: null,
        color: raceData.color,
        radius: PLAYER_RADIUS,
        speed: raceData.speed,
        attackCooldown: 0, // Time until next attack is allowed
        lastAttackTime: 0, // Timestamp of last attack
        lastInput: { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 }, // Store input state
        isDead: false,
        killCount: 0,
        canChooseLevel2: false,
        stats: { // Combine base and race stats
             damage: raceData.stats.damage,
             range: raceData.stats.range, // 0 for melee/base, >0 for ranged
             lifesteal: raceData.stats.lifesteal,
             projectileSpeed: raceData.stats.projectileSpeed,
             attackSpeedModifier: raceData.stats.attackSpeedModifier // Multiplier for cooldown
        }
    };
}

function getRaceBaseStats(race) {
    const baseStats = { damage: BASE_PROJECTILE_DAMAGE, range: 0, lifesteal: 0, projectileSpeed: BASE_PROJECTILE_SPEED, attackSpeedModifier: 1 };
    let hp = BASE_PLAYER_MAX_HP;
    let speed = BASE_PLAYER_SPEED;
    let color = '#ffffff';

    switch (race) {
        case 'human': color = '#4287f5'; break; // Blue
        case 'elf': color = '#34eb4f'; speed *= 1.1; break; // Green, faster
        case 'gnome': color = '#a67b5b'; hp *= 1.1; break; // Brown, tankier
        case 'vampire': color = '#d92525'; baseStats.lifesteal = BASE_LIFESTEAL_PERCENT; break; // Dark Red, slight lifesteal
        case 'goblin': color = '#6a706b'; speed *= 1.05; hp *= 0.9; break; // Gray, slightly faster, less hp
    }

    return { maxHp: hp, speed: speed, color: color, stats: baseStats };
}

function applyLevel2Specialization(player, choice) {
    // Prevent applying if already done or not ready
    if (player.level !== 2 || !player.canChooseLevel2 || player.classOrMutation !== null) {
         console.warn(`Attempted to apply level 2 choice for player ${player.name} but conditions not met.`);
         return;
    }

    player.classOrMutation = choice;
    player.canChooseLevel2 = false; // Choice made

    // Get base stats for reference
    const baseRaceStats = getRaceBaseStats(player.race);
    // Reset stats to potentially modify them from base
    player.stats = { ...baseRaceStats.stats };
    player.speed = baseRaceStats.speed;
    // Keep current HP percentage relative to the *new* max HP
    const hpPercent = player.hp / player.maxHp;


    switch (choice) {
        // --- Human/Elf/Gnome Classes ---
        case 'warrior':
            player.maxHp = baseRaceStats.maxHp * 1.3;
            player.stats.damage = baseRaceStats.stats.damage * 1.5; // Higher melee damage
            player.stats.range = MELEE_RANGE; // Melee attack type
            player.color = lightenDarkenColor(baseRaceStats.color, -20); // Darker shade
            break;
        case 'mage':
            player.maxHp = baseRaceStats.maxHp * 0.9;
            player.stats.damage = baseRaceStats.stats.damage * 1.0; // Standard projectile damage
            player.stats.range = 600; // Ranged attack type (longer range)
            player.stats.projectileSpeed = BASE_PROJECTILE_SPEED * 1.2; // Faster projectiles
            player.stats.attackSpeedModifier = 0.8; // Slightly faster attacks
            player.color = lightenDarkenColor(baseRaceStats.color, 20); // Lighter shade
            break;

        // --- Vampire Mutations ---
        case 'lord': // Lifesteal focus
            player.maxHp = baseRaceStats.maxHp * 1.1;
            player.stats.damage = baseRaceStats.stats.damage * 1.2;
            player.stats.lifesteal = BASE_LIFESTEAL_PERCENT + LIFESTEAL_LORD_BONUS; // High Lifesteal
            player.stats.range = MELEE_RANGE; // Melee
            player.color = '#a11b1b'; // Deeper red
            break;
        case 'higher': // Speed/Attack speed focus
            player.maxHp = baseRaceStats.maxHp; // Same base HP
            player.speed = baseRaceStats.speed * 1.2; // Faster movement
            player.stats.damage = baseRaceStats.stats.damage * 1.1; // Slightly more damage
            player.stats.attackSpeedModifier = 0.6; // Much faster attacks
            player.stats.lifesteal = BASE_LIFESTEAL_PERCENT * 0.5; // Reduced lifesteal
            player.stats.range = MELEE_RANGE * 1.2; // Slightly longer melee reach
            player.color = '#f75454'; // Brighter red
            break;

        // --- Goblin Mutations ---
        case 'king': // Tankier / Minor support (conceptual)
            player.maxHp = baseRaceStats.maxHp * 1.4; // Very tanky
            player.stats.damage = baseRaceStats.stats.damage * 1.1; // Okay damage
            player.stats.range = MELEE_RANGE; // Melee
            player.color = '#494d4a'; // Darker gray/green
            // Could add logic for minions here later
            break;
        case 'hobgoblin': // Brute force
            player.maxHp = baseRaceStats.maxHp * 1.2; // Tanky
            player.speed = baseRaceStats.speed * 0.85; // Slower
            player.stats.damage = baseRaceStats.stats.damage * 2.0; // Very high melee damage
            player.stats.range = MELEE_RANGE * 1.3; // Longer melee reach
            player.color = '#819185'; // More greenish/brownish gray
            break;
         default: // Should not happen
             console.error(`Unknown class choice: ${choice} for player ${player.id}`);
             // Reset flag so they can choose again?
             player.canChooseLevel2 = true;
             player.classOrMutation = null; // Reset if invalid choice
             return; // Don't apply changes
    }

    // Apply HP percentage to new maxHp
    player.hp = player.maxHp * hpPercent;
    if (player.hp <= 0) player.hp = 1; // Prevent spawning dead if HP was very low
    if (player.hp > player.maxHp) player.hp = player.maxHp; // Cap HP

    // Notify client about the update (full player state includes new stats/color)
    safeSend(player.ws, JSON.stringify({ type: 'classSelected', player: getPlayerDataForClient(player) }));
    console.log(`${player.name} chose: ${player.classOrMutation}. New HP: ${player.hp}/${player.maxHp}`);
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
            color: '#f0e370' // Yellowish
        });
    }
}

// --- Projectile Logic ---
function createProjectile(owner, targetX, targetY) {
    // Check cooldown, if class allows ranged (range > melee threshold) and if input provided
    if (owner.attackCooldown > 0 || !owner.stats.range || owner.stats.range <= MELEE_RANGE * 1.5 || !owner.lastInput) {
        return; // Only ranged classes shoot projectiles & must be off cooldown
    }

    const projId = uuidv4();
    const angle = Math.atan2(targetY - owner.y, targetX - owner.x); // Use actual target coordinates
    const speed = owner.stats.projectileSpeed || BASE_PROJECTILE_SPEED;

    projectiles.set(projId, {
        id: projId,
        ownerId: owner.id,
        x: owner.x + Math.cos(angle) * (owner.radius + PROJECTILE_RADIUS + 2), // Start slightly outside player radius
        y: owner.y + Math.sin(angle) * (owner.radius + PROJECTILE_RADIUS + 2),
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        radius: PROJECTILE_RADIUS,
        damage: owner.stats.damage || BASE_PROJECTILE_DAMAGE,
        color: lightenDarkenColor(owner.color, 30), // Slightly lighter than owner
        rangeLeft: owner.stats.range, // Distance projectile can travel
        firedAt: Date.now() // For potential aging/removal
    });

    owner.attackCooldown = BASE_ATTACK_COOLDOWN / (owner.stats.attackSpeedModifier || 1);
    owner.lastAttackTime = Date.now();
     // console.log(`Player ${owner.name} fired projectile. Cooldown: ${owner.attackCooldown}`);
}

// --- Melee Attack Logic ---
function performMeleeAttack(attacker, targetX, targetY) {
     // Check cooldown, if class allows melee (range up to melee threshold) and if input provided
     if (attacker.attackCooldown > 0 || !attacker.stats.range || attacker.stats.range > MELEE_RANGE * 1.5 || !attacker.lastInput) {
         return; // Only melee classes & must be off cooldown
     }

    attacker.attackCooldown = BASE_ATTACK_COOLDOWN / (attacker.stats.attackSpeedModifier || 1);
    attacker.lastAttackTime = Date.now();
    // console.log(`Player ${attacker.name} performed melee. Cooldown: ${attacker.attackCooldown}`);

    // Determine attack direction based on input mouse coordinates
    const attackAngle = Math.atan2(targetY - attacker.y, targetX - attacker.x);
    const reach = attacker.stats.range || MELEE_RANGE; // Use player's actual reach stat

    // Check targets within the attack range and angle
     for (const [targetId, target] of players) {
         if (targetId === attacker.id || target.isDead) continue;

         const dist = distance(attacker.x, attacker.y, target.x, target.y);
         // Check if target is within reach distance + their radius
         if (dist < reach + target.radius) {
              // Check if target is within the attack cone/direction
              const targetAngle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
              const angleDiff = Math.abs(normalizeAngle(attackAngle - targetAngle));

              // Use a wider cone for melee, e.g., 90 degrees total (PI/2)
             if (angleDiff < Math.PI / 4) { // ~45 degrees total (PI/4) cone
                 // console.log(`Melee hit! Attacker: ${attacker.name}, Target: ${target.name}`);
                 dealDamage(target, attacker.stats.damage, attacker);
                 break; // Melee hit one target (the first one found in cone)
             }
         }
     }
     // Optional: Broadcast melee attack event for client-side visual effect
     // wss.clients.forEach(client => {
     //      safeSend(client, JSON.stringify({ type: 'meleeVisual', playerId: attacker.id, x: attacker.x, y: attacker.y, angle: attackAngle, range: reach }));
     // });
}


// --- Damage & Death ---
function dealDamage(target, damage, dealer) {
    if (target.isDead) return;

    const actualDamage = damage; // Could add defense calculation here
    target.hp -= actualDamage;

    // Lifesteal
    if (dealer && players.has(dealer.id) && dealer.stats && dealer.stats.lifesteal > 0) { // Check if dealer still exists
        const healAmount = actualDamage * dealer.stats.lifesteal;
        dealer.hp = Math.min(dealer.maxHp, dealer.hp + healAmount);
         // HP change will be broadcast in the next game state update
    }

    // console.log(`${target.name} HP: ${target.hp}/${target.maxHp}`);

    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        target.vx = 0;
        target.vy = 0;
        console.log(`${target.name} killed by ${dealer ? dealer.name : 'Unknown'}`);

        if (dealer && players.has(dealer.id)) { // Check if dealer still exists
             dealer.killCount++;
             // Award XP for kill - maybe based on victim's level/XP?
             const xpDrop = Math.min(target.xp / 5 + 20, 200); // Drop some XP on death, less than orbs usually
             dealer.xp += xpDrop;
             checkLevelUp(dealer);
             console.log(`${dealer.name} gained ${xpDrop} XP from kill.`);
        }

        // Respawn logic
        setTimeout(() => {
            if (players.has(target.id)) { // Check if player hasn't disconnected
                 const baseRaceStats = getRaceBaseStats(target.race);
                 target.x = Math.random() * (MAP_WIDTH - 100) + 50;
                 target.y = Math.random() * (MAP_HEIGHT - 100) + 50;

                 // Reset stats/level on death, lose significant XP
                 target.xp = Math.floor(target.xp * 0.3); // Lose 70% XP
                 target.level = 1; // Always respawn at level 1
                 target.classOrMutation = null; // Lose class/mutation

                 target.stats = { ...baseRaceStats.stats };
                 target.speed = baseRaceStats.speed;
                 target.maxHp = baseRaceStats.maxHp;
                 target.hp = target.maxHp; // Respawn with full base HP
                 target.color = baseRaceStats.color; // Revert to base race color


                 target.isDead = false;
                 // Keep kill count? Or reset? Let's reset kill count on death for simplicity
                 target.killCount = 0;

                 console.log(`${target.name} respawned at Level ${target.level} with ${target.xp} XP.`);
                 // Need to re-send player state to client specifically for respawn changes
                 safeSend(target.ws, JSON.stringify({ type: 'respawn', player: getPlayerDataForClient(target) }));
            }
        }, 5000); // 5 second respawn timer
    }
}

// --- Leveling ---
function checkLevelUp(player) {
    if (player.level === 1 && player.xp >= XP_TO_LEVEL_2) {
        player.level = 2;
        player.canChooseLevel2 = true; // Set flag
        // Notify the client they can level up - MUST BE SENT AS SEPARATE MESSAGE
        safeSend(player.ws, JSON.stringify({ type: 'levelUpReady' }));
        console.log(`${player.name} reached Level 2! Awaiting class selection.`);
    }
    // Add logic for higher levels later if needed
}

// --- Utility Functions ---
function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
}

function normalizeAngle(angle) {
     while (angle <= -Math.PI) angle += 2 * Math.PI;
     while (angle > Math.PI) angle -= 2 * Math.PI;
     return angle;
 }

function lightenDarkenColor(col, amt) {
    // Basic color lighten/darken, needed for class colors
    let usePound = false;
    if (col[0] === "#") {
        col = col.slice(1);
        usePound = true;
    }
    const num = parseInt(col, 16);
    const r = Math.max(0, Math.min(255, (num >> 16) + amt));
    const b = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amt));
    const g = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
    return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0');
}

// Safe send function to avoid errors if ws is closed
function safeSend(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(data);
        } catch (e) {
            console.error("Error sending message:", e);
        }
    }
}

// --- Game Loop ---
function gameLoop() {
    const now = Date.now();
    const deltaTime = (now - lastUpdateTime) / 1000.0; // Time since last update in seconds
    lastUpdateTime = now;

    // 1. Process Inputs & Update Velocities
    players.forEach(player => {
        if (player.isDead) {
             player.vx = 0;
             player.vy = 0;
             return; // Cannot move or attack while dead
        }

        let moveX = 0;
        let moveY = 0;
        // Use the latest received input state
        if (player.lastInput.up) moveY -= 1;
        if (player.lastInput.down) moveY += 1;
        if (player.lastInput.left) moveX -= 1;
        if (player.lastInput.right) moveX += 1;

        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
        if (magnitude > 0) {
            player.vx = (moveX / magnitude) * player.speed;
            player.vy = (moveY / magnitude) * player.speed;
        } else {
            player.vx = 0;
            player.vy = 0;
        }

        // Update Attack Cooldown
        // Ensure cooldown decreases even if input isn't being sent consistently
        if (player.attackCooldown > 0) {
             const timeSinceLastAttack = now - player.lastAttackTime;
             const theoreticalCooldownEnd = player.lastAttackTime + (BASE_ATTACK_COOLDOWN / (player.stats.attackSpeedModifier || 1));
             // Calculate how much cooldown is left based on time elapsed since last attack
             player.attackCooldown = Math.max(0, theoreticalCooldownEnd - now);
        }


        // Handle Attack Input (Only if input.attack is true AND off cooldown AND not choosing class)
        if (player.lastInput.attack && player.attackCooldown <= 0 && !player.canChooseLevel2) {
             const targetX = player.lastInput.mouseX;
             const targetY = player.lastInput.mouseY;

             if (player.level < 2) {
                  // Level 1 base attack (simple melee)
                  const baseStats = getRaceBaseStats(player.race).stats; // Get base stats for level 1
                  const tempPlayerForAttack = { // Use a temp object to not modify player stats permanently
                      id: player.id,
                      x: player.x, y: player.y, radius: player.radius,
                      stats: { damage: baseStats.damage, range: MELEE_RANGE * 0.8, lifesteal: baseStats.lifesteal, attackSpeedModifier: 1 },
                      lastInput: player.lastInput,
                      attackCooldown: 0, lastAttackTime: 0 // Simulate off cooldown for this check
                  };
                  performMeleeAttack(tempPlayerForAttack, targetX, targetY);
                   // Apply cooldown back to actual player
                  player.attackCooldown = BASE_ATTACK_COOLDOWN / tempPlayerForAttack.stats.attackSpeedModifier;
                  player.lastAttackTime = now;


             } else if (player.stats.range > MELEE_RANGE * 1.5) { // Ranged attack (Mage)
                 createProjectile(player, targetX, targetY);
             } else { // Melee attack (Warrior, Lord, Higher, King, Hobgoblin)
                 performMeleeAttack(player, targetX, targetY);
             }

             // player.lastInput.attack = false; // Server consumes the 'attack' command for this tick
        }
         // We don't reset player.lastInput.attack = false here,
         // the client controls the input state based on button/mouse press.
         // The server simply checks the state at the start of the tick.
         // If the client holds the button, attack will be true for multiple ticks
         // but cooldown logic prevents spam.
    });

    // 2. Update Positions & Check Boundaries
    players.forEach(player => {
        if (player.isDead) return;
        player.x += player.vx * deltaTime * 60; // Scale velocity by deltaTime (based on 60 FPS expectation, safer is speed * deltaTime)
        player.y += player.vy * deltaTime * 60; // Fixed: Use speed * deltaTime. Let's fix to speed * deltaTime

        player.x += player.vx * deltaTime; // Correct: Use speed * deltaTime
        player.y += player.vy * deltaTime;

        // Boundary checks
        player.x = Math.max(player.radius, Math.min(MAP_WIDTH - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(MAP_HEIGHT - player.radius, player.y));
    });

     // 3. Update Projectiles & Check Collisions
    const projectilesToRemove = new Set();
    projectiles.forEach(proj => {
        const moveDistance = Math.sqrt(proj.dx*proj.dx + proj.dy*proj.dy) * deltaTime;
        proj.x += proj.dx * deltaTime;
        proj.y += proj.dy * deltaTime;
        proj.rangeLeft -= moveDistance;

        // Check projectile out of range or bounds
        if (proj.rangeLeft <= 0 || proj.x < -PROJECTILE_RADIUS*2 || proj.x > MAP_WIDTH+PROJECTILE_RADIUS*2 || proj.y < -PROJECTILE_RADIUS*2 || proj.y > MAP_HEIGHT+PROJECTILE_RADIUS*2) {
            projectilesToRemove.add(proj.id);
            return;
        }

        // Check projectile collision with players
        for (const [targetId, target] of players) {
            if (targetId === proj.ownerId || target.isDead) continue; // Don't hit self or dead players

            const dist = distance(proj.x, proj.y, target.x, target.y);
            if (dist < target.radius + proj.radius) {
                const owner = players.get(proj.ownerId); // Get owner to apply lifesteal
                dealDamage(target, proj.damage, owner);
                projectilesToRemove.add(proj.id); // Remove projectile on hit
                 break; // Projectile hits one target
            }
        }
    });
    projectilesToRemove.forEach(id => projectiles.delete(id));


    // 4. Check Player-Orb Collisions
    const orbsToRemove = new Set();
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return; // Don't collect orbs while choosing class or dead

        orbs.forEach(orb => {
            const dist = distance(player.x, player.y, orb.x, orb.y);
            // Simple attraction: orbs move towards nearby players
            if (dist < player.radius * 5) { // Orb attraction radius
                 const angle = Math.atan2(player.y - orb.y, player.x - orb.x);
                 const attractSpeed = 50 * deltaTime; // Attraction speed
                 orb.x += Math.cos(angle) * attractSpeed;
                 orb.y += Math.sin(angle) * attractSpeed;
            }

            // Collision check
            if (dist < player.radius + orb.radius) {
                player.xp += orb.value;
                orbsToRemove.add(orb.id);
                checkLevelUp(player); // Check if player leveled up
            }
        });
    });
    orbsToRemove.forEach(id => orbs.delete(id));

    // 5. Spawn new orbs
     // Check if current number is less than max before spawning
    if (orbs.size < ORB_COUNT && Math.random() < 0.2) { // Higher chance per tick if less than max
        spawnOrb();
    }


    // 6. Prepare & Send State Update to Clients
    const playersData = [];
    players.forEach(p => {
        // Send all players (dead or alive) but mark them as isDead
        // Client needs to know about dead players for respawn visual/timer if implemented
         playersData.push(getPlayerDataForClient(p));
    });
    const orbsData = Array.from(orbs.values());
    const projectilesData = Array.from(projectiles.values());

    const gameState = {
        type: 'gameState',
        players: playersData,
        orbs: orbsData,
        projectiles: projectilesData,
        serverTime: Date.now() // Include server time for client synchronization
    };
    const gameStateString = JSON.stringify(gameState);

    wss.clients.forEach(client => {
        // Optimization: Only send state to clients who are ready and connected
        if (client.readyState === WebSocket.OPEN && client.isReady) { // Added isReady flag
            safeSend(client, gameStateString);
        }
    });
}

// Function to get player data suitable for sending to clients (omit ws object and input state)
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
        canChooseLevel2: player.canChooseLevel2, // Send this flag to client
        stats: { // Send relevant stats for client-side predictions/visuals if needed
            damage: player.stats.damage,
            range: player.stats.range,
            lifesteal: player.stats.lifesteal,
            projectileSpeed: player.stats.projectileSpeed,
            attackSpeedModifier: player.stats.attackSpeedModifier
        },
        attackCooldown: player.attackCooldown, // Send cooldown state
        lastAttackTime: player.lastAttackTime // Send last attack time for client prediction
    };
}


// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Client connected: ${playerId}`);
    let currentPlayer = null; // Will be set on 'join'

    // Mark client as not ready until join message is received
    ws.isReady = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    if (!players.has(playerId)) {
                         const name = data.name ? data.name.substring(0, 16) : 'Anon';
                         const race = data.race || 'human';
                         currentPlayer = createPlayer(playerId, ws, name, race);
                         players.set(playerId, currentPlayer);
                         ws.isReady = true; // Mark client as ready after joining

                         console.log(`Player ${currentPlayer.name} (${currentPlayer.race}) joined with ID ${playerId}`);

                        // Send initial state to the new player
                        safeSend(ws, JSON.stringify({ type: 'welcome', playerId: playerId, mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT, serverTime: Date.now() }));

                         // Broadcast new player joining (optional)
                         // wss.clients.forEach(client => {
                         //      if (client.readyState === WebSocket.OPEN && client.isReady && client !== ws) {
                         //           safeSend(client, JSON.stringify({ type: 'playerJoined', player: getPlayerDataForClient(currentPlayer) }));
                         //      }
                         // });
                    }
                    break;

                case 'input':
                    if (currentPlayer && !currentPlayer.isDead && ws.isReady) { // Only process input for living, ready players
                         // Validate input structure slightly
                         if (data.input && typeof data.input === 'object') {
                            currentPlayer.lastInput = {
                                up: !!data.input.up, // Ensure boolean
                                down: !!data.input.down,
                                left: !!data.input.left,
                                right: !!data.input.right,
                                attack: !!data.input.attack,
                                mouseX: data.input.mouseX !== undefined ? parseFloat(data.input.mouseX) : currentPlayer.x, // Sanitize/default
                                mouseY: data.input.mouseY !== undefined ? parseFloat(data.input.mouseY) : currentPlayer.y  // Sanitize/default
                            };
                         }
                    }
                    break;

                 case 'selectClass':
                     if (currentPlayer && currentPlayer.level === 2 && currentPlayer.canChooseLevel2 && data.choice && ws.isReady) {
                         applyLevel2Specialization(currentPlayer, data.choice);
                     }
                     break;

                // Add other message types as needed (chat, etc.)
            }
        } catch (error) {
            console.error('Failed to process message or invalid JSON:', message, error);
             // Potentially close connection for malformed messages
             // ws.terminate();
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Client disconnected: ${playerId} (Code: ${code}, Reason: ${reason.toString()})`);
        if (currentPlayer) {
            players.delete(playerId);
            console.log(`Player ${currentPlayer.name} removed.`);
        }
         // Maybe broadcast player disconnect to others?
    });

    ws.onerror = (error) => {
        console.error(`WebSocket error for ${playerId}: `, error);
         // Clean up player if connection breaks unexpectedly
        if (currentPlayer) {
            players.delete(playerId);
            console.log(`Player ${currentPlayer.name} removed due to error.`);
        }
    };
});

// --- Static File Serving ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Initialize Game ---
// Spawn initial orbs
for (let i = 0; i < ORB_COUNT * 0.8; i++) { // Start with 80% of orbs
    spawnOrb();
}
// Start the game loop
setInterval(gameLoop, 1000 / GAME_TICK_RATE);

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the game at http://localhost:${PORT}`);
});
