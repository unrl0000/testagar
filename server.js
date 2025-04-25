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
const PLAYER_SPEED = 2.5;
const ORB_RADIUS = 5;
const ORB_COUNT = 150;
const XP_PER_ORB = 10;
const XP_TO_LEVEL_2 = 100; // Experience needed for level 2
const PLAYER_MAX_HP = 100;
const PROJECTILE_RADIUS = 5;
const PROJECTILE_SPEED = 7;
const PROJECTILE_DAMAGE = 10;
const ATTACK_COOLDOWN = 500; // milliseconds
const MELEE_RANGE = PLAYER_RADIUS * 2.5;
const LIFESTEAL_PERCENT = 0.1; // 10% for Lord Vampires

// --- Game State ---
let players = new Map(); // Map<playerId, playerData>
let orbs = new Map(); // Map<orbId, orbData>
let projectiles = new Map(); // Map<projectileId, projectileData>

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
        hp: raceData.hp,
        maxHp: raceData.hp,
        level: 1,
        xp: 0,
        race: race,
        classOrMutation: null, // 'warrior', 'mage', 'lord', 'higher', 'king', 'hobgoblin'
        color: raceData.color,
        radius: PLAYER_RADIUS,
        speed: raceData.speed,
        attackCooldown: 0, // Time until next attack is allowed
        lastInput: null, // { up, down, left, right, attack, mouseX, mouseY }
        isDead: false,
        killCount: 0,
        canChooseLevel2: false, // Flag to show selection screen
        stats: { ...raceData.stats } // Specific stats like damage, range, lifesteal etc.
    };
}

function getRaceBaseStats(race) {
    const base = { hp: PLAYER_MAX_HP, speed: PLAYER_SPEED, color: '#ffffff', stats: { damage: 10, range: 0, lifesteal: 0, projectileSpeed: PROJECTILE_SPEED, attackSpeedModifier: 1 } };
    switch (race) {
        case 'human': base.color = '#4287f5'; break; // Blue
        case 'elf': base.color = '#34eb4f'; base.speed *= 1.1; break; // Green, faster
        case 'gnome': base.color = '#a67b5b'; base.hp *= 1.1; break; // Brown, tankier
        case 'vampire': base.color = '#d92525'; base.stats.lifesteal = 0.02; break; // Dark Red, slight lifesteal
        case 'goblin': base.color = '#6a706b'; base.speed *= 1.05; base.hp *= 0.9; break; // Gray, slightly faster, less hp
    }
    base.maxHp = base.hp; // Ensure maxHp is set correctly
    // Default range for level 1 or melee types
     base.stats.range = MELEE_RANGE; // Ensure a default range is set
     base.stats.damage = 10; // Ensure a default damage is set
    return base;
}

function applyLevel2Specialization(player, choice) {
    player.classOrMutation = choice;
    player.canChooseLevel2 = false; // Choice made

    // Reset/Apply specific stats based on choice
    const baseRaceStats = getRaceBaseStats(player.race);
    player.stats = { ...baseRaceStats.stats }; // Reset to base race stats first
    player.speed = baseRaceStats.speed;
    player.maxHp = baseRaceStats.hp;
    // Keep current HP percentage
    const hpPercent = player.hp / player.maxHp;


    switch (choice) {
        // --- Human/Elf/Gnome Classes ---
        case 'warrior':
            player.maxHp *= 1.3;
            player.stats.damage *= 1.5; // Higher melee damage
            player.stats.range = MELEE_RANGE * 1.2; // Melee attack type, slight reach
            player.color = lightenDarkenColor(player.color, -20); // Darker shade
            break;
        case 'mage':
            player.maxHp *= 0.9;
            player.stats.damage *= 12; // Standard projectile damage (increased slightly)
            player.stats.range = 400; // Ranged attack type
            player.stats.attackSpeedModifier = 0.8; // Slightly faster attacks
            player.color = lightenDarkenColor(player.color, 20); // Lighter shade
            break;

        // --- Vampire Mutations ---
        case 'lord': // Lifesteal focus
            player.stats.lifesteal = LIFESTEAL_PERCENT;
            player.maxHp *= 1.1;
            player.stats.damage *= 1.1;
            player.stats.range = MELEE_RANGE * 1.1; // Melee
            player.color = '#a11b1b'; // Deeper red
            break;
        case 'higher': // Speed/Attack speed focus
            player.speed *= 1.2;
            player.stats.attackSpeedModifier = 0.6; // Faster attacks
            player.stats.lifesteal = 0.05; // Keep some lifesteal
            player.stats.range = MELEE_RANGE * 1.05; // Keep melee or slight reach
            player.color = '#f75454'; // Brighter red
            break;

        // --- Goblin Mutations ---
        case 'king': // Tankier / Minor support (conceptual)
            player.maxHp *= 1.4;
            player.stats.damage *= 1.1;
            player.stats.range = MELEE_RANGE * 0.9; // Slightly shorter melee
            player.color = '#494d4a'; // Darker gray/green
            // Could add logic for minions here later
            break;
        case 'hobgoblin': // Brute force
            player.maxHp *= 1.2;
            player.speed *= 0.85; // Slower
            player.stats.damage *= 1.8; // High melee damage
            player.stats.range = MELEE_RANGE * 1.1; // Slightly longer melee reach
            player.color = '#819185'; // More greenish/brownish gray
            break;
    }
     // Re-apply HP percentage to new maxHp
     player.hp = player.maxHp * hpPercent;
     if (player.hp > player.maxHp) player.hp = player.maxHp; // Cap HP

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
            color: '#f0e370' // Yellowish
        });
    }
}

// --- Projectile Logic ---
function createProjectile(owner) {
    // Check range indicates a ranged attack type (e.g., Mage)
    if (!owner.lastInput || owner.attackCooldown > 0 || !owner.stats.range || owner.stats.range <= MELEE_RANGE * 1.5) {
        return; // Only ranged classes shoot projectiles (use a slightly larger threshold than MELEE_RANGE)
    }

    const projId = uuidv4();
    const angle = Math.atan2(owner.lastInput.mouseY - owner.y, owner.lastInput.mouseX - owner.x);
    const speed = owner.stats.projectileSpeed || PROJECTILE_SPEED;
    const range = owner.stats.range; // Use player's stats for range

    projectiles.set(projId, {
        id: projId,
        ownerId: owner.id,
        x: owner.x + Math.cos(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        y: owner.y + Math.sin(angle) * (owner.radius + PROJECTILE_RADIUS + 1),
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        radius: PROJECTILE_RADIUS,
        damage: owner.stats.damage || PROJECTILE_DAMAGE,
        color: lightenDarkenColor(owner.color, 30), // Slightly lighter than owner
        rangeLeft: range // Use player's range stat
    });

    owner.attackCooldown = ATTACK_COOLDOWN / (owner.stats.attackSpeedModifier || 1);
}

// --- Melee Attack Logic ---
function performMeleeAttack(attacker) {
    // Check range indicates a melee attack type (e.g., Warrior, Vampire, Goblin)
     if (!attacker.lastInput || attacker.attackCooldown > 0 || !attacker.stats.range || attacker.stats.range > MELEE_RANGE * 1.5) {
         return;
     }

    attacker.attackCooldown = ATTACK_COOLDOWN / (attacker.stats.attackSpeedModifier || 1);
    const attackAngle = Math.atan2(attacker.lastInput.mouseY - attacker.y, attacker.lastInput.mouseX - attacker.x);
    const reach = attacker.stats.range;

    // Увеличиваем конус атаки для более надежного попадания
    const attackCone = Math.PI / 3; // 60 градусов

    // Send visual confirmation of attack to the attacker's client
    safeSend(attacker.ws, JSON.stringify({
        type: 'meleeVisual',
        angle: attackAngle,
        reach: reach,
        playerId: attacker.id // Send attacker's ID
    }));


    for (const [targetId, target] of players) {
        if (targetId === attacker.id || target.isDead || target.canChooseLevel2) continue; // Don't hit self, dead, or choosing players

        const dist = distance(attacker.x, attacker.y, target.x, target.y);
        // Check if target is within range AND the cone
        if (dist < reach + target.radius) {
            const targetAngle = Math.atan2(target.y - attacker.y, target.x - attacker.x);
            const angleDiff = Math.abs(normalizeAngle(attackAngle - targetAngle));

             // Check if target is within the attack cone
             if (angleDiff < attackCone / 2) { // Divide cone by 2 for angle difference check
                 dealDamage(target, attacker.stats.damage, attacker);
                 // Send hit confirmation to the attacker's client
                 safeSend(attacker.ws, JSON.stringify({
                     type: 'hitConfirm',
                     damage: attacker.stats.damage,
                     targetId: targetId
                 }));
                 break; // Hit one target per swing
             }
        }
    }
}


// --- Damage & Death ---
function dealDamage(target, damage, dealer) {
    if (target.isDead || target.canChooseLevel2) return;

    const actualDamage = damage; // Could add defense/armor calculations here
    target.hp -= actualDamage;

    // Lifesteal
    if (dealer && players.has(dealer.id) && dealer.stats && dealer.stats.lifesteal > 0) {
        const healAmount = actualDamage * dealer.stats.lifesteal;
        dealer.hp = Math.min(dealer.maxHp, dealer.hp + healAmount);
         // Client will see HP change in the next state update
    }

    // Notify the target client they were hit (for visual effect)
     safeSend(target.ws, JSON.stringify({
         type: 'wasHit',
         damageTaken: actualDamage
     }));


    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        target.vx = 0;
        target.vy = 0;
        // Clear existing input to stop movement prediction on client
        target.lastInput = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
        console.log(`${target.name} killed by ${dealer ? dealer.name : 'Unknown'}`);

        if (dealer && players.has(dealer.id)) { // Check if dealer still exists
             dealer.killCount++;
             const xpDrop = Math.min(target.xp / 2 + 50, 500); // Drop some XP on death
             dealer.xp += xpDrop;
             checkLevelUp(dealer);
        }

        // Respawn logic
        setTimeout(() => {
            if (players.has(target.id)) { // Check if player hasn't disconnected
                 const raceData = getRaceBaseStats(target.race);
                 target.x = Math.random() * (MAP_WIDTH - 100) + 50;
                 target.y = Math.random() * (MAP_HEIGHT - 100) + 50;
                 // Reset HP/MaxHP based on current class/race (or base race if level 1)
                 const currentStats = target.classOrMutation ? getPlayerStatsAfterLevel2(target.race, target.classOrMutation) : getRaceBaseStats(target.race);
                 target.maxHp = currentStats.hp; // Use correct max HP
                 target.hp = target.maxHp; // Respawn with full HP
                 target.xp = Math.floor(target.xp * 0.5); // Lose half XP on death
                 // Re-check level up readiness if XP is still high enough
                 if (target.level < 2 && target.xp >= XP_TO_LEVEL_2) {
                      target.canChooseLevel2 = true;
                       safeSend(target.ws, JSON.stringify({ type: 'levelUpReady' }));
                 } else if (target.level === 2 && target.xp < XP_TO_LEVEL_2 / 2) {
                      // Optional: Demote if XP drops too low after death? More complex. Let's keep Lvl 2 if they reached it.
                      // If we did demote:
                      // target.level = 1;
                      // target.classOrMutation = null;
                      // const base = getRaceBaseStats(target.race);
                      // target.stats = {...base.stats};
                      // target.speed = base.speed;
                      // target.maxHp = base.hp;
                      // target.hp = target.maxHp;
                      // target.color = base.color;
                 }


                 target.isDead = false;
                 // Reset kill count on death? Or keep it for leaderboard score? Let's keep for simplicity.
                 // target.killCount = 0;
                 console.log(`${target.name} respawned`);
            }
        }, 5000); // 5 second respawn timer
    }
}

// Helper to get stats AFTER level 2 selection (used for respawn HP)
function getPlayerStatsAfterLevel2(race, choice) {
     const base = getRaceBaseStats(race); // Start from base race stats
     let stats = { ...base.stats }; // Copy stats object
     let maxHp = base.hp;
     let speed = base.speed;

     switch (choice) {
         case 'warrior': maxHp *= 1.3; stats.damage *= 1.5; stats.range = MELEE_RANGE * 1.2; break;
         case 'mage': maxHp *= 0.9; stats.damage = 12; stats.range = 400; stats.attackSpeedModifier = 0.8; break;
         case 'lord': stats.lifesteal = LIFESTEAL_PERCENT; maxHp *= 1.1; stats.damage *= 1.1; stats.range = MELEE_RANGE * 1.1; break;
         case 'higher': speed *= 1.2; stats.attackSpeedModifier = 0.6; stats.lifesteal = 0.05; stats.range = MELEE_RANGE * 1.05; break;
         case 'king': maxHp *= 1.4; stats.damage *= 1.1; stats.range = MELEE_RANGE * 0.9; break;
         case 'hobgoblin': maxHp *= 1.2; speed *= 0.85; stats.damage *= 1.8; stats.range = MELEE_RANGE * 1.1; break;
     }
     return { hp: maxHp, speed: speed, stats: stats };
}


// --- Leveling ---
function checkLevelUp(player) {
    if (player.level === 1 && player.xp >= XP_TO_LEVEL_2) {
        player.level = 2;
        player.canChooseLevel2 = true; // Set flag
        // Notify the client they can level up
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
    let usePound = false;
    if (col[0] == "#") {
        col = col.slice(1);
        usePound = true;
    }
    let num = parseInt(col, 16);
    let r = (num >> 16) + amt;
    if (r > 255) r = 255;
    else if (r < 0) r = 0;
    let b = ((num >> 8) & 0x00FF) + amt;
    if (b > 255) b = 255;
    else if (b < 0) b = 0;
    let g = (num & 0x0000FF) + amt;
    if (g > 255) g = 255;
    else if (g < 0) g = 0;

    // Pad the color string with leading zeros if needed
    let color = (g | (b << 8) | (r << 16)).toString(16);
    while(color.length < 6) {
        color = "0" + color;
    }
    return (usePound ? "#" : "") + color;
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
    const deltaTime = (now - (lastUpdateTime || now)) / 1000.0; // Time since last update in seconds
    lastUpdateTime = now;

    // 1. Process Inputs & Update Velocities
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2 || !player.lastInput) {
             player.vx = 0;
             player.vy = 0;
             return;
        }

        let moveX = 0;
        let moveY = 0;
        // Apply movement input directly
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

        // Attack Cooldown
        if (player.attackCooldown > 0) {
            player.attackCooldown -= deltaTime * 1000; // Decrement cooldown in ms
        }

        // Handle Attack Input
        if (player.lastInput.attack && player.attackCooldown <= 0) {
             // Check if player has chosen a class yet. Level 1 attack or specific Lvl 2 attack.
             if (player.classOrMutation === null) { // Level 1 attack
                 // Give level 1 players a basic melee attack
                 player.stats.range = MELEE_RANGE * 0.8; // Default short range
                 player.stats.damage = 5; // Low damage
                 player.stats.attackSpeedModifier = 1; // Default speed
                 performMeleeAttack(player);
             } else if (player.stats.range > MELEE_RANGE * 1.5) { // Ranged attack (Mage check, using a threshold)
                 createProjectile(player);
             } else { // Melee attack (Warrior, Vampire, Goblin mutations)
                 performMeleeAttack(player);
             }
             // Note: inputState.attack is reset client-side per tick. Server just acts if it sees true.
        }
    });

    // 2. Update Positions & Check Boundaries
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return;
        player.x += player.vx; // Simple Euler integration
        player.y += player.vy;

        // Boundary checks
        player.x = Math.max(player.radius, Math.min(MAP_WIDTH - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(MAP_HEIGHT - player.radius, player.y));
    });

     // 3. Update Projectiles & Check Collisions
    const projectilesToRemove = [];
    projectiles.forEach(proj => {
        proj.x += proj.dx;
        proj.y += proj.dy;
        const distanceTraveled = Math.sqrt(proj.dx*proj.dx + proj.dy*proj.dy);
        proj.rangeLeft -= distanceTraveled;

        // Check projectile out of range or bounds
        if (proj.rangeLeft <= 0 || proj.x < -100 || proj.x > MAP_WIDTH + 100 || proj.y < -100 || proj.y > MAP_HEIGHT + 100) { // Add margin
            projectilesToRemove.push(proj.id);
            return; // Continue to next projectile
        }

        // Check projectile collision with players
        for (const [targetId, target] of players) {
            if (targetId === proj.ownerId || target.isDead || target.canChooseLevel2) continue; // Don't hit self, dead, or choosing players

            const dist = distance(proj.x, proj.y, target.x, target.y);
            if (dist < target.radius + proj.radius) {
                const owner = players.get(proj.ownerId);
                dealDamage(target, proj.damage, owner);
                projectilesToRemove.push(proj.id); // Remove projectile on hit
                 return; // Projectile hits one target, stop checking players for this projectile
            }
        }
    });
    projectilesToRemove.forEach(id => projectiles.delete(id));


    // 4. Check Player-Orb Collisions
    const orbsToRemove = [];
    players.forEach(player => {
        if (player.isDead || player.canChooseLevel2) return; // Don't collect orbs while choosing class or dead

        orbs.forEach(orb => {
            const dist = distance(player.x, player.y, orb.x, orb.y);
            const attractRadius = player.radius + orb.radius + 50; // Orbs get attracted slightly
            if (dist < attractRadius) {
                 // Simple attraction logic
                 const angle = Math.atan2(player.y - orb.y, player.x - orb.x);
                 const attractSpeed = 1; // Pixels per tick
                 orb.x += Math.cos(angle) * attractSpeed;
                 orb.y += Math.sin(angle) * attractSpeed;
            }


            if (dist < player.radius + orb.radius) { // Actual collision
                player.xp += orb.value;
                orbsToRemove.push(orb.id);
                checkLevelUp(player); // Check if player leveled up
            }
        });
    });
    orbsToRemove.forEach(id => orbs.delete(id));

    // 5. Spawn new orbs
    if (Math.random() < 0.2 && orbs.size < ORB_COUNT) { // Chance to spawn an orb each tick, up to max
        spawnOrb();
    }

    // 6. Prepare State Update for Clients
    const playersData = [];
    players.forEach(p => {
        // Send player data including dead state and canChooseLevel2
        playersData.push(getPlayerDataForClient(p));
    });
    const orbsData = Array.from(orbs.values());
    const projectilesData = Array.from(projectiles.values());

    const gameState = {
        type: 'gameState',
        players: playersData,
        orbs: orbsData,
        projectiles: projectilesData
    };
    const gameStateString = JSON.stringify(gameState);

    // 7. Broadcast State to all connected clients
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Optional: send only nearby players/orbs/projectiles
            // For simplicity, broadcasting full state in this minimal example
            safeSend(client, gameStateString);
        }
    });
}

// Function to get player data suitable for sending to clients (omit ws object)
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
        killCount: player.killCount // Send kill count for leaderboard
    };
}


// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Client connected: ${playerId}`);
    let currentPlayer = null; // Will be set on 'join'

    ws.on('message', (message) => {
        if (ws.readyState !== WebSocket.OPEN) return; // Ignore messages if connection is not open

        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    if (!players.has(playerId)) {
                         const name = data.name ? data.name.substring(0, 16) : 'Anon';
                         const race = data.race || 'human';
                         currentPlayer = createPlayer(playerId, ws, name, race);
                         players.set(playerId, currentPlayer);
                         console.log(`Player ${currentPlayer.name} (${currentPlayer.race}) joined with ID ${playerId}`);

                        // Send initial state to the new player
                        safeSend(ws, JSON.stringify({
                            type: 'welcome',
                            playerId: playerId,
                            mapWidth: MAP_WIDTH,
                            mapHeight: MAP_HEIGHT,
                            initialState: { // Send current game state
                                players: Array.from(players.values()).map(getPlayerDataForClient),
                                orbs: Array.from(orbs.values()),
                                projectiles: Array.from(projectiles.values())
                            }
                        }));
                    }
                    break;

                case 'input':
                    // Only update input if player exists, is not dead, and not choosing class
                    if (currentPlayer && !currentPlayer.isDead && !currentPlayer.canChooseLevel2) {
                         // Basic sanitization of input coordinates
                         const mouseX = typeof data.input.mouseX === 'number' ? data.input.mouseX : 0;
                         const mouseY = typeof data.input.mouseY === 'number' ? data.input.mouseY : 0;

                         currentPlayer.lastInput = {
                             up: !!data.input.up, // Ensure boolean
                             down: !!data.input.down,
                             left: !!data.input.left,
                             right: !!data.input.right,
                             attack: !!data.input.attack,
                             mouseX: mouseX,
                             mouseY: mouseY
                         };
                    } else if (currentPlayer) {
                         // Clear input if player is dead or choosing class
                          currentPlayer.lastInput = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
                    }
                    break;

                 case 'selectClass':
                     if (currentPlayer && currentPlayer.level === 2 && currentPlayer.canChooseLevel2 && data.choice) {
                         // Basic validation of the choice
                         const validChoices = ['warrior', 'mage', 'lord', 'higher', 'king', 'hobgoblin'];
                         if (validChoices.includes(data.choice)) {
                             applyLevel2Specialization(currentPlayer, data.choice);
                             console.log(`${currentPlayer.name} chose: ${data.choice}`);
                         } else {
                             console.warn(`Invalid class selection for ${currentPlayer.name}: ${data.choice}`);
                             // Optional: send an error back to the client
                         }
                     }
                     break;

                // Add other message types as needed (chat, etc.)
            }
        } catch (error) {
            console.error('Failed to process message or invalid JSON:', message, error);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${playerId}`);
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
let lastUpdateTime = Date.now();
setInterval(gameLoop, 1000 / 60); // ~60 FPS game logic update rate

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the game at http://localhost:${PORT}`);
});
