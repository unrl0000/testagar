// client.js
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const startScreen = document.getElementById('start-screen');
const nameInput = document.getElementById('name-input');
const raceSelection = document.getElementById('race-selection');
const raceButtons = raceSelection.querySelectorAll('button');
const startButton = document.getElementById('start-button');
const errorMessage = document.getElementById('error-message');
const level2SelectionScreen = document.getElementById('level2-selection');
const level2OptionsDiv = document.getElementById('level2-options');

const touchControls = document.getElementById('touch-controls');
const joystickArea = document.getElementById('joystick-area');
const joystickThumb = document.getElementById('joystick-thumb');
const attackButton = document.getElementById('attack-button');

let ws; // WebSocket connection
let selfId = null; // This client's player ID

// Game State - Client manages two states for interpolation
let prevGameState = { players: [], orbs: [], projectiles: [] };
let currentGameState = { players: [], orbs: [], projectiles: [] };
let lastServerUpdateTime = 0; // Timestamp of when currentGameState was received
let serverTimeOffset = 0; // Difference between server time and client time

let mapWidth = 2000; // Default, will be updated by server
let mapHeight = 2000;
let selectedRace = null;

// --- Input State ---
let inputState = {
    up: false,
    down: false,
    left: false,
    right: false,
    attack: false,
    mouseX: 0, // World coordinates
    mouseY: 0  // World coordinates
};
let mouseScreenX = window.innerWidth / 2; // Screen coordinates
let mouseScreenY = window.innerHeight / 2; // Screen coordinates

// --- Camera State (follows player) ---
let camera = {
    x: 0,
    y: 0
};

// --- Touch Control State ---
let touchIdentifier = null; // To track which touch is the joystick
let joystickActive = false;
let joystickCenterX = 0; // Initial center of joystick area
let joystickCenterY = 0; // Initial center of joystick area
const JOYSTICK_AREA_RADIUS = joystickArea.offsetWidth / 2; // Radius of the whole area
const JOYSTICK_THUMB_RADIUS = joystickThumb.offsetWidth / 2; // Radius of the thumb
const MAX_JOYSTICK_MOVE = JOYSTICK_AREA_RADIUS - JOYSTICK_THUMB_RADIUS; // Max distance thumb can move

// --- Game Setup ---
function init() {
    setupStartScreen();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    // Set up input listeners AFTER canvas is visible/ready
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
     // Recalculate joystick center offset relative to screen if needed, or rely on CSS positioning
     const rect = joystickArea.getBoundingClientRect();
     joystickCenterX = rect.left + JOYSTICK_AREA_RADIUS;
     joystickCenterY = rect.top + JOYSTICK_AREA_RADIUS;
}

function setupStartScreen() {
    raceButtons.forEach(button => {
        button.addEventListener('click', () => {
            raceButtons.forEach(btn => btn.classList.remove('selected'));
            button.classList.add('selected');
            selectedRace = button.getAttribute('data-race');
        });
    });

    startButton.addEventListener('click', joinGame);
    nameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinGame();
        }
    });
}

function joinGame() {
    const name = nameInput.value.trim();
    if (!name) {
        showError("Please enter a name.");
        return;
    }
    if (!selectedRace) {
        showError("Please select a race.");
        return;
    }

    // Before hiding, detect touch and setup input based on device
    detectDeviceAndSetupInput();

    startScreen.style.display = 'none';
    canvas.style.display = 'block';
    errorMessage.textContent = '';

    connectWebSocket(name, selectedRace);
}

function showError(message) {
    errorMessage.textContent = message;
}

function detectDeviceAndSetupInput() {
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
    if (isTouch) {
        console.log("Touch device detected. Setting up touch controls.");
        touchControls.style.display = 'flex'; // Use flex for layout
        setupTouchControls();
    } else {
        console.log("Mouse/Keyboard device detected. Setting up keyboard/mouse controls.");
        setupMouseKeyboardControls();
    }
}


// --- WebSocket Connection ---
function connectWebSocket(name, race) {
    // Use wss:// if the site is served over https, ws:// otherwise
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // For Render, window.location.host is correct. For local testing, might need ws://localhost:3000
     // const wsUrl = `${protocol}://${window.location.host}`;
    const wsUrl = `${protocol}://${window.location.hostname}:${window.location.port || (protocol === 'wss' ? 443 : 80)}`; // More robust URL construction


    console.log(`Connecting to ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Connected to WebSocket server.');
        // Send join message
        ws.send(JSON.stringify({ type: 'join', name: name, race: race }));
        // Start sending input updates - sent continuously
        setInterval(sendInput, 1000 / 30); // Send input ~30 times/sec
        requestAnimationFrame(gameLoop); // Start rendering loop
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'welcome':
                    selfId = message.playerId;
                    mapWidth = message.mapWidth;
                    mapHeight = message.mapHeight;
                    serverTimeOffset = message.serverTime - Date.now(); // Calculate initial offset
                    console.log(`Joined game with ID: ${selfId}. Server time offset: ${serverTimeOffset}ms`);
                    break;
                case 'gameState':
                     // Store previous state, update current state
                    prevGameState = currentGameState;
                    currentGameState = message;
                    lastServerUpdateTime = Date.now(); // Record local time of receipt
                    // Update server time offset more accurately over time? Optional:
                    // serverTimeOffset = (serverTimeOffset * 0.9) + ((message.serverTime - Date.now()) * 0.1); // Smoothing
                    break;
                 case 'levelUpReady':
                     console.log("Level up ready! Showing selection.");
                     showLevel2Selection();
                     break;
                 case 'classSelected':
                     console.log("Class/Mutation confirmed by server.");
                     // The gameState update will contain the player's new stats/color
                     level2SelectionScreen.style.display = 'none'; // Hide selection screen
                     break;
                case 'respawn':
                     console.log("Respawned!");
                      // Update self player state from the provided player object
                      // This overrides local prediction for a moment, but is necessary for respawn
                     const respawnPlayer = message.player;
                     const self = currentGameState.players.find(p => p.id === selfId);
                      if (self) {
                         Object.assign(self, respawnPlayer); // Update current state with respawn data
                          // To make it smoother, might need to also update prevGameState?
                          // Or ensure gameLoop handles 'isDead' -> !'isDead' transition gracefully.
                      }
                     break;
                // Handle other message types (playerJoined, playerLeft, meleeVisual, etc.)
            }
        } catch (error) {
            console.error('Error processing message:', event.data, error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showError('Connection error. Please refresh.');
    };

    ws.onclose = (event) => {
        console.log(`WebSocket connection closed (Code: ${event.code}, Reason: ${event.reason}).`);
        showError('Disconnected from server. Please refresh.');
        cancelAnimationFrame(gameLoop); // Stop rendering
        // Show start screen again or a disconnected message?
        startScreen.style.display = 'block';
        canvas.style.display = 'none';
        touchControls.style.display = 'none';
        level2SelectionScreen.style.display = 'none';
        // Clear game state?
        gameState = { players: [], orbs: [], projectiles: [] };
        selfId = null;
    };
}

// --- Input Handling (Mouse/Keyboard) ---
function setupMouseKeyboardControls() {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Prevent right-click menu
}

function handleKeyDown(e) {
    if (level2SelectionScreen.style.display !== 'none') return; // Ignore input if choosing class
    switch (e.key.toLowerCase()) {
        case 'w': case 'arrowup': inputState.up = true; break;
        case 's': case 'arrowdown': inputState.down = true; break;
        case 'a': case 'arrowleft': inputState.left = true; break;
        case 'd': case 'arrowright': inputState.right = true; break;
    }
}

function handleKeyUp(e) {
    switch (e.key.toLowerCase()) {
        case 'w': case 'arrowup': inputState.up = false; break;
        case 's': case 'arrowdown': inputState.down = false; break;
        case 'a': case 'arrowleft': inputState.left = false; break;
        case 'd': case 'arrowright': inputState.right = false; break;
    }
}

function handleMouseMove(e) {
    mouseScreenX = e.clientX;
    mouseScreenY = e.clientY;
}

function handleMouseDown(e) {
     if (level2SelectionScreen.style.display !== 'none') return;
    if (e.button === 0) { // Left mouse button
        inputState.attack = true;
    }
}

function handleMouseUp(e) {
     if (e.button === 0) {
        inputState.attack = false;
    }
}

// --- Input Handling (Touch) ---
function setupTouchControls() {
    joystickArea.addEventListener('touchstart', handleJoystickStart, { passive: false });
    joystickArea.addEventListener('touchmove', handleJoystickMove, { passive: false });
    joystickArea.addEventListener('touchend', handleJoystickEnd, { passive: false });
    joystickArea.addEventListener('touchcancel', handleJoystickEnd, { passive: false });

    attackButton.addEventListener('touchstart', handleAttackTouchStart, { passive: false });
    attackButton.addEventListener('touchend', handleAttackTouchEnd, { passive: false });
     attackButton.addEventListener('touchcancel', handleAttackTouchEnd, { passive: false });
}

function handleJoystickStart(e) {
    e.preventDefault(); // Prevent default touch behavior (like scrolling)
    if (level2SelectionScreen.style.display !== 'none') return;
    // Find the first touch that's inside the joystick area
    for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
         const rect = joystickArea.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom && !joystickActive) {
            joystickActive = true;
            touchIdentifier = touch.identifier;
            // Store the *initial* touch position relative to the screen
            joystickStartX = touch.clientX;
            joystickStartY = touch.clientY;

            // Position the thumb at the touch start location relative to the joystick area's center
             const areaCenterX = rect.left + JOYSTICK_AREA_RADIUS;
             const areaCenterY = rect.top + JOYSTICK_AREA_RADIUS;
             const dx = touch.clientX - areaCenterX;
             const dy = touch.clientY - areaCenterY;
             joystickThumb.style.transform = `translate(${dx}px, ${dy}px)`;

             updateInputFromJoystick(dx, dy); // Update input based on initial touch position
             break; // Only track the first touch
        }
    }
}

function handleJoystickMove(e) {
    e.preventDefault();
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    // Calculate displacement from the *initial* touch start point
    let dx = touch.clientX - joystickStartX;
    let dy = touch.clientY - joystickStartY;

    const distance = Math.sqrt(dx * dx + dy * dy);

    // Clamp the thumb position relative to the joystick area's center
    const rect = joystickArea.getBoundingClientRect();
    const areaCenterX = rect.left + JOYSTICK_AREA_RADIUS;
    const areaCenterY = rect.top + JOYSTICK_AREA_RADIUS;

    let clampedX = touch.clientX - areaCenterX;
    let clampedY = touch.clientY - areaCenterY;

    const clampDistance = Math.sqrt(clampedX*clampedX + clampedY*clampedY);

     if (clampDistance > MAX_JOYSTICK_MOVE) {
         const scale = MAX_JOYSTICK_MOVE / clampDistance;
         clampedX *= scale;
         clampedY *= scale;
     }

    joystickThumb.style.transform = `translate(${clampedX}px, ${clampedY}px)`;

     // Use the clamped position delta *from the center* to determine input state and aiming
    updateInputFromJoystick(clampedX, clampedY);
}

function handleJoystickEnd(e) {
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);

    if (touch) { // If the touch we were tracking ended
        resetJoystick();
    } else {
        // This happens if the joystick touch is still active but another touch ended.
        // We don't reset the joystick in this case.
        // We could potentially check if ALL touches are off the joystick area,
        // but relying on tracking the specific touchifier is more robust.
    }
}

function resetJoystick(){
     joystickActive = false;
     touchIdentifier = null;
     joystickThumb.style.transform = `translate(0px, 0px)`;
     // Stop movement
     inputState.up = false;
     inputState.down = false;
     inputState.left = false;
     inputState.right = false;
     // Reset aiming? Or keep last aim direction?
     // Let's reset aiming to point straight "up" or "right" or similar neutral direction
     // Or better, calculate aim towards screen center in world coordinates when joystick stops?
      const selfPlayer = currentGameState.players.find(p => p.id === selfId);
      if (selfPlayer) {
         inputState.mouseX = selfPlayer.x + (canvas.width / 2 - canvas.width / 2); // Aim center world
         inputState.mouseY = selfPlayer.y + (canvas.height / 2 - canvas.height / 2);
      } else {
         // Default aim if player not found (shouldn't happen if joystick is active)
         inputState.mouseX = camera.x;
         inputState.mouseY = camera.y;
      }
}


function updateInputFromJoystick(deltaX, deltaY) {
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const threshold = MAX_JOYSTICK_MOVE * 0.1; // Minimum movement to register

    if (distance < threshold) {
        inputState.up = false;
        inputState.down = false;
        inputState.left = false;
        inputState.right = false;
    } else {
        const angle = Math.atan2(deltaY, deltaX);

        // Update movement direction based on angle (using 8 directions approx)
        inputState.up = (angle > -Math.PI * 0.875 && angle < -Math.PI * 0.125);
        inputState.down = (angle > Math.PI * 0.125 && angle < Math.PI * 0.875);
        inputState.left = (angle > Math.PI * 0.625 || angle < -Math.PI * 0.625);
        inputState.right = (angle > -Math.PI * 0.375 && angle < Math.PI * 0.375);

         // Update aiming direction based on joystick delta
         // Aim relative to player's current position on screen
         const selfPlayer = currentGameState.players.find(p => p.id === selfId);
         if (selfPlayer) {
             // Convert delta from screen space relative to joystick center to world space relative to player
             const aimSensitivity = 5; // How much joystick movement translates to aim distance
             inputState.mouseX = selfPlayer.x + deltaX * aimSensitivity;
             inputState.mouseY = selfPlayer.y + deltaY * aimSensitivity;
         } else {
              // Fallback: Aim relative to camera center if player state isn't available
              inputState.mouseX = camera.x + deltaX * aimSensitivity;
              inputState.mouseY = camera.y + deltaY * aimSensitivity;
         }
    }
}

function handleAttackTouchStart(e) {
    e.preventDefault();
     if (level2SelectionScreen.style.display !== 'none') return;
    inputState.attack = true;
     // For touch attack, aiming could be:
     // 1. Towards joystick direction if active (already handled by updateInputFromJoystick)
     // 2. Towards screen center in world coords if standing still (handled in sendInput)
     // 3. Towards the location of the attack touch? (More complex, requires tracking attack touch)
}

function handleAttackTouchEnd(e) {
    e.preventDefault();
    inputState.attack = false; // Stop attacking when button is released
}


function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId) return;

    // If not using touch joystick, calculate mouse world coordinates from screen coordinates
    if (!joystickActive) {
        const selfPlayer = currentGameState.players.find(p => p.id === selfId);
        if (selfPlayer) {
            // Convert screen mouse coordinates to world coordinates relative to camera position
            inputState.mouseX = camera.x + (mouseScreenX - canvas.width / 2);
            inputState.mouseY = camera.y + (mouseScreenY - canvas.height / 2);
        } else {
             // If self player state is missing, use camera center as a fallback aim point
             inputState.mouseX = camera.x;
             inputState.mouseY = camera.y;
        }
    }
     // else: inputState.mouseX/Y are updated by updateInputFromJoystick

    ws.send(JSON.stringify({ type: 'input', input: inputState }));

    // inputState.attack is now reset on mouseup/touchend events, not after sending.
    // This allows holding the attack button/mouse.
}

// --- Level 2 Specialization Screen ---
function showLevel2Selection() {
    const player = currentGameState.players.find(p => p.id === selfId);
    if (!player) return;

    level2OptionsDiv.innerHTML = ''; // Clear previous options

    let choices = [];
    switch (player.race) {
        case 'human':
        case 'elf':
        case 'gnome':
            choices = [
                { id: 'warrior', name: 'Warrior', desc: '+HP, Melee Dmg' },
                { id: 'mage', name: 'Mage', desc: 'Ranged Attack' }
            ];
            break;
        case 'vampire':
            choices = [
                { id: 'lord', name: 'Lord Vampire', desc: 'High Lifesteal, +HP' },
                { id: 'higher', name: 'Higher Vampire', desc: '+Speed, +Atk Speed, Some Lifesteal' }
            ];
            break;
        case 'goblin':
            choices = [
                { id: 'king', name: 'Goblin King', desc: '++HP, Melee' }, // Desc simplified
                { id: 'hobgoblin', name: 'Hobgoblin', desc: '+HP, High Melee Dmg, -Speed' }
            ];
            break;
         default:
             console.error(`Unknown race ${player.race} for level 2 selection`);
             // Hide selection? Or show error?
             level2SelectionScreen.style.display = 'none';
             return;
    }

    choices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = `${choice.name} (${choice.desc})`;
        button.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'selectClass', choice: choice.id }));
                 // Client assumes choice is successful immediately
                 // This helps responsiveness, but server state is authoritative.
                 level2SelectionScreen.style.display = 'none';
            }
        };
        level2OptionsDiv.appendChild(button);
    });

    level2SelectionScreen.style.display = 'block';
}


// --- Rendering ---
let lastRenderTime = 0;
const SERVER_TICK_RATE_MS = 1000 / 33; // Match server tick rate

function gameLoop(timestamp) {
    if (!selfId || !ws || ws.readyState !== WebSocket.OPEN) {
        // console.log("Game loop halted.");
        lastRenderTime = timestamp; // Keep track even if paused
        requestAnimationFrame(gameLoop); // Keep requesting to resume
        return;
    }

    const now = Date.now();
    const deltaTime = (timestamp - lastRenderTime) / 1000.0; // Time since last render in seconds
    lastRenderTime = timestamp;

    const selfPlayer = currentGameState.players.find(p => p.id === selfId);

     if (!selfPlayer || selfPlayer.isDead) {
         // If player is dead or not found, maybe show a different screen or spectator view?
         // For now, just clear and show nothing or a death screen
         ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (selfPlayer && selfPlayer.isDead) {
               // Draw simple "You are dead" message and respawn timer?
               drawDeathScreen(selfPlayer);
          }
         requestAnimationFrame(gameLoop);
         return;
     }


    // Calculate interpolation factor
    // How much time has passed since the last server update, relative to the server's tick interval?
    const timeSinceLastUpdate = now - lastServerUpdateTime;
    let interpolationFactor = timeSinceLastUpdate / SERVER_TICK_RATE_MS;
    // Clamp factor to prevent overshooting, especially during lag spikes
    interpolationFactor = Math.min(interpolationFactor, 1.5); // Allow slight overshoot for smoother feel

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update camera to follow *interpolated* self player position
    // For responsiveness, camera *could* follow a predicted position,
    // but following interpolated position is simpler and less jumpy if prediction is off.
    // Let's make camera follow the player's *current* position (not interpolated for self) for max responsiveness.
    camera.x = selfPlayer.x;
    camera.y = selfPlayer.y;


    // Translate canvas to center camera on screen
    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    // --- Draw game elements (world relative) ---
    drawMapBackground();

    // Draw interpolated orbs
    drawOrbs(prevGameState.orbs, currentGameState.orbs, interpolationFactor);

    // Draw interpolated projectiles
    drawProjectiles(prevGameState.projectiles, currentGameState.projectiles, interpolationFactor);

    // Draw interpolated OTHER players
    drawPlayers(prevGameState.players, currentGameState.players, interpolationFactor, selfId);

    // Draw SELF player (potentially use client-side prediction for position if needed, but current pos is fine)
     drawPlayer(selfPlayer, selfPlayer.x, selfPlayer.y); // Draw self at its current position from gameState

    // Restore context for UI elements
    ctx.restore();

    // --- Draw UI elements (screen relative) ---
    drawUI(selfPlayer);


    // Request next frame
    requestAnimationFrame(gameLoop);
}


function drawMapBackground() {
    ctx.fillStyle = '#222'; // Match canvas background
    ctx.fillRect(0, 0, mapWidth, mapHeight); // Fill the entire map area

    // Simple boundary box
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);

    // Simple grid
    const gridSize = 100;
    ctx.strokeStyle = '#333'; // Darker grid lines
    ctx.lineWidth = 1;
    for (let x = 0; x <= mapWidth; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mapHeight);
        ctx.stroke();
    }
    for (let y = 0; y <= mapHeight; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(mapWidth, y);
        ctx.stroke();
    }
}

// Helper to get interpolated position
function getInterpolatedPosition(prev, curr, factor) {
    // Ensure prev and curr are valid and correspond to the same entity ID
    if (!prev || !curr || prev.id !== curr.id) {
        return curr ? { x: curr.x, y: curr.y } : null; // Fallback to current if no previous or mismatch
    }
    return {
        x: prev.x + (curr.x - prev.x) * factor,
        y: prev.y + (curr.y - prev.y) * factor
    };
}

// Find object by ID in a list
function findById(list, id) {
    return list.find(item => item.id === id);
}


function drawOrbs(prevOrbs, currentOrbs, factor) {
    ctx.fillStyle = '#f0e370'; // Orb color
     currentOrbs.forEach(currentOrb => {
          const prevOrb = findById(prevOrbs, currentOrb.id);
          const interpolatedPos = getInterpolatedPosition(prevOrb, currentOrb, factor);
          if (interpolatedPos && isElementVisible(interpolatedPos.x, interpolatedPos.y, currentOrb.radius * 2)) {
               ctx.beginPath();
               ctx.arc(interpolatedPos.x, interpolatedPos.y, currentOrb.radius, 0, Math.PI * 2);
               ctx.fill();
          }
     });
     // Optional: Also draw orbs that were in prev but not current (fading out)
}

function drawProjectiles(prevProjectiles, currentProjectiles, factor) {
     currentProjectiles.forEach(currentProj => {
          const prevProj = findById(prevProjectiles, currentProj.id);
          const interpolatedPos = getInterpolatedPosition(prevProj, currentProj, factor);
          if (interpolatedPos && isElementVisible(interpolatedPos.x, interpolatedPos.y, currentProj.radius * 2)) {
              ctx.fillStyle = currentProj.color || '#ffffff';
              ctx.beginPath();
              ctx.arc(interpolatedPos.x, interpolatedPos.y, currentProj.radius, 0, Math.PI * 2);
              ctx.fill();
          }
     });
      // Optional: Also draw projectiles that were in prev but not current (fading out)
}

function drawPlayers(prevPlayers, currentPlayers, factor, selfId) {
    currentPlayers.forEach(currentPlayer => {
        if (currentPlayer.id === selfId || currentPlayer.isDead) return; // Skip self and dead players here

        const prevPlayer = findById(prevPlayers, currentPlayer.id);
        const interpolatedPos = getInterpolatedPosition(prevPlayer, currentPlayer, factor);

         if (interpolatedPos && isElementVisible(interpolatedPos.x, interpolatedPos.y, currentPlayer.radius * 4)) {
             drawPlayer(currentPlayer, interpolatedPos.x, interpolatedPos.y);
         }
    });

     // Draw Dead Players (Optional: Add a visual marker like a tombstone)
     currentPlayers.forEach(player => {
          if (player.isDead) {
               // For simplicity, let's just draw them as gray circles or not at all
               // If drawing, need a death timer visual?
               // isElementVisible(player.x, player.y, player.radius * 2)
          }
     });
}

// Helper function to draw a single player at specific coordinates
function drawPlayer(player, drawX, drawY) {
    // Draw Player Circle
    ctx.fillStyle = player.color || '#cccccc';
    ctx.strokeStyle = '#000000'; // Black outline
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(drawX, drawY, player.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw Name & Level
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`${player.name} [${player.level}]`, drawX, drawY - player.radius - 15);

    // Draw HP Bar
    const hpBarWidth = player.radius * 2;
    const hpBarHeight = 5;
    const hpBarX = drawX - hpBarWidth / 2;
    const hpBarY = drawY - player.radius - 10;
    const hpPercent = player.hp / player.maxHp;

    ctx.fillStyle = '#555'; // Background of HP bar
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
    ctx.fillStyle = hpPercent > 0.5 ? '#4CAF50' : (hpPercent > 0.2 ? '#ff9800' : '#f44336'); // Green/Yellow/Red
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth * Math.max(0, hpPercent), hpBarHeight); // Ensure min width is 0
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
}


function drawUI(selfPlayer) {
    // Draw XP Bar (Bottom Center)
    const xpBarWidth = canvas.width * 0.4;
    const xpBarHeight = 15;
    const xpBarX = (canvas.width - xpBarWidth) / 2;
    const xpBarY = canvas.height - xpBarHeight - 15; // 15px from bottom

    let xpForNextLevel = XP_TO_LEVEL_2; // Assuming only level 1 -> 2 for now
    let xpCurrentLevelBase = 0;

    const xpProgress = selfPlayer.xp - xpCurrentLevelBase;
    const xpNeeded = xpForNextLevel - xpCurrentLevelBase;
    const xpPercent = Math.min(1, xpNeeded > 0 ? xpProgress / xpNeeded : (selfPlayer.level > 1 ? 1 : 0)); // Cap at 100%

    ctx.fillStyle = '#555'; // Background
    ctx.fillRect(xpBarX, xpBarY, xpBarWidth, xpBarHeight);
    ctx.fillStyle = '#f0e370'; // XP Color (Yellow)
    ctx.fillRect(xpBarX, xpBarY, xpBarWidth * xpPercent, xpBarHeight);

    // XP Text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = '12px sans-serif';
    const xpText = selfPlayer.level === 1 ? `${Math.floor(xpProgress)} / ${xpNeeded} XP` : `Level ${selfPlayer.level}`; // Show progress only for level 1
    ctx.fillText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5 + 2); // Adjusted Y slightly for vertical centering
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.5;
    ctx.strokeText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5 + 2);


     // Draw Level (above XP bar)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'center';
     ctx.font = 'bold 16px sans-serif';
     ctx.fillText(`Level: ${selfPlayer.level}`, canvas.width / 2, xpBarY - 8);


     // Draw Kill Count (Top Right)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'right';
     ctx.font = '14px sans-serif';
     ctx.fillText(`Kills: ${selfPlayer.killCount || 0}`, canvas.width - 15, 25);

     // Draw simple crosshair for mouse aiming (only for non-touch)
     const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
     if (!isTouch) {
         ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
         ctx.lineWidth = 1;
         const crosshairSize = 10;
         ctx.beginPath();
         ctx.moveTo(mouseScreenX - crosshairSize, mouseScreenY);
         ctx.lineTo(mouseScreenX + crosshairSize, mouseScreenY);
         ctx.moveTo(mouseScreenX, mouseScreenY - crosshairSize);
         ctx.lineTo(mouseScreenX, mouseScreenY + crosshairSize);
         ctx.stroke();
     }
}

function drawDeathScreen(selfPlayer) {
     ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
     ctx.fillRect(0, 0, canvas.width, canvas.height);

     ctx.fillStyle = '#f44336'; // Red color
     ctx.textAlign = 'center';
     ctx.font = 'bold 30px sans-serif';
     ctx.fillText("You are Dead!", canvas.width / 2, canvas.height / 2 - 30);

      ctx.fillStyle = '#eeeeee';
      ctx.font = '20px sans-serif';

      // Calculate time left for respawn - requires server sending death time or time left
      // Since server sets a 5s timeout, we can make a rough estimate client side
      // This needs proper server sync to be accurate. For now, just show generic message.
      ctx.fillText("Respawning soon...", canvas.width / 2, canvas.height / 2 + 10);
      // Or if server sends respawn time:
      // const respawnTimeLeft = (selfPlayer.respawnTimestamp - Date.now()) / 1000;
      // if (respawnTimeLeft > 0) {
      //      ctx.fillText(`Respawning in ${Math.ceil(respawnTimeLeft)}...`, canvas.width / 2, canvas.height / 2 + 10);
      // }
}


// --- Utility ---
// Basic culling check (is the center of the element within the viewport + margin?)
function isElementVisible(worldX, worldY, margin = 100) {
     const screenX = worldX - camera.x + canvas.width / 2;
     const screenY = worldY - camera.y + canvas.height / 2;

     return screenX > -margin &&
            screenX < canvas.width + margin &&
            screenY > -margin &&
            screenY < canvas.height + margin;
}


// --- Start the application ---
init();
