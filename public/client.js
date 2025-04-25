// public/client.js
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

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
let players = new Map(); // { data: serverData, interpBuffer: [], renderX, renderY }
let orbs = new Map();
let projectiles = new Map();

let mapWidth = 2000;
let mapHeight = 2000;
let lastServerTimestamp = 0;

// --- Self Player State (Client-Side Prediction) ---
let predictedState = { x: 0, y: 0, isDead: true, radius: 15 }; // Start as dead/uninitialized
let inputHistory = [];
let inputSequenceNumber = 0;

// --- Input State ---
let inputState = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
let mouseScreenX = window.innerWidth / 2;
let mouseScreenY = window.innerHeight / 2;

// --- Camera State ---
let camera = { x: 0, y: 0, targetX: 0, targetY: 0, speed: 0.15 }; // Smooth camera

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
const INTERPOLATION_DELAY = 100; // ms
let PLAYER_BASE_SPEED = 2.5; // Default, updated from server constants
let BASE_TICK_RATE = 60;     // Default, updated from server constants (ticks per second)

// --- Game Loop Control ---
let lastFrameTime = performance.now();
let gameLoopId = null;
let inputIntervalId = null;

// =============================================================================
// INITIALIZATION & SETUP
// =============================================================================

function init() {
    console.log("Client Initializing...");
    isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    console.log("Touch Device:", isTouchDevice);

    setupStartScreen();
    setupInputListeners(); // Keyboard + Mouse
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    if (isTouchDevice) {
        touchControls.style.display = 'block';
        setupTouchControls();
    } else {
        touchControls.style.display = 'none';
    }
    console.log("Initialization sequence complete.");
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.height; // Fixed typo: use window.innerHeight

    const scaleFactor = Math.min(1, Math.max(0.7, window.innerWidth / 800));
    joystickRadius = JOYSTICK_BASE_RADIUS * scaleFactor;
    thumbRadius = THUMB_BASE_RADIUS * scaleFactor;
    maxJoystickDist = joystickRadius - thumbRadius;

    joystickArea.style.width = `${joystickRadius * 2}px`;
    joystickArea.style.height = `${joystickRadius * 2}px`;
    joystickThumb.style.width = `${thumbRadius * 2}px`;
    joystickThumb.style.height = `${thumbRadius * 2}px`;
    joystickThumb.style.top = `${joystickRadius - thumbRadius}px`;
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
    canvas.style.display = 'block';
    errorMessage.textContent = '';
    if (isTouchDevice) touchControls.style.display = 'block';

    stopGameLoop();
    stopInputInterval();

    connectWebSocket(name, selectedRace);
}

function showError(message) {
    console.error("UI Error:", message);
    errorMessage.textContent = message;
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
        // Reset state for new connection
        selfId = null;
        players.clear();
        orbs.clear();
        projectiles.clear();
        inputHistory = [];
        inputSequenceNumber = 0;
        predictedState = { x: 0, y: 0, isDead: true, radius: 15 }; // Reset prediction state
        camera.x = 0; camera.y = 0; camera.targetX = 0; camera.targetY = 0; // Reset camera

        // Send join message
        ws.send(JSON.stringify({ type: 'join', name: name, race: race }));
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
             // DEBUG: Log message types received
            // if (message.type !== 'gameState') console.log('Received message:', message.type);

            switch (message.type) {
                case 'welcome': handleWelcome(message); break;
                case 'gameState': handleGameState(message); break;
                case 'levelUpReady': showLevel2Selection(); break;
                case 'classSelected':
                    console.log("Server confirmed class selection.");
                    level2SelectionScreen.style.display = 'none';
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
        selfId = null;
        players.clear(); // Clear all players on disconnect
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

    // Update constants from server
    if(message.constants) {
        PLAYER_BASE_SPEED = message.constants.PLAYER_BASE_SPEED || PLAYER_BASE_SPEED;
        BASE_TICK_RATE = message.constants.BASE_TICK_RATE || BASE_TICK_RATE;
         console.log(`Updated constants: PlayerBaseSpeed=${PLAYER_BASE_SPEED}, BaseTickRate=${BASE_TICK_RATE}`);
    }

    console.log(`Welcome! Player ID: ${selfId}, Map: ${mapWidth}x${mapHeight}`);

    // Process initial state
    if (message.initialState) {
        processServerState(message.initialState, Date.now());
    } else {
        console.warn("No initial state received in welcome message!");
    }

    // --- CRITICAL: Initialize Predicted State & Camera from the server's initial state ---
    const selfInitialData = players.get(selfId)?.data;
    if (selfInitialData) {
        predictedState.x = selfInitialData.x;
        predictedState.y = selfInitialData.y;
        predictedState.isDead = selfInitialData.isDead;
        predictedState.radius = selfInitialData.radius || 15; // Use player's actual radius
        // Set camera instantly to player start position
        camera.x = predictedState.x;
        camera.y = predictedState.y;
        camera.targetX = predictedState.x;
        camera.targetY = predictedState.y;
        console.log(`Initial state processed. Self at: ${predictedState.x.toFixed(1)}, ${predictedState.y.toFixed(1)}. Dead: ${predictedState.isDead}. Radius: ${predictedState.radius}`);
    } else {
        console.error("!!! Self player data not found in initial state after welcome! Cannot initialize prediction/camera.");
        // Fallback to map center - player likely won't be visible or move correctly initially
        predictedState.x = mapWidth / 2; predictedState.y = mapHeight / 2;
        predictedState.isDead = true; // Assume dead if no data
        camera.x = predictedState.x; camera.y = predictedState.y;
        camera.targetX = predictedState.x; camera.targetY = predictedState.y;
    }

    // Start game loop and input sending ONLY after successful welcome and state init
    startGameLoop();
    startInputInterval();
}

function handleGameState(message) {
    if (!selfId) return;
    const serverTime = message.timestamp || Date.now();
    lastServerTimestamp = serverTime;
    processServerState(message, serverTime);
}

function processServerState(state, serverTime) {
    // Update Orbs
    const currentOrbIds = new Set();
    (state.orbs || []).forEach(orbData => {
        currentOrbIds.add(orbData.id);
        orbs.set(orbData.id, orbData);
    });
    for (const orbId of orbs.keys()) {
        if (!currentOrbIds.has(orbId)) {
            orbs.delete(orbId);
        }
    }

    // Update Projectiles
    const currentProjIds = new Set();
     (state.projectiles || []).forEach(projData => {
         currentProjIds.add(projData.id);
         projectiles.set(projData.id, projData);
     });
     for (const projId of projectiles.keys()) {
         if (!currentProjIds.has(projId)) {
             projectiles.delete(projId);
         }
     }

    // Update Players
    const receivedPlayerIds = new Set();
    (state.players || []).forEach(playerData => {
        receivedPlayerIds.add(playerData.id);
        if (playerData.id === selfId) {
            handleSelfPlayerState(playerData);
        } else {
            handleOtherPlayerState(playerData, serverTime);
        }
    });

    for (const id of players.keys()) {
        if (id !== selfId && !receivedPlayerIds.has(id)) {
            // console.log(`Removing player ${id} (not in state)`); // DEBUG
            players.delete(id);
        }
    }
}

// --- State Handling for Self and Others ---

function handleSelfPlayerState(serverPlayerData) {
    // Ensure player storage exists
    if (!players.has(selfId)) {
        players.set(selfId, { data: {}, interpBuffer: [], renderX: 0, renderY: 0 });
    }
    const playerState = players.get(selfId);
    playerState.data = serverPlayerData; // Store the latest authoritative data

    // Update predictedState based on server's authoritative state
    predictedState.isDead = serverPlayerData.isDead;
    predictedState.radius = serverPlayerData.radius || 15; // Update radius

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

    // Get server-provided speed for accurate prediction and correction threshold
    const currentSpeed = serverPlayerData.speed; // Use speed directly from server data
    const speedPerTick = currentSpeed * (1000 / BASE_TICK_RATE); // Distance moved per server tick
    const correctionThreshold = speedPerTick * 2; // Allow up to 2 ticks of drift before snapping

    // DEBUG: Log prediction error occasionally
     // if (errorDist > 1.0) {
     //      console.log(`[Client] Prediction Error: ${errorDist.toFixed(2)}. Server Pos: (${serverX.toFixed(1)}, ${serverY.toFixed(1)}), Predicted Pos: (${predictedState.x.toFixed(1)}, ${predictedState.y.toFixed(1)}), Server Seq: ${lastProcessedSeq}, History Len: ${inputHistory.length}`);
     // }

    if (errorDist > correctionThreshold) {
        // Large error: Snap predicted state directly to server state
        console.warn(`[Client] Prediction error large (${errorDist.toFixed(1)} > ${correctionThreshold.toFixed(1)}). Snapping.`);
        predictedState.x = serverX;
        predictedState.y = serverY;
         // Clear history on large snap? Can help prevent runaway, but might cause stutter
         // inputHistory = []; // Consider uncommenting if prediction goes wild
    } else if (errorDist > 0.5) { // Minor correction threshold (adjust as needed)
         // Minor error: Gently nudge predicted state towards server state
         predictedState.x = lerp(predictedState.x, serverX, 0.1);
         predictedState.y = lerp(predictedState.y, serverY, 0.1);
    }
    // Else: Error is negligible, prediction is likely accurate.

    // Re-apply unacknowledged inputs onto the (potentially corrected) state
    let replayX = predictedState.x;
    let replayY = predictedState.y;
    const radius = predictedState.radius; // Use predicted radius

    inputHistory.forEach(hist => {
        let moveX = 0, moveY = 0;
        if (hist.input.up) moveY -= 1; if (hist.input.down) moveY += 1;
        if (hist.input.left) moveX -= 1; if (hist.input.right) moveX += 1;
        const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);

        if (magnitude > 0) {
            // Replay movement using the speed calculated from server data
             // Calculate move amount for ONE tick duration (1 / BASE_TICK_RATE seconds)
            const moveAmount = speedPerTick * (1 / BASE_TICK_RATE); // Fixed duration movement

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
}


function handleOtherPlayerState(playerData, serverTime) {
    const renderTime = Date.now() - INTERPOLATION_DELAY;

    if (!players.has(playerData.id)) {
        players.set(playerData.id, {
            data: playerData,
            interpBuffer: [{ timestamp: serverTime, x: playerData.x, y: playerData.y }],
            renderX: playerData.x,
            renderY: playerData.y
        });
    } else {
        const playerState = players.get(playerData.id);
        playerState.data = playerData;

        const buffer = playerState.interpBuffer;
        if (buffer.length === 0 || buffer[buffer.length - 1].timestamp < serverTime) {
             buffer.push({ timestamp: serverTime, x: playerData.x, y: playerData.y });
        }

        // Remove old states (keep enough for interpolation)
        while (buffer.length > 2 && buffer[1].timestamp < renderTime - 200) { // Keep ~200ms margin
            buffer.shift();
        }
    }
}

// --- Input Sending ---

function startInputInterval() {
    if (inputIntervalId) clearInterval(inputIntervalId);
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
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId || predictedState.isDead) {
        if (predictedState.isDead) {
             inputState.up = inputState.down = inputState.left = inputState.right = inputState.attack = false;
        }
        return;
    }

    // Calculate Aiming Coordinates (World Space)
    let aimX, aimY;
    if (isTouchDevice && joystickActive) {
        // Aim based on normalized joystick direction relative to predicted position
        aimX = predictedState.x + aimFromJoystick.x * 200; // Scale multiplier for aim "distance"
        aimY = predictedState.y + aimFromJoystick.y * 200;
    } else {
        // Aim based on mouse position converted to world space, relative to camera center
        aimX = camera.x + (mouseScreenX - canvas.width / 2);
        aimY = camera.y + (mouseScreenY - canvas.height / 2);
    }

    inputSequenceNumber++;
    const currentInput = {
        ...inputState,
        mouseX: aimX,
        mouseY: aimY,
        seq: inputSequenceNumber
    };

    // Store copy for prediction history
    inputHistory.push({ seq: inputSequenceNumber, input: { ...currentInput } });
    if (inputHistory.length > 120) { // Limit history size (~4 seconds at 30Hz)
        inputHistory.shift();
    }

    // Send to server
    ws.send(JSON.stringify({ type: 'input', input: currentInput }));

    // Reset attack state after sending (for click-based attack)
    inputState.attack = false;

     // DEBUG: Log input state being sent
     // if (inputState.up || inputState.down || inputState.left || inputState.right || inputState.attack) {
     //     console.log(`[Client] Sent Input Seq ${currentInput.seq}: ${JSON.stringify({ move: { u: inputState.up, d: inputState.down, l: inputState.left, r: inputState.right }, attack: inputState.attack, aim: { x: aimX.toFixed(0), y: aimY.toFixed(0)} })}`);
     // }
}

// =============================================================================
// INPUT HANDLING (Keyboard, Mouse, Touch) - Keep mostly as is
// =============================================================================

function setupInputListeners() {
    window.addEventListener('keydown', (e) => {
        if (level2SelectionScreen.style.display !== 'none' || e.repeat) return;
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = true; break;
            case 's': case 'arrowdown': inputState.down = true; break;
            case 'a': case 'arrowleft': inputState.left = true; break;
            case 'd': case 'arrowright': inputState.right = true; break;
             case ' ': inputState.attack = true; break;
        }
    });
    window.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': inputState.up = false; break;
            case 's': case 'arrowdown': inputState.down = false; break;
            case 'a': case 'arrowleft': inputState.left = false; break;
            case 'd': case 'arrowright': inputState.right = false; break;
             case ' ': break;
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        mouseScreenX = e.clientX;
        mouseScreenY = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
        if (level2SelectionScreen.style.display !== 'none') return;
        if (e.button === 0) inputState.attack = true;
        e.preventDefault();
    });
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
         inputState.attack = true;
     }, { passive: false });
}

function handleJoystickStart(e) {
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

function handleJoystickMove(e) {
    e.preventDefault();
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickVisuals();
    updateInputFromJoystick();
}

function handleJoystickEnd(e) {
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    resetJoystick();
}

function updateJoystickVisuals() {
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

function updateInputFromJoystick() {
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const normalizedDist = Math.min(1, distance / maxJoystickDist);

    if (normalizedDist < JOYSTICK_DEAD_ZONE) {
        inputState.up = inputState.down = inputState.left = inputState.right = false;
        return;
    }

    const angle = Math.atan2(dy, dx);
    const effectiveDx = Math.cos(angle);
    const effectiveDy = Math.sin(angle);

    aimFromJoystick.x = effectiveDx;
    aimFromJoystick.y = effectiveDy;

    const pi = Math.PI;
    inputState.up = angle > -pi * 0.875 && angle < -pi * 0.125;
    inputState.down = angle > pi * 0.125 && angle < pi * 0.875;
    inputState.left = angle > pi * 0.625 || angle < -pi * 0.625;
    inputState.right = angle > -pi * 0.375 && angle < pi * 0.375;
}

function resetJoystick() {
    joystickActive = false;
    touchIdentifier = null;
    joystickThumb.style.transform = `translate(0px, 0px)`;
    inputState.up = inputState.down = inputState.left = inputState.right = false;
}

// =============================================================================
// LEVEL 2 SELECTION UI - Keep as is
// =============================================================================
function showLevel2Selection() {
    const player = players.get(selfId)?.data;
    if (!player) return;
    level2OptionsDiv.innerHTML = '';
    let choices = [];
     switch (player.race) {
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
                level2SelectionScreen.style.display = 'none';
            }
        };
        level2OptionsDiv.appendChild(button);
    });
    level2SelectionScreen.style.display = 'block';
}


// =============================================================================
// CLIENT-SIDE MOVEMENT PREDICTION & INTERPOLATION
// =============================================================================
function updateSelfPlayerPrediction(deltaTime) {
    // Predict movement only if the player is NOT predicted as dead
    if (!selfId || predictedState.isDead) {
         // If dead, ensure input state is cleared just in case
         // This is also done before sending input, but good to be safe.
         inputState.up = inputState.down = inputState.left = inputState.right = inputState.attack = false;
         return;
    }

    // Use the player's actual speed received from the server
    const selfData = players.get(selfId)?.data;
    const currentSpeed = selfData ? selfData.speed : PLAYER_BASE_SPEED; // Fallback to base if data not yet available

    const speedPerSecond = currentSpeed * BASE_TICK_RATE; // Speed units per second
    const radius = predictedState.radius; // Use predicted radius

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


function updateOtherPlayerInterpolation(currentTime) {
    const renderTime = currentTime - INTERPOLATION_DELAY;

    players.forEach((playerState, id) => {
        if (id === selfId) return;

        const buffer = playerState.interpBuffer;
        if (buffer.length < 2) {
            if (buffer.length === 1) {
                playerState.renderX = buffer[0].x;
                playerState.renderY = buffer[0].y;
            } else if (playerState.data) {
                 playerState.renderX = playerState.data.x;
                 playerState.renderY = playerState.data.y;
            }
            return;
        }

        let state1 = buffer[0];
        let state2 = buffer[1];
        for (let i = 1; i < buffer.length; i++) {
            if (buffer[i].timestamp >= renderTime) {
                state2 = buffer[i];
                state1 = buffer[i - 1];
                break;
            }
             if (i === buffer.length - 1) { // If renderTime is past the last entry, extrapolate between last two
                 state1 = buffer[i-1];
                 state2 = buffer[i];
                 break; // Found the segment (last two points)
             }
        }

        const timeDiff = state2.timestamp - state1.timestamp;
        const alpha = timeDiff > 0 ? Math.max(0, Math.min(1, (renderTime - state1.timestamp) / timeDiff)) : 1;

        playerState.renderX = lerp(state1.x, state2.x, alpha);
        playerState.renderY = lerp(state1.y, state2.y, alpha);
    });
}


// =============================================================================
// GAME LOOP & RENDERING
// =============================================================================

function startGameLoop() {
    if (gameLoopId) return;
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
    // CRITICAL: Only run game logic and updates if selfId exists and we have a connection
    // Rendering can still happen to show "Connecting..." or start screen
    if (selfId && ws && ws.readyState === WebSocket.OPEN) {
         const deltaTime = Math.min(0.05, (currentTime - lastFrameTime) / 1000.0); // Capped delta time

         // --- Updates ---
         updateSelfPlayerPrediction(deltaTime);
         updateOtherPlayerInterpolation(currentTime);
         updateCamera(deltaTime); // Camera follows predicted state
    } else {
         // If no selfId or connection, ensure camera isn't following a ghost
         // Camera remains at last known good spot or origin/center
         if (!selfId && !predictedState.isDead) { // If we lost ID but player wasn't dead yet
              predictedState.isDead = true; // Mark predicted state as dead
         }
         // Camera update can still run to smoothly center on a default spot if needed
         updateCamera(0); // Use 0 delta time to avoid movement
    }
    lastFrameTime = currentTime; // Update frame time regardless of updates being run

    // --- Rendering ---
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const viewBounds = getCameraViewBounds();

    ctx.save();
    // Translate based on camera's current render position
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    drawMapBackground(viewBounds);
    drawOrbs(viewBounds);
    drawProjectiles(viewBounds);
    drawPlayers(viewBounds); // Draws self (predicted) and others (interpolated)

    ctx.restore();

    drawUI();

     if(level2SelectionScreen.style.display !== 'none') {
         ctx.fillStyle = 'rgba(0,0,0,0.5)';
         ctx.fillRect(0,0,canvas.width, canvas.height);
     }

    gameLoopId = requestAnimationFrame(gameLoop); // Keep requesting next frame
}

function updateCamera(deltaTime) {
    // Camera smoothly follows the predicted player position IF the player is alive
     if (predictedState && !predictedState.isDead && !isNaN(predictedState.x) && !isNaN(predictedState.y)) {
         camera.targetX = predictedState.x;
         camera.targetY = predictedState.y;
     } else {
         // If player is dead or not initialized, maybe target map center or just stay put
         // For now, keep the last known target or default to center if never initialized
         if (camera.targetX === 0 && camera.targetY === 0 && mapWidth > 0) {
             camera.targetX = mapWidth / 2;
             camera.targetY = mapHeight / 2;
         }
         // Camera will smoothly move to this target if it changes
     }


    camera.x = lerp(camera.x, camera.targetX, camera.speed);
    camera.y = lerp(camera.y, camera.targetY, camera.speed);

    if (Math.abs(camera.x - camera.targetX) < 0.1) camera.x = camera.targetX;
    if (Math.abs(camera.y - camera.targetY) < 0.1) camera.y = camera.targetY;
}


// --- Drawing Functions (Optimized) ---

const GRID_COLOR = '#444'; const GRID_LINE_WIDTH = 1;
const BOUNDARY_COLOR = '#555'; const BOUNDARY_LINE_WIDTH = 5;
const GRID_SIZE = 100;

function drawMapBackground(viewBounds) {
    ctx.strokeStyle = GRID_COLOR; ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.beginPath();
    const startX = Math.floor(viewBounds.left / GRID_SIZE) * GRID_SIZE;
    const endX = Math.ceil(viewBounds.right / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(viewBounds.top / GRID_SIZE) * GRID_SIZE;
    const endY = Math.ceil(viewBounds.bottom / GRID_SIZE) * GRID_SIZE;
    for (let x = startX; x <= endX; x += GRID_SIZE) { ctx.moveTo(x, viewBounds.top - GRID_LINE_WIDTH); ctx.lineTo(x, viewBounds.bottom + GRID_LINE_WIDTH); }
    for (let y = startY; y <= endY; y += GRID_SIZE) { ctx.moveTo(viewBounds.left - GRID_LINE_WIDTH, y); ctx.lineTo(viewBounds.right + GRID_LINE_WIDTH, y); }
    ctx.stroke();

    ctx.strokeStyle = BOUNDARY_COLOR; ctx.lineWidth = BOUNDARY_LINE_WIDTH;
     if (viewBounds.top < 0) ctx.strokeRect(0, 0, mapWidth, 0); // Height 0 for just top line
     if (viewBounds.bottom > mapHeight) ctx.strokeRect(0, mapHeight, mapWidth, 0);
     if (viewBounds.left < 0) ctx.strokeRect(0, 0, 0, mapHeight); // Width 0 for just left line
     if (viewBounds.right > mapWidth) ctx.strokeRect(mapWidth, 0, 0, mapHeight);
}

const ORB_COLOR = '#f0e370';
function drawOrbs(viewBounds) {
    ctx.fillStyle = ORB_COLOR;
    ctx.beginPath();
    let count = 0;
    orbs.forEach(orb => {
        if (isPointInBounds(orb.x, orb.y, viewBounds, orb.radius)) {
            ctx.moveTo(orb.x + orb.radius, orb.y);
            ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
            count++;
        }
    });
    if (count > 0) ctx.fill();
}

function drawProjectiles(viewBounds) {
    projectiles.forEach(proj => {
        if (isPointInBounds(proj.x, proj.y, viewBounds, proj.radius)) {
            ctx.fillStyle = proj.color || '#ffffff';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

const PLAYER_OUTLINE_COLOR = '#000000'; const PLAYER_OUTLINE_WIDTH = 2;
const NAME_FONT = 'bold 12px sans-serif'; const NAME_COLOR = '#ffffff';
const TEXT_SHADOW_COLOR = 'black'; const TEXT_SHADOW_BLUR = 2;

function drawPlayers(viewBounds) {
    ctx.lineWidth = PLAYER_OUTLINE_WIDTH; ctx.strokeStyle = PLAYER_OUTLINE_COLOR;
    ctx.font = NAME_FONT; ctx.textAlign = 'center';

    players.forEach((playerState, id) => {
        const data = playerState.data;
        if (!data) return; // Skip if no data received yet

        let drawX, drawY;
        if (id === selfId) {
            // Draw self using predicted state
            if (predictedState.isDead) return; // Don't draw self if predicted dead
            drawX = predictedState.x; drawY = predictedState.y;
        } else {
            // Draw others using interpolated state
            if (data.isDead) return; // Don't draw other players if server says they are dead
            drawX = playerState.renderX; drawY = playerState.renderY;
             if (isNaN(drawX) || isNaN(drawY)) { drawX = data.x; drawY = data.y; } // Fallback
        }

        // Culling check
        if (!isPointInBounds(drawX, drawY, viewBounds, (data.radius || predictedState.radius) * 4)) return; // Use player's radius or default/predicted

        // Draw Player Circle
        ctx.fillStyle = data.color || '#cccccc';
        ctx.beginPath();
        ctx.arc(drawX, drawY, data.radius || predictedState.radius, 0, Math.PI * 2); // Use player's actual radius if available
        ctx.fill();
        ctx.stroke();

        // Draw Name
        const nameY = drawY - (data.radius || predictedState.radius) - 15;
        ctx.fillStyle = NAME_COLOR; ctx.shadowColor = TEXT_SHADOW_COLOR; ctx.shadowBlur = TEXT_SHADOW_BLUR;
        ctx.fillText(`${data.name} [${data.level}]`, drawX, nameY);
        ctx.shadowBlur = 0;

        // Draw HP Bar
        drawHpBar(ctx, drawX, nameY + 5, data.radius || predictedState.radius, data.hp, data.maxHp);
    });
}

const HP_BAR_HEIGHT = 6; const HP_BAR_BG_COLOR = '#555';
const HP_BAR_BORDER_COLOR = '#333'; const HP_BAR_BORDER_WIDTH = 1;
const HP_COLOR_HIGH = '#4CAF50'; const HP_COLOR_MID = '#ffc107'; const HP_COLOR_LOW = '#f44336';

function drawHpBar(context, x, y, ownerRadius, hp, maxHp) {
    const hpBarWidth = ownerRadius * 2.5;
    const hpBarX = x - hpBarWidth / 2;
    const hpPercent = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
    const currentHpWidth = hpBarWidth * hpPercent;

    context.fillStyle = HP_BAR_BG_COLOR;
    context.fillRect(hpBarX, y, hpBarWidth, HP_BAR_HEIGHT);

    context.fillStyle = hpPercent > 0.6 ? HP_COLOR_HIGH : (hpPercent > 0.3 ? HP_COLOR_MID : HP_COLOR_LOW);
    if (currentHpWidth > 0) context.fillRect(hpBarX, y, currentHpWidth, HP_BAR_HEIGHT);

    context.strokeStyle = HP_BAR_BORDER_COLOR; context.lineWidth = HP_BAR_BORDER_WIDTH;
    context.strokeRect(hpBarX - 0.5, y - 0.5, hpBarWidth + 1, HP_BAR_HEIGHT + 1);
}

const UI_FONT_LARGE = 'bold 16px sans-serif'; const UI_FONT_NORMAL = '12px sans-serif';
const UI_FONT_SMALL = 'bold 12px sans-serif'; const UI_TEXT_COLOR = '#ffffff';
const UI_XP_BAR_HEIGHT = 18; const UI_XP_COLOR = '#f0e370'; const UI_BAR_BG_COLOR = 'rgba(85, 85, 85, 0.7)';
const UI_HP_CIRCLE_X = 80; const UI_HP_CIRCLE_RADIUS = 50; const UI_HP_CIRCLE_WIDTH = 8;

function drawUI() {
    const selfData = players.get(selfId)?.data;

    // Draw death screen if predicted dead AND not showing level up screen
    if (predictedState.isDead && !level2SelectionScreen.style.display) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'; // Dark overlay
        ctx.fillRect(0,0, canvas.width, canvas.height); // Cover entire screen

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.shadowColor = TEXT_SHADOW_COLOR; ctx.shadowBlur = 5; // Stronger shadow for death screen

        ctx.font = 'bold 40px sans-serif';
        ctx.fillText('YOU DIED', canvas.width / 2, canvas.height / 2 - 30);

        ctx.font = 'bold 20px sans-serif';
        // Display time until respawn if possible? Needs server time...
        // For now, just show message
        ctx.fillText('Respawning...', canvas.width / 2, canvas.height / 2 + 20);

        if(selfData?.killCount > 0){
             ctx.font = '16px sans-serif';
             ctx.fillText(`Kills: ${selfData.killCount}`, canvas.width / 2, canvas.height / 2 + 50);
        }

        ctx.shadowBlur = 0; // Reset shadow
        return; // Do not draw normal UI elements when dead
    }


    // If not dead, draw normal UI
    if (!selfData) { // Player is not dead but selfData is missing (e.g., just joined)
         // Maybe draw a "Connecting..." message
         ctx.fillStyle = '#ffffff';
         ctx.textAlign = 'center';
         ctx.font = '20px sans-serif';
         ctx.fillText('Connecting...', canvas.width / 2, canvas.height / 2);
         return; // Don't draw other UI elements without self data
    }


    // Common UI styles
    ctx.textAlign = 'center';
    ctx.fillStyle = UI_TEXT_COLOR;
    ctx.shadowColor = TEXT_SHADOW_COLOR;

    // --- XP Bar ---
    if (selfData.level === 1 && !selfData.canChooseLevel2) {
        const xpBarWidth = Math.min(400, canvas.width * 0.5);
        const xpBarX = (canvas.width - xpBarWidth) / 2;
        const xpBarY = canvas.height - UI_XP_BAR_HEIGHT - 20;

        const xpForNextLevel = XP_TO_LEVEL_2;
        const xpCurrentLevelBase = 0;
        const xpProgress = Math.max(0, selfData.xp - xpCurrentLevelBase);
        const xpNeeded = xpForNextLevel - xpCurrentLevelBase;
        const xpPercent = xpNeeded > 0 ? Math.min(1, xpProgress / xpNeeded) : 1;

        ctx.fillStyle = UI_BAR_BG_COLOR;
        ctx.fillRect(xpBarX, xpBarY, xpBarWidth, UI_XP_BAR_HEIGHT);
        ctx.fillStyle = UI_XP_COLOR;
        if (xpPercent > 0) ctx.fillRect(xpBarX, xpBarY, xpBarWidth * xpPercent, UI_XP_BAR_HEIGHT);

        ctx.fillStyle = UI_TEXT_COLOR;
        ctx.font = UI_FONT_SMALL; ctx.shadowBlur = TEXT_SHADOW_BLUR;
        ctx.fillText(`${xpProgress} / ${xpNeeded} XP`, canvas.width / 2, xpBarY + UI_XP_BAR_HEIGHT / 1.5);
        ctx.shadowBlur = 0;
    }

    // --- Level Display ---
    const levelY = canvas.height - (UI_XP_BAR_HEIGHT + 20 + 8);
    ctx.font = UI_FONT_LARGE; ctx.shadowBlur = TEXT_SHADOW_BLUR;
    ctx.fillText(`Level: ${selfData.level}`, canvas.width / 2, levelY);
    ctx.shadowBlur = 0;

    // --- HP Circle (Bottom Left) ---
    const uiHpY = canvas.height - 80;
    const hpPercent = selfData.maxHp > 0 ? Math.max(0, selfData.hp / selfData.maxHp) : 0;
    const angle = hpPercent * Math.PI * 2;

    ctx.lineWidth = UI_HP_CIRCLE_WIDTH;
    ctx.strokeStyle = UI_BAR_BG_COLOR;
    ctx.beginPath(); ctx.arc(UI_HP_CIRCLE_X, uiHpY, UI_HP_CIRCLE_RADIUS, 0, Math.PI * 2); ctx.stroke();
    if (angle > 0) {
        ctx.strokeStyle = hpPercent > 0.6 ? HP_COLOR_HIGH : (hpPercent > 0.3 ? HP_COLOR_MID : HP_COLOR_LOW);
        ctx.beginPath(); ctx.arc(UI_HP_CIRCLE_X, uiHpY, UI_HP_CIRCLE_RADIUS, -Math.PI / 2, -Math.PI / 2 + angle); ctx.stroke();
    }
    ctx.fillStyle = UI_TEXT_COLOR; ctx.font = 'bold 18px sans-serif'; ctx.shadowBlur = TEXT_SHADOW_BLUR;
    ctx.fillText(selfData.hp, UI_HP_CIRCLE_X, uiHpY + 6);
    ctx.shadowBlur = 0;


     // --- Kill Count (Top Right) ---
     ctx.textAlign = 'right';
     ctx.font = UI_FONT_LARGE; ctx.shadowBlur = TEXT_SHADOW_BLUR;
     ctx.fillText(`Kills: ${selfData.killCount || 0}`, canvas.width - 20, 30);
     ctx.shadowBlur = 0;

     // --- Crosshair (Non-touch only) ---
      if (!isTouchDevice) {
          const crosshairSize = 8;
           ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; ctx.lineWidth = 1;
           ctx.beginPath();
           ctx.moveTo(mouseScreenX - crosshairSize, mouseScreenY); ctx.lineTo(mouseScreenX + crosshairSize, mouseScreenY);
           ctx.moveTo(mouseScreenX, mouseScreenY - crosshairSize); ctx.lineTo(mouseScreenX, mouseScreenY + crosshairSize);
           ctx.stroke();
      }
}


// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function lerp(start, end, amount) { return start + (end - start) * amount; }

function getCameraViewBounds() {
    const halfWidth = canvas.width / 2; const halfHeight = canvas.height / 2;
    return { left: camera.x - halfWidth, right: camera.x + halfWidth, top: camera.y - halfHeight, bottom: camera.y + halfHeight };
}

function isPointInBounds(x, y, bounds, margin = 0) {
    return x + margin >= bounds.left && x - margin <= bounds.right && y + margin >= bounds.top && y - margin <= bounds.bottom;
}

// --- Start the application ---
init();
