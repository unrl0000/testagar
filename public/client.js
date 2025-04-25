// public/client.js
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d'); // Use '2d' context

// --- DOM Elements ---
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

// --- Network State ---
let ws;
let selfId = null;
let serverTimeOffset = 0; // Not implemented robustly yet
let latency = 0;

// --- Game State ---
// Use Maps for efficient lookup/update/removal of players
let players = new Map(); // { data: serverData, interpBuffer: [], renderX, renderY }
let orbs = new Map();    // Store orbs by ID for potential easier removal/update
let projectiles = new Map(); // Store projectiles by ID

let mapWidth = 2000;
let mapHeight = 2000;
let lastServerTimestamp = 0;

// --- Self Player State (Client-Side Prediction) ---
let predictedState = { x: 0, y: 0, isDead: true, radius: 15 }; // Start as dead until welcome
let inputHistory = [];
let inputSequenceNumber = 0;

// --- Input State ---
let inputState = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
let mouseScreenX = window.innerWidth / 2;
let mouseScreenY = window.innerHeight / 2;

// --- Camera State ---
let camera = { x: 0, y: 0, targetX: 0, targetY: 0, speed: 0.15 }; // Slightly faster camera

// --- Touch Control State ---
let touchIdentifier = null;
let joystickActive = false;
let joystickStartX = 0, joystickStartY = 0, joystickCurrentX = 0, joystickCurrentY = 0;
let aimFromJoystick = { x: 0, y: 0 };
let isTouchDevice = false;
const JOYSTICK_BASE_RADIUS = 60;
const THUMB_BASE_RADIUS = 30;
let joystickRadius = JOYSTICK_BASE_RADIUS;
let thumbRadius = THUMB_BASE_RADIUS;
let maxJoystickDist = joystickRadius - thumbRadius;
const JOYSTICK_DEAD_ZONE = 0.15;

// --- Constants ---
const INTERPOLATION_DELAY = 100; // ms - Render others slightly in the past
let PLAYER_BASE_SPEED = 2.5; // Default, updated from server constants
let BASE_TICK_RATE = 60;     // Default, updated from server constants

// --- Game Loop Control ---
let lastFrameTime = performance.now();
let gameLoopId = null; // Stores the requestAnimationFrame ID
let inputIntervalId = null; // Stores the setInterval ID for input sending

// =============================================================================
// INITIALIZATION & SETUP
// =============================================================================

function init() {
    console.log("Client Initializing...");
    isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    console.log("Touch Device:", isTouchDevice);

    setupStartScreen();
    setupInputListeners(); // Keyboard + Mouse
    resizeCanvas(); // Initial size
    window.addEventListener('resize', resizeCanvas);

    if (isTouchDevice) {
        touchControls.style.display = 'block'; // Show touch controls if detected
        setupTouchControls();
    } else {
        touchControls.style.display = 'none'; // Hide if not touch
    }
    console.log("Initialization sequence complete.");
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Responsive joystick size adjustments
    const scaleFactor = Math.min(1, Math.max(0.7, window.innerWidth / 800)); // Scale between 70% and 100%
    joystickRadius = JOYSTICK_BASE_RADIUS * scaleFactor;
    thumbRadius = THUMB_BASE_RADIUS * scaleFactor;
    maxJoystickDist = joystickRadius - thumbRadius;

    joystickArea.style.width = `${joystickRadius * 2}px`;
    joystickArea.style.height = `${joystickRadius * 2}px`;
    joystickThumb.style.width = `${thumbRadius * 2}px`;
    joystickThumb.style.height = `${thumbRadius * 2}px`;
    joystickThumb.style.top = `${joystickRadius - thumbRadius}px`; // Center thumb
    joystickThumb.style.left = `${joystickRadius - thumbRadius}px`;

    console.log("Canvas Resized:", canvas.width, canvas.height);
}

function setupStartScreen() {
    raceButtons.forEach(button => {
        button.addEventListener('click', () => {
            raceButtons.forEach(btn => btn.classList.remove('selected'));
            button.classList.add('selected');
        });
    });
    startButton.addEventListener('click', joinGame);
    nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinGame(); });
}

function joinGame() {
    const name = nameInput.value.trim();
    const selectedRace = raceSelection.querySelector('button.selected')?.getAttribute('data-race');

    if (!name) { showError("Please enter a name."); return; }
    if (!selectedRace) { showError("Please select a race."); return; }

    console.log(`Attempting to join as ${name} (${selectedRace})`);
    startScreen.style.display = 'none';
    canvas.style.display = 'block'; // Show canvas
    errorMessage.textContent = '';
    if (isTouchDevice) touchControls.style.display = 'block';

    // Stop existing game loop and intervals before connecting
    stopGameLoop();
    stopInputInterval();

    connectWebSocket(name, selectedRace);
}

function showError(message) {
    console.error("UI Error:", message);
    errorMessage.textContent = message;
    // Optional: Show start screen on error
    // startScreen.style.display = 'block';
    // canvas.style.display = 'none';
    // touchControls.style.display = 'none';
}

// =============================================================================
// WEBSOCKET COMMUNICATION
// =============================================================================

function connectWebSocket(name, race) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.warn("Closing existing WebSocket connection.");
        ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}`;
    console.log(`Connecting to: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket Connected.');
        // Reset game state variables for new connection
        selfId = null;
        players.clear();
        orbs.clear();
        projectiles.clear();
        inputHistory = [];
        inputSequenceNumber = 0;
        predictedState = { x: 0, y: 0, isDead: true, radius: 15 }; // Reset prediction
        camera.x = 0; camera.y = 0; // Reset camera

        // Send join message
        ws.send(JSON.stringify({ type: 'join', name: name, race: race }));
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'welcome': handleWelcome(message); break;
                case 'gameState': handleGameState(message); break;
                case 'levelUpReady': showLevel2Selection(); break;
                case 'classSelected':
                    console.log("Server confirmed class selection.");
                    level2SelectionScreen.style.display = 'none'; // Hide screen
                    // Player data update comes via next gameState
                    break;
                case 'pong': /* Latency calculation */ break;
                default: console.warn("Unknown message type:", message.type);
            }
        } catch (error) {
            console.error('Error processing message:', event.data, error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        showError('Connection error. Please refresh.');
        stopGameLoop();
        stopInputInterval();
    };

    ws.onclose = (event) => {
        console.log(`WebSocket Closed: Code=${event.code}, Reason=${event.reason}`);
        showError('Disconnected. Please refresh.');
        stopGameLoop();
        stopInputInterval();
        selfId = null; // Mark as disconnected
        // Show start screen
        startScreen.style.display = 'block';
        canvas.style.display = 'none';
        touchControls.style.display = 'none';
        level2SelectionScreen.style.display = 'none';
    };
}

function handleWelcome(message) {
    if (selfId) {
         console.warn("Received welcome message again? Ignoring.");
         return;
    }
    selfId = message.playerId;
    mapWidth = message.mapWidth;
    mapHeight = message.mapHeight;

    // Update constants if provided by server
    if(message.constants) {
        PLAYER_BASE_SPEED = message.constants.PLAYER_BASE_SPEED || PLAYER_BASE_SPEED;
        BASE_TICK_RATE = message.constants.BASE_TICK_RATE || BASE_TICK_RATE;
         console.log(`Updated constants: Speed=${PLAYER_BASE_SPEED}, TickRate=${BASE_TICK_RATE}`);
    }

    console.log(`Welcome! Player ID: ${selfId}, Map: ${mapWidth}x${mapHeight}`);

    // Process initial state IMMEDIATELY
    if (message.initialState) {
        processServerState(message.initialState, Date.now()); // Use current time approx
    } else {
        console.warn("No initial state received in welcome message!");
    }

    // --- CRITICAL: Initialize Predicted State & Camera ---
    const selfInitialData = players.get(selfId)?.data;
    if (selfInitialData) {
        predictedState.x = selfInitialData.x;
        predictedState.y = selfInitialData.y;
        predictedState.isDead = selfInitialData.isDead;
        predictedState.radius = selfInitialData.radius;
        // Set camera instantly to player start position
        camera.x = predictedState.x;
        camera.y = predictedState.y;
        camera.targetX = predictedState.x;
        camera.targetY = predictedState.y;
        console.log(`Initial state processed. Self at: ${predictedState.x.toFixed(1)}, ${predictedState.y.toFixed(1)} Dead: ${predictedState.isDead}`);
    } else {
        console.error("!!! Self player data not found in initial state after welcome!");
        // Fallback - place in center, likely still invisible if server doesn't send update soon
        predictedState.x = mapWidth / 2;
        predictedState.y = mapHeight / 2;
        camera.x = predictedState.x; camera.y = predictedState.y;
        camera.targetX = predictedState.x; camera.targetY = predictedState.y;
    }

    // Start game loop and input sending ONLY after welcome and initial state processing
    startGameLoop();
    startInputInterval();
}

function handleGameState(message) {
    if (!selfId) return; // Ignore state updates before welcome
    const serverTime = message.timestamp || Date.now();
    lastServerTimestamp = serverTime;
    processServerState(message, serverTime);
}

function processServerState(state, serverTime) {
    // --- Update Orbs (using Map) ---
    const currentOrbIds = new Set();
    (state.orbs || []).forEach(orbData => {
        currentOrbIds.add(orbData.id);
        orbs.set(orbData.id, orbData); // Add or update orb data
    });
    // Remove orbs no longer present
    for (const orbId of orbs.keys()) {
        if (!currentOrbIds.has(orbId)) {
            orbs.delete(orbId);
        }
    }

    // --- Update Projectiles (using Map) ---
    const currentProjIds = new Set();
     (state.projectiles || []).forEach(projData => {
         currentProjIds.add(projData.id);
         // Simple replacement - could interpolate projectiles too for smoothness
         projectiles.set(projData.id, projData);
     });
     // Remove projectiles no longer present
     for (const projId of projectiles.keys()) {
         if (!currentProjIds.has(projId)) {
             projectiles.delete(projId);
         }
     }

    // --- Update Players ---
    const receivedPlayerIds = new Set();
    (state.players || []).forEach(playerData => {
        receivedPlayerIds.add(playerData.id);

        if (playerData.id === selfId) {
            handleSelfPlayerState(playerData);
        } else {
            handleOtherPlayerState(playerData, serverTime);
        }
    });

    // Remove players (except self) that are no longer in the state message
    for (const id of players.keys()) {
        if (id !== selfId && !receivedPlayerIds.has(id)) {
            // console.log(`Removing player ${id} (not in state)`); // DEBUG
            players.delete(id);
        }
    }
}

// --- State Handling for Self and Others ---

function handleSelfPlayerState(serverPlayerData) {
    if (!players.has(selfId)) {
        // Initialize player state storage if it doesn't exist yet
        players.set(selfId, { data: {}, interpBuffer: [], renderX: 0, renderY: 0 });
    }
    const playerState = players.get(selfId);
    playerState.data = serverPlayerData; // Store the latest authoritative data

    // --- Client-Side Prediction Reconciliation ---
    predictedState.isDead = serverPlayerData.isDead; // Server dictates life/death

    // Remove acknowledged inputs from history
    const lastProcessedSeq = serverPlayerData.lastProcessedInputSeq || 0;
    inputHistory = inputHistory.filter(hist => hist.seq > lastProcessedSeq);

    // Server's authoritative position
    const serverX = serverPlayerData.x;
    const serverY = serverPlayerData.y;

    // Calculate prediction error
    const errorX = serverX - predictedState.x;
    const errorY = serverY - predictedState.y;
    const errorDist = Math.sqrt(errorX * errorX + errorY * errorY);

    // Correction Threshold - Allow prediction error up to roughly 1 tick's movement
    // Use latest known speed for threshold calculation
    const currentSpeed = getPlayerCurrentSpeed(serverPlayerData); // Get speed from server data
    const correctionThreshold = (currentSpeed * (1000 / BASE_TICK_RATE)) * 1.5; // Allow 1.5 ticks of drift

    if (errorDist > correctionThreshold) {
        // Large error: Snap predicted state directly to server state
        // console.warn(`Prediction error large (${errorDist.toFixed(1)} > ${correctionThreshold.toFixed(1)}). Snapping.`);
        predictedState.x = serverX;
        predictedState.y = serverY;
        // Clear history on large snap? Maybe not, replay should still fix it.
        // inputHistory = [];
    } else if (errorDist > 0.1) {
         // Minor error: Gently nudge predicted state towards server state
         // This helps correct small drifts without visible snapping
         predictedState.x = lerp(predictedState.x, serverX, 0.2); // Adjust interpolation factor (0.2 = 20% correction)
         predictedState.y = lerp(predictedState.y, serverY, 0.2);
    }
    // Else: Error is negligible, prediction is likely accurate.

    // Re-apply unacknowledged inputs onto the corrected predicted state
    let replayX = predictedState.x;
    let replayY = predictedState.y;
    const speedPerTick = currentSpeed * (1000 / BASE_TICK_RATE);
    const radius = serverPlayerData.radius || 15;

    inputHistory.forEach(hist => {
        let moveX = 0, moveY = 0;
        if (hist.input.up) moveY -= 1; if (hist.input.down) moveY += 1;
        if (hist.input.left) moveX -= 1; if (hist.input.right) moveX += 1;
        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
        if (magnitude > 0) {
             // Apply movement scaled by approximated tick duration (GAME_LOOP_RATE is client fps, use BASE_TICK_RATE based)
            const moveAmount = speedPerTick * (1 / BASE_TICK_RATE);
            replayX += (moveX / magnitude) * moveAmount;
            replayY += (moveY / magnitude) * moveAmount;
             // Clamp during replay
             replayX = Math.max(radius, Math.min(mapWidth - radius, replayX));
             replayY = Math.max(radius, Math.min(mapHeight - radius, replayY));
        }
    });

    // Update the final predicted state after replay
    predictedState.x = replayX;
    predictedState.y = replayY;
    predictedState.radius = radius; // Keep radius updated
}

function handleOtherPlayerState(playerData, serverTime) {
    const renderTime = Date.now() - INTERPOLATION_DELAY; // Target time

    if (!players.has(playerData.id)) {
        // New player seen
        players.set(playerData.id, {
            data: playerData, // Store initial data
            interpBuffer: [{ timestamp: serverTime, x: playerData.x, y: playerData.y }],
            renderX: playerData.x, // Start rendering here
            renderY: playerData.y
        });
    } else {
        // Existing player
        const playerState = players.get(playerData.id);
        playerState.data = playerData; // Update latest server data

        // Add to interpolation buffer only if position changed significantly? No, always add for time.
        const buffer = playerState.interpBuffer;
        // Prevent buffer bloat if server sends updates very rapidly with no movement
        if (buffer.length === 0 || buffer[buffer.length - 1].timestamp < serverTime) {
             buffer.push({ timestamp: serverTime, x: playerData.x, y: playerData.y });
        }


        // Remove old states (older than needed for interpolation)
        // Keep at least 2 entries for interpolation
        while (buffer.length > 2 && buffer[1].timestamp < renderTime - 500) { // Keep ~500ms buffer margin
            buffer.shift();
        }
    }
}

// --- Input Sending ---

function startInputInterval() {
    if (inputIntervalId) clearInterval(inputIntervalId); // Clear previous interval if any
    inputIntervalId = setInterval(sendInputToServer, 1000 / 30); // Send ~30 times/sec
    console.log("Input sending interval started.");
}

function stopInputInterval() {
    if (inputIntervalId) {
        clearInterval(inputIntervalId);
        inputIntervalId = null;
        console.log("Input sending interval stopped.");
    }
}

function sendInputToServer() {
    // Guard conditions: Must have connection, ID, and player must not be dead
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId || predictedState.isDead) {
        // If dead, ensure movement keys are off
        if (predictedState.isDead) {
             inputState.up = inputState.down = inputState.left = inputState.right = inputState.attack = false;
        }
        return;
    }

    // Calculate Aiming Coordinates (World Space)
    let aimX, aimY;
    if (isTouchDevice && joystickActive) {
        // Aim based on normalized joystick direction
        // Aim slightly ahead in that direction
        aimX = predictedState.x + aimFromJoystick.x * 150; // Scale multiplier for aim "distance"
        aimY = predictedState.y + aimFromJoystick.y * 150;
    } else {
        // Aim based on mouse position relative to camera center
        aimX = camera.x + (mouseScreenX - canvas.width / 2);
        aimY = camera.y + (mouseScreenY - canvas.height / 2);
    }

    inputSequenceNumber++;
    const currentInput = {
        ...inputState, // up, down, left, right, attack
        mouseX: aimX,
        mouseY: aimY,
        seq: inputSequenceNumber
    };

    // Store copy for prediction history
    inputHistory.push({ seq: inputSequenceNumber, input: { ...currentInput } });
    if (inputHistory.length > 120) { // Limit history size (e.g., ~4 seconds at 30Hz)
        inputHistory.shift();
    }

    // Send to server
    ws.send(JSON.stringify({ type: 'input', input: currentInput }));

    // Reset attack state after sending (for click-based attack)
    inputState.attack = false;
}

// =============================================================================
// INPUT HANDLING (Keyboard, Mouse, Touch) - Minimal changes here
// =============================================================================

function setupInputListeners() { /* ... (Keep previous setupInputListeners code) ... */
    // Keyboard
    window.addEventListener('keydown', (e) => {
        if (level2SelectionScreen.style.display !== 'none' || e.repeat) return; // Ignore input during selection or key repeats
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = true; break;
            case 's': case 'arrowdown': inputState.down = true; break;
            case 'a': case 'arrowleft': inputState.left = true; break;
            case 'd': case 'arrowright': inputState.right = true; break;
             case ' ': inputState.attack = true; break; // Spacebar for attack?
        }
    });
    window.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = false; break;
            case 's': case 'arrowdown': inputState.down = false; break;
            case 'a': case 'arrowleft': inputState.left = false; break;
            case 'd': case 'arrowright': inputState.right = false; break;
             case ' ': /* inputState.attack = false; */ break; // Attack is reset after sending
        }
    });

    // Mouse
    canvas.addEventListener('mousemove', (e) => {
        mouseScreenX = e.clientX;
        mouseScreenY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
        if (level2SelectionScreen.style.display !== 'none') return;
        if (e.button === 0) inputState.attack = true; // Left click
        e.preventDefault(); // Prevent text selection etc.
    });
    // Removed mouseup attack reset - handled after sendInput
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Prevent right-click menu
}

function setupTouchControls() { /* ... (Keep previous setupTouchControls code) ... */
    joystickArea.addEventListener('touchstart', handleJoystickStart, { passive: false });
    joystickArea.addEventListener('touchmove', handleJoystickMove, { passive: false });
    joystickArea.addEventListener('touchend', handleJoystickEnd, { passive: false });
    joystickArea.addEventListener('touchcancel', handleJoystickEnd, { passive: false });

    attackButton.addEventListener('touchstart', (e) => {
         e.preventDefault();
         if (level2SelectionScreen.style.display !== 'none') return;
         inputState.attack = true;
     }, { passive: false });
     // Removed touchend attack reset
}

function handleJoystickStart(e) { /* ... (Keep previous handleJoystickStart code) ... */
    e.preventDefault();
    if (level2SelectionScreen.style.display !== 'none' || e.touches.length > 1) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    joystickActive = true;
    touchIdentifier = touch.identifier;
    const rect = joystickArea.getBoundingClientRect();
    joystickStartX = rect.left + joystickRadius;
    joystickStartY = rect.top + joystickRadius;
    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickVisuals();
    updateInputFromJoystick();
}

function handleJoystickMove(e) { /* ... (Keep previous handleJoystickMove code) ... */
    e.preventDefault();
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickVisuals();
    updateInputFromJoystick();
}

function handleJoystickEnd(e) { /* ... (Keep previous handleJoystickEnd code) ... */
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    resetJoystick();
}

function updateJoystickVisuals() { /* ... (Keep previous updateJoystickVisuals code) ... */
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    let thumbX = dx; let thumbY = dy;
    if (distance > maxJoystickDist) {
        const scale = maxJoystickDist / distance;
        thumbX = dx * scale; thumbY = dy * scale;
    }
    joystickThumb.style.transform = `translate(${thumbX}px, ${thumbY}px)`;
}

function updateInputFromJoystick() { /* ... (Keep previous updateInputFromJoystick code, ensuring aimFromJoystick is updated) ... */
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const normalizedDist = Math.min(1, distance / maxJoystickDist);

    if (normalizedDist < JOYSTICK_DEAD_ZONE) {
        inputState.up = inputState.down = inputState.left = inputState.right = false;
        // Keep aimFromJoystick as it was for aiming while stopped
        return;
    }

    const angle = Math.atan2(dy, dx);
    const effectiveDx = Math.cos(angle);
    const effectiveDy = Math.sin(angle);

    // Update aim direction
    aimFromJoystick.x = effectiveDx;
    aimFromJoystick.y = effectiveDy;

    // Update movement state
    const pi = Math.PI;
    inputState.up = angle > -pi * 0.875 && angle < -pi * 0.125;
    inputState.down = angle > pi * 0.125 && angle < pi * 0.875;
    inputState.left = angle > pi * 0.625 || angle < -pi * 0.625;
    inputState.right = angle > -pi * 0.375 && angle < pi * 0.375;
     // Optional diagonal refinement
     // if (Math.abs(effectiveDx) > 0.6 && Math.abs(effectiveDy) > 0.6) { ... }
}

function resetJoystick() { /* ... (Keep previous resetJoystick code) ... */
    joystickActive = false;
    touchIdentifier = null;
    joystickThumb.style.transform = `translate(0px, 0px)`;
    inputState.up = inputState.down = inputState.left = inputState.right = false;
    // Do NOT reset aimFromJoystick here
}

// =============================================================================
// LEVEL 2 SELECTION UI - Minimal changes
// =============================================================================
function showLevel2Selection() { /* ... (Keep previous showLevel2Selection code) ... */
    const player = players.get(selfId)?.data;
    if (!player) return;
    level2OptionsDiv.innerHTML = '';
    let choices = [];
     switch (player.race) { /* ... race logic ... */
         case 'human': case 'elf': case 'gnome': choices = [{ id: 'warrior', name: 'Warrior', desc: '+HP, Melee Dmg' }, { id: 'mage', name: 'Mage', desc: 'Ranged Attack' }]; break;
         case 'vampire': choices = [{ id: 'lord', name: 'Lord Vampire', desc: 'High Lifesteal, +HP' }, { id: 'higher', name: 'Higher Vampire', desc: '+Speed, +Atk Speed' }]; break;
         case 'goblin': choices = [{ id: 'king', name: 'Goblin King', desc: '++HP, Okay Dmg' }, { id: 'hobgoblin', name: 'Hobgoblin', desc: '+HP, High Melee Dmg, -Speed' }]; break;
     }
    choices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = `${choice.name} (${choice.desc})`;
        button.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'selectClass', choice: choice.id }));
                level2SelectionScreen.style.display = 'none'; // Hide optimistically
            }
        };
        level2OptionsDiv.appendChild(button);
    });
    level2SelectionScreen.style.display = 'block';
}

// =============================================================================
// CLIENT-SIDE MOVEMENT PREDICTION - Minimal changes
// =============================================================================
function updateSelfPlayerPrediction(deltaTime) {
    if (!selfId || predictedState.isDead) return; // Don't predict if dead

    const selfData = players.get(selfId)?.data; // Use latest data for speed/radius if available
    const radius = selfData?.radius || predictedState.radius || 15;
    const currentSpeed = selfData ? getPlayerCurrentSpeed(selfData) : PLAYER_BASE_SPEED;
    const speedPerSecond = currentSpeed * BASE_TICK_RATE; // Base speed units per second

    let moveX = 0, moveY = 0;
    if (inputState.up) moveY -= 1; if (inputState.down) moveY += 1;
    if (inputState.left) moveX -= 1; if (inputState.right) moveX += 1;

    const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
    if (magnitude > 0) {
        const dx = (moveX / magnitude) * speedPerSecond * deltaTime;
        const dy = (moveY / magnitude) * speedPerSecond * deltaTime;
        predictedState.x += dx;
        predictedState.y += dy;
        // Clamp predicted position immediately
        predictedState.x = Math.max(radius, Math.min(mapWidth - radius, predictedState.x));
        predictedState.y = Math.max(radius, Math.min(mapHeight - radius, predictedState.y));
    }
}

// Helper to get current speed based on player data (ESTIMATE - Server is authoritative)
function getPlayerCurrentSpeed(playerData) {
    if (!playerData) return PLAYER_BASE_SPEED;
    let baseSpeed = PLAYER_BASE_SPEED;
    // Apply race modifiers (MUST match server logic)
    if (playerData.race === 'elf') baseSpeed *= 1.1;
    if (playerData.race === 'goblin') baseSpeed *= 1.05;
    // Apply class/mutation modifiers (MUST match server logic)
    if (playerData.classOrMutation === 'higher') baseSpeed *= 1.2;
    if (playerData.classOrMutation === 'hobgoblin') baseSpeed *= 0.85;
    return baseSpeed;
}


// =============================================================================
// GAME LOOP & RENDERING (Optimization Focus)
// =============================================================================

function startGameLoop() {
    if (gameLoopId) return; // Already running
    console.log("Starting Game Loop...");
    lastFrameTime = performance.now();
    gameLoopId = requestAnimationFrame(gameLoop);
}

function stopGameLoop() {
    if (gameLoopId) {
        cancelAnimationFrame(gameLoopId);
        gameLoopId = null;
        console.log("Game Loop Stopped.");
    }
}

function gameLoop(currentTime) {
    if (!selfId) { // Ensure we have player ID before running game logic
        gameLoopId = requestAnimationFrame(gameLoop); // Keep requesting frame until ready
        return;
    }

    const deltaTime = Math.min(0.05, (currentTime - lastFrameTime) / 1000.0); // Delta time in seconds, capped
    lastFrameTime = currentTime;

    // --- Updates ---
    updateSelfPlayerPrediction(deltaTime); // Predict own movement
    updateCamera(deltaTime); // Smooth camera update
    updateOtherPlayerInterpolation(currentTime); // Calculate render positions for others

    // --- Rendering ---
    ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas

    // Calculate visible bounds ONCE per frame
    const viewBounds = getCameraViewBounds();

    // --- World Rendering (relative to camera) ---
    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    drawMapBackground(viewBounds); // Pass bounds for culling
    drawOrbs(viewBounds);
    drawProjectiles(viewBounds);
    drawPlayers(viewBounds);

    ctx.restore(); // Remove camera transform

    // --- UI Rendering (fixed on screen) ---
    drawUI(); // Draw HUD elements

     // Optional: Darken if level up screen is visible
     if(level2SelectionScreen.style.display !== 'none') {
         ctx.fillStyle = 'rgba(0,0,0,0.5)';
         ctx.fillRect(0,0,canvas.width, canvas.height);
     }

    // Request next frame
    gameLoopId = requestAnimationFrame(gameLoop);
}

function updateCamera(deltaTime) {
    // Camera smoothly follows the predicted player position
    // Ensure target exists (player might not be in map yet briefly)
    if (predictedState && !isNaN(predictedState.x) && !isNaN(predictedState.y)) {
        camera.targetX = predictedState.x;
        camera.targetY = predictedState.y;
    }

    // Use lerp for smooth camera following - adjust speed (0.15 here) for desired smoothness
    camera.x = lerp(camera.x, camera.targetX, camera.speed);
    camera.y = lerp(camera.y, camera.targetY, camera.speed);

    // Minor optimization: Snap to target if very close to prevent sub-pixel jitter
    if (Math.abs(camera.x - camera.targetX) < 0.1) camera.x = camera.targetX;
    if (Math.abs(camera.y - camera.targetY) < 0.1) camera.y = camera.targetY;
}

function updateOtherPlayerInterpolation(currentTime) {
    const renderTime = currentTime - INTERPOLATION_DELAY;

    players.forEach((playerState, id) => {
        if (id === selfId) return; // Skip self

        const buffer = playerState.interpBuffer;
        if (buffer.length < 2) { // Need at least two points to interpolate
            if (buffer.length === 1) { // Fallback: Use the single point available
                playerState.renderX = buffer[0].x;
                playerState.renderY = buffer[0].y;
            } else if (playerState.data) { // Further fallback: Use latest data if buffer empty
                 playerState.renderX = playerState.data.x;
                 playerState.renderY = playerState.data.y;
            }
            return;
        }

        // Find buffer entries surrounding the target render time
        let state1 = buffer[0];
        let state2 = buffer[1];
        for (let i = 1; i < buffer.length; i++) {
            if (buffer[i].timestamp >= renderTime) {
                state2 = buffer[i];
                state1 = buffer[i - 1];
                break;
            }
             // If renderTime is past the last entry, extrapolate (or clamp)
             if (i === buffer.length - 1) {
                 state1 = buffer[i - 1];
                 state2 = buffer[i]; // Use last two points
             }
        }

        // Calculate interpolation factor (alpha)
        const timeDiff = state2.timestamp - state1.timestamp;
        // Prevent division by zero and clamp alpha between 0 and 1
        const alpha = timeDiff > 0 ? Math.max(0, Math.min(1, (renderTime - state1.timestamp) / timeDiff)) : 1;

        // Interpolate position using lerp
        playerState.renderX = lerp(state1.x, state2.x, alpha);
        playerState.renderY = lerp(state1.y, state2.y, alpha);
    });
}

// --- Drawing Functions (Optimized) ---

const GRID_COLOR = '#444';
const GRID_LINE_WIDTH = 1;
const BOUNDARY_COLOR = '#555';
const BOUNDARY_LINE_WIDTH = 5;
const GRID_SIZE = 100;

function drawMapBackground(viewBounds) {
    // Draw Grid (only visible lines)
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.beginPath(); // Batch all grid lines into one path

    const startX = Math.floor(viewBounds.left / GRID_SIZE) * GRID_SIZE;
    const endX = Math.ceil(viewBounds.right / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(viewBounds.top / GRID_SIZE) * GRID_SIZE;
    const endY = Math.ceil(viewBounds.bottom / GRID_SIZE) * GRID_SIZE;

    for (let x = startX; x <= endX; x += GRID_SIZE) {
        ctx.moveTo(x, viewBounds.top - GRID_LINE_WIDTH); // Extend slightly beyond view for seamless scrolling
        ctx.lineTo(x, viewBounds.bottom + GRID_LINE_WIDTH);
    }
    for (let y = startY; y <= endY; y += GRID_SIZE) {
        ctx.moveTo(viewBounds.left - GRID_LINE_WIDTH, y);
        ctx.lineTo(viewBounds.right + GRID_LINE_WIDTH, y);
    }
    ctx.stroke(); // Draw all lines at once

    // Draw Boundaries (only if visible) - Rendered last to be on top of grid
    ctx.strokeStyle = BOUNDARY_COLOR;
    ctx.lineWidth = BOUNDARY_LINE_WIDTH;
     // Top boundary
     if (viewBounds.top < 0) ctx.strokeRect(0, 0, mapWidth, 1); // Approximate rect for top line
     // Bottom boundary
     if (viewBounds.bottom > mapHeight) ctx.strokeRect(0, mapHeight - 1, mapWidth, 1);
     // Left boundary
     if (viewBounds.left < 0) ctx.strokeRect(0, 0, 1, mapHeight);
     // Right boundary
     if (viewBounds.right > mapWidth) ctx.strokeRect(mapWidth - 1, 0, 1, mapHeight);
}

const ORB_COLOR = '#f0e370';
function drawOrbs(viewBounds) {
    ctx.fillStyle = ORB_COLOR;
    ctx.beginPath(); // Batch all orbs into one path if same color
    let count = 0;
    orbs.forEach(orb => {
        // Culling check
        if (isPointInBounds(orb.x, orb.y, viewBounds, orb.radius)) {
            ctx.moveTo(orb.x + orb.radius, orb.y); // Move to start point for arc
            ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
            count++;
        }
    });
    if (count > 0) ctx.fill(); // Fill all visible orbs at once
}

function drawProjectiles(viewBounds) {
    // Projectiles have different colors, cannot batch easily
    projectiles.forEach(proj => {
        if (isPointInBounds(proj.x, proj.y, viewBounds, proj.radius)) {
            ctx.fillStyle = proj.color || '#ffffff';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

const PLAYER_OUTLINE_COLOR = '#000000';
const PLAYER_OUTLINE_WIDTH = 2;
const NAME_FONT = 'bold 12px sans-serif';
const NAME_COLOR = '#ffffff';
const TEXT_SHADOW_COLOR = 'black';
const TEXT_SHADOW_BLUR = 2;

function drawPlayers(viewBounds) {
    ctx.lineWidth = PLAYER_OUTLINE_WIDTH;
    ctx.strokeStyle = PLAYER_OUTLINE_COLOR;
    ctx.font = NAME_FONT;
    ctx.textAlign = 'center';

    players.forEach((playerState, id) => {
        const data = playerState.data;
        if (!data || data.isDead) return; // Skip dead or missing data

        let drawX, drawY;
        if (id === selfId) {
            if (predictedState.isDead) return; // Don't draw self if predicted dead
            drawX = predictedState.x; drawY = predictedState.y;
        } else {
            drawX = playerState.renderX; drawY = playerState.renderY;
            if (isNaN(drawX) || isNaN(drawY)) { // Fallback if interpolation failed
                 drawX = data.x; drawY = data.y;
            }
        }

        // Culling check (include margin for name/hp bar)
        if (!isPointInBounds(drawX, drawY, viewBounds, data.radius * 4)) return;

        // Draw Player Circle
        ctx.fillStyle = data.color || '#cccccc';
        ctx.beginPath();
        ctx.arc(drawX, drawY, data.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke(); // Stroke after fill

        // Draw Name (with shadow for readability)
        const nameY = drawY - data.radius - 15;
        ctx.fillStyle = NAME_COLOR;
        ctx.shadowColor = TEXT_SHADOW_COLOR;
        ctx.shadowBlur = TEXT_SHADOW_BLUR;
        ctx.fillText(`${data.name} [${data.level}]`, drawX, nameY);
        ctx.shadowBlur = 0; // Reset shadow immediately

        // Draw HP Bar (call helper function)
        drawHpBar(ctx, drawX, nameY + 5, data.radius, data.hp, data.maxHp); // Position below name
    });
}

// Optimized HP Bar drawing function
const HP_BAR_HEIGHT = 6;
const HP_BAR_BG_COLOR = '#555';
const HP_BAR_BORDER_COLOR = '#333';
const HP_BAR_BORDER_WIDTH = 1;
const HP_COLOR_HIGH = '#4CAF50'; // Green
const HP_COLOR_MID = '#ffc107';  // Yellow
const HP_COLOR_LOW = '#f44336';   // Red

function drawHpBar(context, x, y, ownerRadius, hp, maxHp) {
    const hpBarWidth = ownerRadius * 2.5;
    const hpBarX = x - hpBarWidth / 2;
    // Y position is passed directly (e.g., below name)

    // Calculate HP percentage safely
    const hpPercent = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
    const currentHpWidth = hpBarWidth * hpPercent;

    // Draw background
    context.fillStyle = HP_BAR_BG_COLOR;
    context.fillRect(hpBarX, y, hpBarWidth, HP_BAR_HEIGHT);

    // Draw current HP portion
    context.fillStyle = hpPercent > 0.6 ? HP_COLOR_HIGH : (hpPercent > 0.3 ? HP_COLOR_MID : HP_COLOR_LOW);
    if (currentHpWidth > 0) { // Only draw if HP > 0
       context.fillRect(hpBarX, y, currentHpWidth, HP_BAR_HEIGHT);
    }

    // Draw border (optional, but looks better)
    context.strokeStyle = HP_BAR_BORDER_COLOR;
    context.lineWidth = HP_BAR_BORDER_WIDTH;
    context.strokeRect(hpBarX - 0.5, y - 0.5, hpBarWidth + 1, HP_BAR_HEIGHT + 1); // Offset slightly for crisp border
}

const UI_FONT_LARGE = 'bold 16px sans-serif';
const UI_FONT_NORMAL = '12px sans-serif';
const UI_FONT_SMALL = 'bold 12px sans-serif';
const UI_TEXT_COLOR = '#ffffff';
const UI_XP_BAR_HEIGHT = 18;
const UI_XP_COLOR = '#f0e370';
const UI_BAR_BG_COLOR = 'rgba(85, 85, 85, 0.7)';
const UI_HP_CIRCLE_X = 80;
const UI_HP_CIRCLE_Y = canvas.height - 80; // Recalculate if canvas resizes? Yes.
const UI_HP_CIRCLE_RADIUS = 50;
const UI_HP_CIRCLE_WIDTH = 8;

function drawUI() {
    // Get self data ONLY ONCE for UI drawing
    const selfData = players.get(selfId)?.data;
    // If no self data OR player is dead and we don't want a "You Died" screen yet
    if (!selfData || selfData.isDead) {
        // Optionally draw "Respawning..." or "You Died" message
        if(predictedState.isDead && !level2SelectionScreen.style.display) { // Check predicted state as well
            ctx.fillStyle = 'rgba(200, 0, 0, 0.7)';
            ctx.textAlign = 'center';
            ctx.font = 'bold 30px sans-serif';
            ctx.fillText('YOU DIED', canvas.width / 2, canvas.height / 2 - 20);
            ctx.font = 'bold 20px sans-serif';
            ctx.fillText('Respawning...', canvas.width / 2, canvas.height / 2 + 20);
        }
        return; // Don't draw regular UI if dead
    }

    // Common UI styles
    ctx.textAlign = 'center';
    ctx.fillStyle = UI_TEXT_COLOR;
    ctx.shadowColor = TEXT_SHADOW_COLOR;

    // --- XP Bar ---
    // Only draw if needed (not max level/class chosen)
    if (selfData.level === 1 && !selfData.canChooseLevel2) {
        const xpBarWidth = Math.min(400, canvas.width * 0.5);
        const xpBarX = (canvas.width - xpBarWidth) / 2;
        const xpBarY = canvas.height - UI_XP_BAR_HEIGHT - 20; // Position from bottom

        // Calculate XP progress safely
        const xpForNextLevel = XP_TO_LEVEL_2; // Assume level 2 is goal
        const xpCurrentLevelBase = 0;
        const xpProgress = Math.max(0, selfData.xp - xpCurrentLevelBase);
        const xpNeeded = xpForNextLevel - xpCurrentLevelBase;
        const xpPercent = xpNeeded > 0 ? Math.min(1, xpProgress / xpNeeded) : 1;

        // Draw background
        ctx.fillStyle = UI_BAR_BG_COLOR;
        ctx.fillRect(xpBarX, xpBarY, xpBarWidth, UI_XP_BAR_HEIGHT);
        // Draw progress
        ctx.fillStyle = UI_XP_COLOR;
        if (xpPercent > 0) ctx.fillRect(xpBarX, xpBarY, xpBarWidth * xpPercent, UI_XP_BAR_HEIGHT);
        // Draw text
        ctx.fillStyle = UI_TEXT_COLOR;
        ctx.font = UI_FONT_SMALL;
        ctx.shadowBlur = TEXT_SHADOW_BLUR;
        ctx.fillText(`${xpProgress} / ${xpNeeded} XP`, canvas.width / 2, xpBarY + UI_XP_BAR_HEIGHT / 1.5);
        ctx.shadowBlur = 0;
    }

    // --- Level Display ---
    const levelY = canvas.height - (UI_XP_BAR_HEIGHT + 20 + 8); // Position above XP bar
    ctx.font = UI_FONT_LARGE;
    ctx.shadowBlur = TEXT_SHADOW_BLUR;
    ctx.fillText(`Level: ${selfData.level}`, canvas.width / 2, levelY);
    ctx.shadowBlur = 0;

    // --- HP Circle (Bottom Left) ---
    const hpCircleY = canvas.height - 80; // Keep Y constant relative to bottom
    const hpPercent = selfData.maxHp > 0 ? Math.max(0, selfData.hp / selfData.maxHp) : 0;
    const angle = hpPercent * Math.PI * 2;

    ctx.lineWidth = UI_HP_CIRCLE_WIDTH;
    // Background circle
    ctx.strokeStyle = UI_BAR_BG_COLOR; // Use same bg color for consistency
    ctx.beginPath();
    ctx.arc(UI_HP_CIRCLE_X, hpCircleY, UI_HP_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    // HP Fill arc
    if (angle > 0) { // Only draw arc if there's HP
        ctx.strokeStyle = hpPercent > 0.6 ? HP_COLOR_HIGH : (hpPercent > 0.3 ? HP_COLOR_MID : HP_COLOR_LOW);
        ctx.beginPath();
        ctx.arc(UI_HP_CIRCLE_X, hpCircleY, UI_HP_CIRCLE_RADIUS, -Math.PI / 2, -Math.PI / 2 + angle);
        ctx.stroke();
    }
    // HP Text
    ctx.fillStyle = UI_TEXT_COLOR;
    ctx.font = 'bold 18px sans-serif';
    ctx.shadowBlur = TEXT_SHADOW_BLUR;
    ctx.fillText(selfData.hp, UI_HP_CIRCLE_X, hpCircleY + 6); // Adjust text position
    ctx.shadowBlur = 0;


     // --- Kill Count (Top Right) ---
     ctx.textAlign = 'right'; // Align right for top-right corner
     ctx.font = UI_FONT_LARGE;
     ctx.shadowBlur = TEXT_SHADOW_BLUR;
     ctx.fillText(`Kills: ${selfData.killCount || 0}`, canvas.width - 20, 30);
     ctx.shadowBlur = 0;

     // --- Crosshair (Non-touch only) ---
      if (!isTouchDevice) {
          const crosshairSize = 8;
           ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
           ctx.lineWidth = 1;
           ctx.beginPath();
           ctx.moveTo(mouseScreenX - crosshairSize, mouseScreenY); ctx.lineTo(mouseScreenX + crosshairSize, mouseScreenY);
           ctx.moveTo(mouseScreenX, mouseScreenY - crosshairSize); ctx.lineTo(mouseScreenX, mouseScreenY + crosshairSize);
           ctx.stroke();
      }
}


// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function lerp(start, end, amount) {
    return start + (end - start) * amount;
}

// Calculate camera view bounds (cached per frame)
function getCameraViewBounds() {
    const halfWidth = canvas.width / 2;
    const halfHeight = canvas.height / 2;
    // Use camera's current position (already interpolated/smoothed)
    return {
        left: camera.x - halfWidth,
        right: camera.x + halfWidth,
        top: camera.y - halfHeight,
        bottom: camera.y + halfHeight
    };
}

// Optimized culling check
function isPointInBounds(x, y, bounds, margin = 0) {
    return x + margin >= bounds.left &&
           x - margin <= bounds.right &&
           y + margin >= bounds.top &&
           y - margin <= bounds.bottom;
}

// --- Start the application ---
init(); // Start the client initialization process
