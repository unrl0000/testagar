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
let gameState = { players: [], orbs: [], projectiles: [] };
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
    mouseX: 0,
    mouseY: 0
};
let mouseScreenX = window.innerWidth / 2; // Mouse position relative to viewport
let mouseScreenY = window.innerHeight / 2;

// --- Camera State ---
let camera = {
    x: 0,
    y: 0,
    zoom: 1.0 // Future feature?
};
const CAMERA_LERP_FACTOR = 0.08; // Adjust for camera smoothness

// --- Touch Control State ---
let touchIdentifier = null;
let joystickActive = false;
let joystickCenterX = 0; // Center of the joystick area in screen coordinates
let joystickCenterY = 0;
let joystickCurrentX = 0; // Current touch position relative to screen
let joystickCurrentY = 0;
// Calculate these dynamically from CSS/element size
let JOYSTICK_RADIUS = 65; // Half of joystickArea width/height (130/2)
let THUMB_RADIUS = 30; // Half of joystickThumb width/height (60/2)
let MAX_JOYSTICK_DIST = JOYSTICK_RADIUS - THUMB_RADIUS;
const JOYSTICK_DEADZONE = JOYSTICK_RADIUS * 0.15; // 15% deadzone

// --- Game Visual Effects (Client Only) ---
let gameVisualEffects = []; // Array to store temporary effects (e.g., melee swings)

// --- Performance Settings ---
let sendInputInterval = 1000 / 30; // Default input send rate (30 Hz)
let currentInputIntervalId = null;

// --- Game Setup ---
function init() {
    setupStartScreen();
    setupInputListeners();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    detectDevicePerformance(); // Check device performance early
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Update joystick dimensions and position calculation on resize
     const rect = joystickArea.getBoundingClientRect();
     JOYSTICK_RADIUS = rect.width / 2;
     THUMB_RADIUS = joystickThumb.offsetWidth / 2; // Get thumb size dynamically
     MAX_JOYSTICK_DIST = JOYSTICK_RADIUS - THUMB_RADIUS;
     joystickCenterX = rect.left + JOYSTICK_RADIUS;
     joystickCenterY = rect.top + JOYSTICK_RADIUS;

     // Also update initial mouse position if not using joystick
     if (!('ontouchstart' in window) && navigator.maxTouchPoints <= 0) {
          mouseScreenX = window.innerWidth / 2;
          mouseScreenY = window.innerHeight / 2;
     }
}


function detectTouchDevice() {
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (isTouch) {
        touchControls.style.display = 'block'; // Show touch controls
        setupTouchControls();
         // Recalculate joystick position after it's displayed
         resizeCanvas();
    } else {
         // Hide touch controls if not a touch device
         touchControls.style.display = 'none';
    }
}

function detectDevicePerformance() {
    const isLowEndDevice = navigator.hardwareConcurrency <= 2 ||
                          navigator.deviceMemory <= 2;
                          // We can't reliably check screen resolution for performance, focus on CPU/Memory

    if (isLowEndDevice) {
        console.log("Detected potential low-end device. Applying performance optimizations.");
        // Reduce input send rate
        sendInputInterval = 1000 / 20; // 20 Hz
        // Client-side rendering optimization (less useful with culling, but can help)
        // ctx.imageSmoothingEnabled = false; // Can make graphics blocky but faster if not already off
        // canvas.style.imageRendering = 'crisp-edges'; // Standard way for pixel art, but might apply elsewhere
         canvas.style.imageRendering = 'auto'; // Let browser decide
    }
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

    startScreen.style.display = 'none';
    canvas.style.display = 'block';
    errorMessage.textContent = '';

    connectWebSocket(name, selectedRace);
}

function showError(message) {
    errorMessage.textContent = message;
}

// --- WebSocket Connection ---
function connectWebSocket(name, race) {
    // Use wss:// if the site is served over https, ws:// otherwise
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}`; // Connect to the same host serving the page

    console.log(`Connecting to ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Connected to WebSocket server.');
        // Send join message
        ws.send(JSON.stringify({ type: 'join', name: name, race: race }));
        // Start sending input updates at determined interval
        if (currentInputIntervalId) clearInterval(currentInputIntervalId);
        currentInputIntervalId = setInterval(sendInput, sendInputInterval);
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'welcome':
                    selfId = message.playerId;
                    mapWidth = message.mapWidth;
                    mapHeight = message.mapHeight;
                     // Initialize game state from welcome message
                    gameState = message.initialState || { players: [], orbs: [], projectiles: [] };
                    console.log(`Joined game with ID: ${selfId}. Initial state received.`);
                    // Find self player to potentially center camera immediately
                     const selfPlayerInitial = gameState.players.find(p => p.id === selfId);
                     if (selfPlayerInitial) {
                         camera.x = selfPlayerInitial.x;
                         camera.y = selfPlayerInitial.y;
                     }
                    requestAnimationFrame(gameLoop); // Start rendering loop
                    detectTouchDevice(); // Detect touch after canvas is shown
                    break;
                case 'gameState':
                    // Update game state received from server
                    // Simple replacement for now. Interpolation/prediction would modify this.
                    gameState = message;
                    break;
                 case 'levelUpReady':
                     console.log("Level up ready! Showing selection.");
                     showLevel2Selection();
                     break;
                 case 'classSelected':
                     console.log("Class/Mutation confirmed by server.");
                      // Server sends updated player data with gameState anyway,
                      // so we just need to hide the selection screen.
                     level2SelectionScreen.style.display = 'none'; // Hide selection
                     // Ensure the levelUpReady flag is cleared on the client player object if needed
                     const playerAfterSelect = gameState.players.find(p => p.id === selfId);
                     if(playerAfterSelect) playerAfterSelect.canChooseLevel2 = false;

                     break;
                 case 'meleeVisual':
                     // Add a temporary visual effect for a melee swing on a player
                     showMeleeAttackVisual(message.playerId, message.angle, message.reach);
                     break;
                 case 'hitConfirm':
                      // Handle hit confirmation (optional: client-side prediction correction)
                      // For damage visual, we react to 'wasHit'
                      console.log(`Hit confirmed on target ${message.targetId} for ${message.damage}`);
                      break;
                 case 'wasHit':
                     // Handle being hit by an attack (for damage visual)
                      console.log(`Was hit for ${message.damageTaken}`);
                      showDamageVisual(selfId); // Show damage effect on self
                     break;

                // Handle other message types (player death, chat, etc.)
            }
        } catch (error) {
            console.error('Error processing message:', event.data, error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showError('Connection error. Please refresh.');
        // Clean up interval and loops on error
        if (currentInputIntervalId) clearInterval(currentInputIntervalId);
        cancelAnimationFrame(gameLoop); // Stop rendering
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed.');
        showError('Disconnected from server. Please refresh.');
        // Clean up interval and loops on close
        if (currentInputIntervalId) clearInterval(currentInputIntervalId);
        cancelAnimationFrame(gameLoop); // Stop rendering
        startScreen.style.display = 'block';
        canvas.style.display = 'none';
         touchControls.style.display = 'none';
         level2SelectionScreen.style.display = 'none';
         selfId = null; // Clear selfId
         gameState = { players: [], orbs: [], projectiles: [] }; // Clear game state
    };
}

// --- Input Handling ---
function setupInputListeners() {
    // Keyboard
    window.addEventListener('keydown', (e) => {
        if (level2SelectionScreen.style.display !== 'none') return; // Ignore input if choosing class
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = true; break;
            case 's': case 'arrowdown': inputState.down = true; break;
            case 'a': case 'arrowleft': inputState.left = true; break;
            case 'd': case 'arrowright': inputState.right = true; break;
        }
    });

    window.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = false; break;
            case 's': case 'arrowdown': inputState.down = false; break;
            case 'a': case 'arrowleft': inputState.left = false; break;
            case 'd': case 'arrowright': inputState.right = false; break;
        }
    });

    // Mouse
    canvas.addEventListener('mousemove', (e) => {
        // Only update mouse screen pos if not using joystick
        if (!joystickActive) {
             mouseScreenX = e.clientX;
             mouseScreenY = e.clientY;
        }
    });

    canvas.addEventListener('mousedown', (e) => {
         if (level2SelectionScreen.style.display !== 'none') return;
        if (e.button === 0) { // Left mouse button
            inputState.attack = true; // Set attack flag
        }
    });

     // Prevent context menu on right click
     canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setupTouchControls() {
    joystickArea.addEventListener('touchstart', handleJoystickStart, { passive: false });
    joystickArea.addEventListener('touchmove', handleJoystickMove, { passive: false });
    joystickArea.addEventListener('touchend', handleJoystickEnd, { passive: false });
    joystickArea.addEventListener('touchcancel', handleJoystickEnd, { passive: false });

    attackButton.addEventListener('touchstart', (e) => {
         e.preventDefault();
         if (level2SelectionScreen.style.display !== 'none') return;
         // Set attack flag. It's reset in sendInput after being sent.
         inputState.attack = true;
     }, { passive: false });

     attackButton.addEventListener('touchend', (e) => {
          e.preventDefault();
          // Keep attack flag true until sent in sendInput, allows single tap to fire
     }, { passive: false });

     // Ensure joystick area position is calculated after touchControls is displayed
     resizeCanvas(); // Call resize to update joystickCenterX/Y etc.

     // Optional: If no joystick active, maybe touch-to-aim on main screen?
     // For now, if joystick isn't used, aiming falls back to mouseScreenX/Y logic in sendInput.
}

function handleJoystickStart(e) {
    e.preventDefault(); // Prevent scrolling, zooming
    if (level2SelectionScreen.style.display !== 'none') return;
    if (joystickActive) return; // Prevent multiple touches starting it

    const touch = e.changedTouches[0];
    touchIdentifier = touch.identifier;
    joystickActive = true;

    // Capture initial touch position for thumb translation calculation
    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;

    updateJoystickThumb(); // Position thumb immediately
    updateInputFromJoystick(); // Update input state
}

function handleJoystickMove(e) {
    e.preventDefault(); // Prevent scrolling, zooming
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;

    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return; // Not the touch that started the joystick

    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;

    updateJoystickThumb(); // Update thumb position visually
    updateInputFromJoystick(); // Update input state based on new position
}

function handleJoystickEnd(e) {
    e.preventDefault(); // Prevent scrolling, zooming
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);

     // If the specific touch that started the joystick ended, reset
    if (touch) {
         resetJoystick();
     } else {
         // If a different touch ended, check if *any* touch is still on the joystick area
         let stillTouchingJoystick = false;
         const rect = joystickArea.getBoundingClientRect();
         for(let i=0; i<e.touches.length; i++){
             const t = e.touches[i];
             if(t.clientX >= rect.left && t.clientX <= rect.right && t.clientY >= rect.top && t.clientY <= rect.bottom) {
                 stillTouchingJoystick = true;
                 break;
             }
         }
         if (!stillTouchingJoystick && joystickActive) { // If joystick was active but no touches are left on it
              resetJoystick();
         }
     }
}

function resetJoystick(){
     joystickActive = false;
     touchIdentifier = null;
     joystickThumb.style.transform = `translate(0px, 0px)`; // Reset thumb visual
     // Reset movement input flags
     inputState.up = false;
     inputState.down = false;
     inputState.left = false;
     inputState.right = false;
     // Aiming direction could reset to center of screen or keep last direction
     // For now, it will revert to the mouseScreenX/Y logic in sendInput if !joystickActive
     // which points towards the center of the canvas relative to player.
}

function updateJoystickThumb() {
    let dx = joystickCurrentX - joystickCenterX;
    let dy = joystickCurrentY - joystickCenterY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Apply deadzone
    if (distance < JOYSTICK_DEADZONE) {
        joystickThumb.style.transform = `translate(0px, 0px)`;
        return;
    }

    let clampedX = dx;
    let clampedY = dy;

    // Clamp thumb position within the joystick area
    if (distance > MAX_JOYSTICK_DIST) {
        const scale = MAX_JOYSTICK_DIST / distance;
        clampedX = dx * scale;
        clampedY = dy * scale;
    }

    joystickThumb.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
}

function updateInputFromJoystick() {
    let dx = joystickCurrentX - joystickCenterX;
    let dy = joystickCurrentY - joystickCenterY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const threshold = JOYSTICK_DEADZONE; // Use deadzone as minimum threshold

    if (distance < threshold) {
        // Reset movement if within deadzone
        inputState.up = false;
        inputState.down = false;
        inputState.left = false;
        inputState.right = false;
    } else {
        // Calculate angle and update directional flags based on angle and normalized distance
        const angle = Math.atan2(dy, dx);
        // Use a simple threshold for direction flags for crisp movement
        // Or use the cosine projection method for potentially smoother transitions (as suggested)
        const angleThreshold = Math.PI / 8; // 22.5 degrees for each direction segment

        inputState.right = angle > -angleThreshold && angle <= angleThreshold;
        inputState.down = angle > angleThreshold && angle <= Math.PI - angleThreshold;
        inputState.left = angle > Math.PI - angleThreshold || angle <= -Math.PI + angleThreshold;
        inputState.up = angle > -Math.PI + angleThreshold && angle <= -angleThreshold;

        // Alternative (more 'analog' feel if server supported it):
        // inputState.moveMagnitude = Math.min(distance / MAX_JOYSTICK_DIST, 1);
        // inputState.moveAngle = angle;

    }

     // Update aiming direction based on joystick offset from center
     // Scale the offset to determine a point in world coordinates
     const aimSensitivity = 5; // How far the aim point moves with joystick
     const worldAimX = camera.x + (joystickCurrentX - joystickCenterX) * aimSensitivity;
     const worldAimY = camera.y + (joystickCurrentY - joystickCenterY) * aimSensitivity;

     inputState.mouseX = worldAimX;
     inputState.mouseY = worldAimY;

     // If joystick is NOT active, mouseX/mouseY will be calculated based on actual mouse position in sendInput
}


function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId) return;

    const selfPlayer = gameState.players.find(p => p.id === selfId);
    if (!selfPlayer || selfPlayer.isDead || selfPlayer.canChooseLevel2) {
         // If player is dead or choosing class, send zero input
         ws.send(JSON.stringify({ type: 'input', input: { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 } }));
         // Ensure attack flag is reset even if we can't send a full input
         inputState.attack = false;
         return;
    }

    // If not using touch joystick, calculate mouse world coordinates
    if (!joystickActive) {
         const canvasRect = canvas.getBoundingClientRect();
         const canvasCenterX = canvasRect.left + canvas.width / 2;
         const canvasCenterY = canvasRect.top + canvas.height / 2;

         // Convert screen mouse position to world coordinates relative to the player/camera
         inputState.mouseX = camera.x + (mouseScreenX - (canvasRect.left + canvas.width / 2));
         inputState.mouseY = camera.y + (mouseScreenY - (canvasRect.top + canvas.height / 2));
    }
     // else: mouseX/mouseY are already updated by updateInputFromJoystick

    ws.send(JSON.stringify({ type: 'input', input: inputState }));

    // Reset attack state after sending if it's a per-click trigger
    // This makes mouse clicks and touch taps trigger one attack.
    inputState.attack = false;
}

// --- Level 2 Specialization Screen ---
function showLevel2Selection() {
    const player = gameState.players.find(p => p.id === selfId);
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
                { id: 'higher', name: 'Higher Vampire', desc: '+Speed, +Atk Speed' }
            ];
            break;
        case 'goblin':
            choices = [
                { id: 'king', name: 'Goblin King', desc: '++HP' }, // Desc simplified to fit button
                { id: 'hobgoblin', name: 'Hobgoblin', desc: '+HP, High Melee, -Speed' }
            ];
            break;
         default:
              // Should not happen if race selection is limited
              choices = [{ id: 'default', name: 'Default', desc: 'No specialization' }];
              break;
    }

    choices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = `${choice.name} (${choice.desc})`;
        button.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'selectClass', choice: choice.id }));
                 // Disable buttons immediately to prevent double clicking
                 level2OptionsDiv.querySelectorAll('button').forEach(btn => btn.disabled = true);
                 button.textContent = "Selecting..."; // Give feedback
            }
        };
        level2OptionsDiv.appendChild(button);
    });

    level2SelectionScreen.style.display = 'block';
}


// --- Rendering ---
let animationFrameId = null;

function gameLoop(timestamp) {
    // Request next frame first
    animationFrameId = requestAnimationFrame(gameLoop);

    if (!selfId || !ws || ws.readyState !== WebSocket.OPEN) {
        // Stop rendering if not connected or initialized
        // console.log("Game loop halted - not connected or initialized.");
        cancelAnimationFrame(animationFrameId);
        return;
    }

    const selfPlayer = gameState.players.find(p => p.id === selfId);

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update camera to follow player with interpolation
    if (selfPlayer && !selfPlayer.isDead && !selfPlayer.canChooseLevel2) {
         // Only move camera if player is alive and not choosing class
         camera.x += (selfPlayer.x - camera.x) * CAMERA_LERP_FACTOR;
         camera.y += (selfPlayer.y - camera.y) * CAMERA_LERP_FACTOR;
    } else if (!selfPlayer) {
         // If self player hasn't loaded yet, camera stays put or goes to map center
          camera.x = camera.x || mapWidth / 2;
          camera.y = camera.y || mapHeight / 2;
    }
     // If player is dead or choosing class, camera stays on their last known position


    // Translate canvas to camera position (centering camera on viewport)
    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);


    // --- Determine Visible Area for Culling ---
    // Add some margin around the viewport
    const viewMargin = 100;
    const viewBounds = {
        left: camera.x - canvas.width / 2 - viewMargin,
        right: camera.x + canvas.width / 2 + viewMargin,
        top: camera.y - canvas.height / 2 - viewMargin,
        bottom: camera.y + canvas.height / 2 + viewMargin
    };

    // Filter elements visible within the determined bounds
    const visibleOrbs = gameState.orbs.filter(orb =>
        orb.x > viewBounds.left && orb.x < viewBounds.right &&
        orb.y > viewBounds.top && orb.y < viewBounds.bottom
    );

    const visiblePlayers = gameState.players.filter(player =>
        player.x + player.radius > viewBounds.left && player.x - player.radius < viewBounds.right &&
        player.y + player.radius > viewBounds.top && player.y - player.radius < viewBounds.bottom
    );

     const visibleProjectiles = gameState.projectiles.filter(proj =>
        proj.x + proj.radius > viewBounds.left && proj.x - proj.radius < viewBounds.right &&
        proj.y + proj.radius > viewBounds.top && proj.y - proj.radius < viewBounds.bottom
     );

    // Draw game elements (world relative)
    drawMapBackground(); // Map background doesn't need culling usually
    drawOrbs(visibleOrbs);
    drawProjectiles(visibleProjectiles);
    drawPlayers(visiblePlayers); // Draw players after orbs/projectiles
    drawVisualEffects(); // Draw temporary effects (melee swings etc.)

    // Restore context for UI elements (screen relative)
    ctx.restore();

    // Draw UI elements (screen relative)
    if (selfPlayer) {
        drawUI(selfPlayer);
    }

    // Draw Leaderboard (screen relative)
    drawLeaderboard();
}

function drawMapBackground() {
    // Simple boundary box
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);

    // Optional: Simple grid (draw only visible portion for performance)
    const gridSize = 100;
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;

    // Calculate visible grid lines
    const startGridX = Math.max(0, Math.floor((camera.x - canvas.width / 2) / gridSize) * gridSize);
    const endGridX = Math.min(mapWidth, Math.ceil((camera.x + canvas.width / 2) / gridSize) * gridSize + gridSize);
    const startGridY = Math.max(0, Math.floor((camera.y - canvas.height / 2) / gridSize) * gridSize);
    const endGridY = Math.min(mapHeight, Math.ceil((camera.y + canvas.height / 2) / gridSize) * gridSize + gridSize);

    for (let x = startGridX; x <= endGridX; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, Math.max(0, startGridY)); // Limit line to map bounds
        ctx.lineTo(x, Math.min(mapHeight, endGridY));
        ctx.stroke();
    }
    for (let y = startGridY; y <= endGridY; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, startGridX), y); // Limit line to map bounds
        ctx.lineTo(Math.min(mapWidth, endGridX), y);
        ctx.stroke();
    }
}


function drawOrbs(orbs) {
    ctx.fillStyle = '#f0e370'; // Orb color
    orbs.forEach(orb => {
         ctx.beginPath();
         ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
         ctx.fill();
    });
}

function drawProjectiles(projectiles) {
    projectiles.forEach(proj => {
        // Draw projectile
        ctx.fillStyle = proj.color || '#ffffff';
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
        ctx.fill();

        // Add a simple trail effect
        // Calculate previous position based on velocity
        const prevX = proj.x - proj.dx * 1.5; // Scale factor determines tail length
        const prevY = proj.y - proj.dy * 1.5;

        ctx.strokeStyle = proj.color || '#ffffff';
        ctx.lineWidth = proj.radius * 1.5; // Tail thickness
        ctx.lineCap = 'round'; // Round ends for the tail
        ctx.globalAlpha = 0.6; // Transparency for the trail

        ctx.beginPath();
        ctx.moveTo(proj.x, proj.y);
        ctx.lineTo(prevX, prevY);
        ctx.stroke();

        ctx.globalAlpha = 1.0; // Reset alpha
        ctx.lineWidth = 1; // Reset line width
        ctx.lineCap = 'butt'; // Reset line cap
    });
}


// Store damage visual state client-side
const damageVisuals = new Map(); // Map<playerId, timestamp>

function showDamageVisual(playerId) {
     damageVisuals.set(playerId, Date.now());
}

function drawPlayers(players) {
    players.forEach(player => {
        // Draw Player Circle
        ctx.fillStyle = player.color || '#cccccc';
        ctx.strokeStyle = '#000000'; // Black outline
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

         // Draw Player is Dead indicator
         if (player.isDead) {
             ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'; // Semi-transparent red
             ctx.beginPath();
             ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
             ctx.fill();

             ctx.fillStyle = '#ffffff';
             ctx.textAlign = 'center';
             ctx.font = 'bold 16px sans-serif';
             ctx.fillText("DEAD", player.x, player.y + 5);

         } else if (player.canChooseLevel2) {
             // Draw Level Up Ready indicator
             ctx.fillStyle = 'rgba(255, 230, 0, 0.5)'; // Semi-transparent yellow
              ctx.beginPath();
              ctx.arc(player.x, player.y, player.radius * 1.2, 0, Math.PI * 2);
              ctx.fill();

             ctx.fillStyle = '#333';
             ctx.textAlign = 'center';
             ctx.font = 'bold 10px sans-serif';
             ctx.fillText("LEVEL UP", player.x, player.y + 4);

         } else {
             // Draw Name & Level
             ctx.fillStyle = '#ffffff';
             ctx.textAlign = 'center';
             ctx.font = 'bold 12px sans-serif';
             ctx.fillText(`${player.name} [${player.level}]`, player.x, player.y - player.radius - 15);

             // Draw HP Bar
             const hpBarWidth = player.radius * 2;
             const hpBarHeight = 5;
             const hpBarX = player.x - hpBarWidth / 2;
             const hpBarY = player.y - player.radius - 10;
             const hpPercent = player.hp / player.maxHp;

             ctx.fillStyle = '#555'; // Background of HP bar
             ctx.fillRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
             ctx.fillStyle = hpPercent > 0.5 ? '#4CAF50' : (hpPercent > 0.2 ? '#ff9800' : '#f44336'); // Green/Yellow/Red
             ctx.fillRect(hpBarX, hpBarY, hpBarWidth * hpPercent, hpBarHeight);
             ctx.strokeStyle = '#333';
             ctx.lineWidth = 1;
             ctx.strokeRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);

              // Draw visual indicator for recent damage
              const damageTime = damageVisuals.get(player.id);
              if (damageTime && Date.now() - damageTime < 300) { // Show effect for 300ms
                  ctx.strokeStyle = 'rgba(255, 0, 0, ' + (1 - (Date.now() - damageTime) / 300) + ')'; // Fade out
                  ctx.lineWidth = 4;
                  ctx.beginPath();
                  ctx.arc(player.x, player.y, player.radius * 1.1, 0, Math.PI * 2); // Slightly larger ring
                  ctx.stroke();
              } else if (damageTime) {
                   damageVisuals.delete(player.id); // Remove effect when it fades
              }
         }
    });
}

// Client-side function to add melee visual effect
function showMeleeAttackVisual(playerId, angle, reach) {
     const player = gameState.players.find(p => p.id === playerId);
     if (!player) return;

     gameVisualEffects.push({
         type: 'meleeAttack',
         playerId: playerId, // Store player ID to link effect
         x: player.x,
         y: player.y,
         angle: angle,
         reach: reach,
         created: Date.now(),
         duration: 150 // ms, make it short and quick
     });
}


function drawVisualEffects() {
    // Filter out expired effects
    gameVisualEffects = gameVisualEffects.filter(effect =>
        Date.now() - effect.created < effect.duration
    );

    // Draw active effects
    gameVisualEffects.forEach(effect => {
        if (effect.type === 'meleeAttack') {
             const player = gameState.players.find(p => p.id === effect.playerId);
             if (!player) return; // Don't draw if player doesn't exist

             // Recalculate effect position based on current player position for smoother follow
             const effectX = player.x;
             const effectY = player.y;

            // Draw attack arc/cone
            const fadeAlpha = 1 - (Date.now() - effect.created) / effect.duration;
            ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.3 * fadeAlpha) + ')'; // Fade out effect
            ctx.beginPath();
            ctx.moveTo(effectX, effectY);
             // Start angle is effect.angle minus half the cone width
             const coneWidth = Math.PI / 3; // Should match server's cone
            ctx.arc(effectX, effectY, effect.reach,
                   effect.angle - coneWidth / 2, effect.angle + coneWidth / 2);
            ctx.closePath();
            ctx.fill();
        }
        // Add other effect types here later (e.g., explosions, buffs)
    });
}


function drawUI(selfPlayer) {
    // Draw XP Bar (Bottom Center)
    const xpBarWidth = canvas.width * 0.4;
    const xpBarHeight = 15;
    const xpBarX = (canvas.width - xpBarWidth) / 2;
    const xpBarY = canvas.height - xpBarHeight - 15; // 15px from bottom

    let xpForNextLevel = XP_TO_LEVEL_2; // XP needed for level 2
    let xpCurrentLevelBase = 0; // XP needed for current level start

    // If we had more levels, we would update xpForNextLevel and xpCurrentLevelBase here

    const xpProgress = selfPlayer.xp - xpCurrentLevelBase;
    const xpNeeded = xpForNextLevel - xpCurrentLevelBase;
    const xpPercent = Math.min(1, xpNeeded > 0 ? xpProgress / xpNeeded : 1);

    ctx.fillStyle = '#555'; // Background
    ctx.fillRect(xpBarX, xpBarY, xpBarWidth, xpBarHeight);
    ctx.fillStyle = '#f0e370'; // XP Color (Yellow)
    ctx.fillRect(xpBarX, xpBarY, xpBarWidth * xpPercent, xpBarHeight);

    // XP Text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = '12px sans-serif';
    const xpText = xpNeeded > 0 ? `${Math.floor(xpProgress)} / ${xpNeeded} XP` : `Level ${selfPlayer.level} (MAX)`;
    ctx.fillText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5 + 2); // Adjust text vertical position
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.5;
    ctx.strokeText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5 + 2);


     // Draw Level (above XP bar)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'center';
     ctx.font = 'bold 16px sans-serif';
     ctx.fillText(`Level: ${selfPlayer.level}`, canvas.width / 2, xpBarY - 8);

     // Optional: Display current Class/Mutation name?
      if (selfPlayer.classOrMutation) {
          ctx.font = 'italic 12px sans-serif';
          ctx.fillStyle = '#ccc';
          ctx.fillText(`[${selfPlayer.classOrMutation.toUpperCase()}]`, canvas.width / 2, xpBarY - 25);
      }

}

function drawLeaderboard() {
     // Sort players by kill count for a simple leaderboard
     const sortedPlayers = [...gameState.players]
         .filter(p => !p.isDead) // Only show living players
         .sort((a, b) => b.killCount - a.killCount || b.xp - a.xp); // Sort by kills, then XP

     const leaderboardX = canvas.width - 10; // 10px from right edge
     let leaderboardY = 25; // Starting Y position

     ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; // Semi-transparent background for text
     ctx.textAlign = 'right';
     ctx.font = '14px sans-serif';

     ctx.fillText("Leaderboard", leaderboardX, leaderboardY);
     leaderboardY += 20; // Space after title

     const maxEntries = 10; // Show top 10 players
     for (let i = 0; i < Math.min(sortedPlayers.length, maxEntries); i++) {
         const player = sortedPlayers[i];
         // Highlight self player in leaderboard
         ctx.fillStyle = player.id === selfId ? '#f0e370' : '#ffffff'; // Yellow for self, white for others
         ctx.font = player.id === selfId ? 'bold 14px sans-serif' : '14px sans-serif';

         const entryText = `${i + 1}. ${player.name} (${player.killCount} Kills)`; // Or show level/xp
         ctx.fillText(entryText, leaderboardX, leaderboardY);
         leaderboardY += 18; // Space between entries
     }
      // If self player is not in top N, show their stats too
      const selfPlayer = gameState.players.find(p => p.id === selfId);
      const selfRank = sortedPlayers.findIndex(p => p.id === selfId);
      if (selfPlayer && selfRank === -1) { // If self is alive but not in top N
           leaderboardY += 10; // Add space
           ctx.fillStyle = '#f0e370';
           ctx.textAlign = 'right';
           ctx.font = 'bold 14px sans-serif';
           const selfEntryText = `${sortedPlayers.length + 1}. ${selfPlayer.name} (${selfPlayer.killCount} Kills)`;
           ctx.fillText(selfEntryText, leaderboardX, leaderboardY);
      }


}


// --- Start the application ---
init();
