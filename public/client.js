// client.js
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
let serverTimeOffset = 0; // Rough estimate of time difference with server
let latency = 0; // Rough estimate of round-trip time / 2

// --- Game State ---
let players = new Map(); // Stores player data received from server { data: playerData, interpBuffer: [], renderX, renderY }
let orbs = []; // Simple array of orbs
let projectiles = []; // Simple array of projectiles
let mapWidth = 2000;
let mapHeight = 2000;
let lastServerTimestamp = 0;

// --- Self Player State (Client-Side Prediction) ---
// Initialize with default off-screen values until welcome message arrives
let predictedState = { x: -1000, y: -1000, isDead: true, radius: PLAYER_RADIUS }; // Start as "dead" and off-screen
let inputHistory = [];
let inputSequenceNumber = 0;

// --- Input State ---
let inputState = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
let lastSentInputState = {};
let mouseScreenX = window.innerWidth / 2;
let mouseScreenY = window.innerHeight / 2;

// --- Camera State ---
let camera = { x: -1000, y: -1000, targetX: -1000, targetY: -1000, speed: 0.1 };

// --- Touch Control State ---
let touchIdentifier = null;
let joystickActive = false;
let joystickStartX = 0;
let joystickStartY = 0;
let joystickCurrentX = 0;
let joystickCurrentY = 0;
let aimFromJoystick = { x: 0, y: 0 }; // Store aim direction derived from joystick separately
let isTouchDevice = false;
const JOYSTICK_BASE_RADIUS = 60; // Reference radius of the base
const THUMB_BASE_RADIUS = 30;  // Reference radius of the thumb
let joystickRadius = JOYSTICK_BASE_RADIUS;
let thumbRadius = THUMB_BASE_RADIUS;
let maxJoystickDist = joystickRadius - thumbRadius;
const JOYSTICK_DEAD_ZONE = 0.15; // Percentage of radius (15%)

// --- Constants ---
const INTERPOLATION_DELAY = 100;
const PLAYER_RADIUS = 15; // Base radius, might change with class
const PLAYER_SPEED = 2.5;
const BASE_TICK_RATE = 60;
const XP_TO_LEVEL_2 = 100; // Keep in sync with server

// --- Game Loop Control ---
let lastFrameTime = performance.now();
let gameLoopId = null;
let isGameLoopRunning = false; // Flag to control loop execution

// --- Optimization Cache ---
let canvasHalfWidth = window.innerWidth / 2;
let canvasHalfHeight = window.innerHeight / 2;


// =============================================================================
// INITIALIZATION & SETUP
// =============================================================================

function init() {
    console.log("Initializing client...");
    isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    console.log("Is Touch Device:", isTouchDevice);

    setupStartScreen();
    setupInputListeners();
    resizeCanvas(); // Set initial size and cache half-dimensions
    window.addEventListener('resize', resizeCanvas);

    if (isTouchDevice) {
        touchControls.style.display = 'block';
        setupTouchControls();
    }
    console.log("Initialization complete. Waiting for connection...");
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // Cache half dimensions for performance
    canvasHalfWidth = canvas.width / 2;
    canvasHalfHeight = canvas.height / 2;

    // Recalculate joystick dimensions based on screen size if needed
    // Example: Make joystick slightly smaller on very small screens
    const scaleFactor = Math.min(1, window.innerWidth / 600); // Scale down if width < 600px
    joystickRadius = JOYSTICK_BASE_RADIUS * scaleFactor;
    thumbRadius = THUMB_BASE_RADIUS * scaleFactor;
    maxJoystickDist = joystickRadius - thumbRadius;

    joystickArea.style.width = `${joystickRadius * 2}px`;
    joystickArea.style.height = `${joystickRadius * 2}px`;
    joystickThumb.style.width = `${thumbRadius * 2}px`;
    joystickThumb.style.height = `${thumbRadius * 2}px`;
    // Center the thumb initially
    joystickThumb.style.top = `${joystickRadius - thumbRadius}px`;
    joystickThumb.style.left = `${joystickRadius - thumbRadius}px`;

    console.log("Canvas resized:", canvas.width, canvas.height);
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
    if (isTouchDevice) touchControls.style.display = 'block'; // Ensure touch controls are visible

    connectWebSocket(name, selectedRace);
}

function showError(message) {
    console.error("Error:", message);
    errorMessage.textContent = message;
    // Consider showing start screen again on critical errors
    // startScreen.style.display = 'block';
    // canvas.style.display = 'none';
    // touchControls.style.display = 'none';
}

// =============================================================================
// WEBSOCKET COMMUNICATION
// =============================================================================

function connectWebSocket(name, race) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.warn("WebSocket already open.");
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}`;
    console.log(`Connecting to ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connection established.');
        // Reset state for new connection
        selfId = null;
        players.clear();
        inputHistory = [];
        inputSequenceNumber = 0;
        // Send join message
        ws.send(JSON.stringify({ type: 'join', name: name, race: race }));
        // Start pinging for latency estimation (optional)
        // setInterval(sendPing, 2000);
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            // console.log('Received message:', message.type); // DEBUG

            // Process message only if WS is open
            if (ws.readyState !== WebSocket.OPEN) return;

            switch (message.type) {
                case 'welcome':
                    handleWelcome(message);
                    break;
                case 'gameState':
                    // Ensure game loop is running before processing state
                    if (isGameLoopRunning) {
                        handleGameState(message);
                    } else {
                         console.log("Received gameState before loop started, queuing or ignoring?");
                         // Maybe store the first state? For now, let's rely on welcome state + subsequent states
                    }
                    break;
                 case 'levelUpReady':
                     if (isGameLoopRunning) showLevel2Selection();
                     break;
                 case 'classSelected':
                      if (isGameLoopRunning) level2SelectionScreen.style.display = 'none';
                     break;
                 case 'pong': // Handle ping response
                     // latency = (Date.now() - message.clientTime) / 2;
                     // console.log(`Ping: ${latency.toFixed(0)}ms`);
                     break;
                default:
                    console.warn("Received unknown message type:", message.type);
            }
        } catch (error) {
            console.error('Error processing message:', event.data, error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showError('Connection error. Please refresh.');
        stopGameLoop(); // Stop loop on error
        resetClientState();
    };

    ws.onclose = (event) => {
        console.log(`WebSocket connection closed: Code=${event.code}, Reason=${event.reason}`);
        showError('Disconnected from server. Please refresh.');
        stopGameLoop(); // Stop loop on close
        resetClientState(); // Reset state and show start screen
    };
}


function handleWelcome(message) {
     // Ensure we haven't already initialized
     if (selfId) {
         console.warn("Received welcome message again, ignoring.");
         return;
     }
    selfId = message.playerId;
    mapWidth = message.mapWidth;
    mapHeight = message.mapHeight;
    console.log(`Joined game! Player ID: ${selfId}, Map: ${mapWidth}x${mapHeight}`);

    // Immediately process the initial state if provided in welcome
    let initialPlayerFound = false;
    if (message.initialState) {
        // Use current time as base for the initial state
        processServerState(message.initialState, Date.now());
        const selfData = players.get(selfId)?.data;
        if (selfData) {
             // Set initial predicted state based on received data
            predictedState.x = selfData.x;
            predictedState.y = selfData.y;
            predictedState.isDead = selfData.isDead;
            predictedState.radius = selfData.radius || PLAYER_RADIUS; // Ensure radius is set

             // Set initial camera position *directly* to avoid jump
             camera.x = predictedState.x;
             camera.y = predictedState.y;
             camera.targetX = predictedState.x;
             camera.targetY = predictedState.y;

             console.log(`Initial state processed. Predicted pos: ${predictedState.x.toFixed(1)}, ${predictedState.y.toFixed(1)}, Camera pos: ${camera.x.toFixed(1)}, ${camera.y.toFixed(1)}`);
             initialPlayerFound = true;
        } else {
             console.error("CRITICAL: Self player data not found in initial state provided by welcome message!");
             // Fallback - place somewhere visible, but this indicates a server issue
             predictedState.x = mapWidth / 2;
             predictedState.y = mapHeight / 2;
             predictedState.isDead = false; // Assume alive
             camera.x = camera.targetX = predictedState.x;
             camera.y = camera.targetY = predictedState.y;
        }
    } else {
         console.error("CRITICAL: No initial state provided in welcome message!");
         // Need fallback or request state?
         return; // Cannot start game loop without initial state
    }

    // Start the game loop ONLY if we successfully got initial state
    if (initialPlayerFound) {
        startGameLoop();
        // Start sending input periodically
        setInterval(sendInputToServer, 1000 / 30);
    } else {
         showError("Failed to initialize player state. Please refresh.");
    }
}

function handleGameState(message) {
    // Estimate server time? Basic approach: assume message timestamp is close enough for now
    // A more robust solution involves clock synchronization.
    const serverTime = message.timestamp || Date.now(); // Fallback if timestamp missing
    lastServerTimestamp = serverTime;

    processServerState(message, serverTime);
}

function processServerState(state, serverTime) {
    // Update Orbs & Projectiles (simple replacement)
    orbs = state.orbs || [];
    projectiles = state.projectiles || [];

    // Update Players (more complex due to interpolation & prediction)
    const receivedPlayerIds = new Set();
    state.players.forEach(playerData => {
        receivedPlayerIds.add(playerData.id);

        if (playerData.id === selfId) {
            // --- Handle Self Player Reconciliation ---
             handleSelfPlayerState(playerData);
        } else {
            // --- Handle Other Players Interpolation ---
            handleOtherPlayerState(playerData, serverTime);
        }
    });

     // Remove players that are no longer in the state message
     const playersToRemove = [];
     for (const id of players.keys()) {
         if (id !== selfId && !receivedPlayerIds.has(id)) {
             playersToRemove.push(id);
         }
     }
     playersToRemove.forEach(id => {
         console.log(`Removing player ${id} (not in state)`);
         players.delete(id);
     });
}

function handleSelfPlayerState(serverPlayerData) {
     // This is the server's authoritative state for our player
     const serverState = {
         x: serverPlayerData.x,
         y: serverPlayerData.y,
         isDead: serverPlayerData.isDead,
         // Include other critical state if needed (e.g., HP for UI)
         hp: serverPlayerData.hp,
         maxHp: serverPlayerData.maxHp,
         xp: serverPlayerData.xp,
         level: serverPlayerData.level,
         canChooseLevel2: serverPlayerData.canChooseLevel2,
         lastProcessedInputSeq: serverPlayerData.lastProcessedInputSeq
     };

     // Store the authoritative state (used for UI, maybe minor corrections)
      if (!players.has(selfId)) players.set(selfId, { data: {}, renderX: 0, renderY: 0 });
      players.get(selfId).data = serverPlayerData; // Keep full data for UI etc.

     // --- Client-Side Prediction Reconciliation ---
     predictedState.isDead = serverState.isDead; // Server is authoritative for death

     // Remove acknowledged inputs from history
     inputHistory = inputHistory.filter(hist => hist.seq > serverState.lastProcessedInputSeq);

      // Check for significant position difference (server correction)
      const diffX = serverState.x - predictedState.x;
      const diffY = serverState.y - predictedState.y;
      const errorDistance = Math.sqrt(diffX * diffX + diffY * diffY);

     // If error is large, snap to server position. Otherwise, allow prediction.
     // Threshold needs tuning - too small = jittery, too large = prediction errors visible
     const CORRECTION_THRESHOLD = PLAYER_SPEED * (BASE_TICK_RATE / 10) ; // Allow ~1/10 sec prediction divergence

      if (errorDistance > CORRECTION_THRESHOLD) {
          console.warn(`Significant prediction error detected! Dist: ${errorDistance.toFixed(1)}. Snapping to server state.`);
          predictedState.x = serverState.x;
          predictedState.y = serverState.y;
      } else if (errorDistance > 1.0) { // Minor corrections - smoothly adjust
           // predictedState.x = lerp(predictedState.x, serverState.x, 0.1);
           // predictedState.y = lerp(predictedState.y, serverState.y, 0.1);
           // Or just let prediction continue and it should converge if inputs match
      }


      // Re-apply unacknowledged inputs onto the (potentially corrected) state
       let replayedX = predictedState.x; // Start replaying from potentially corrected pos
       let replayedY = predictedState.y;
       const selfData = players.get(selfId)?.data;
       const playerSpeed = selfData ? getPlayerCurrentSpeed(selfData) : PLAYER_SPEED; // Get actual speed if possible
       const speedPerTick = playerSpeed * (1000 / BASE_TICK_RATE); // Speed per assumed server tick

       inputHistory.forEach(hist => {
            let moveX = 0;
            let moveY = 0;
            if (hist.input.up) moveY -= 1;
            if (hist.input.down) moveY += 1;
            if (hist.input.left) moveX -= 1;
            if (hist.input.right) moveX += 1;
            const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
            if (magnitude > 0) {
                replayedX += (moveX / magnitude) * speedPerTick * (GAME_LOOP_RATE / 1000.0); // Apply scaled movement for this past input frame
                 replayedY += (moveY / magnitude) * speedPerTick * (GAME_LOOP_RATE / 1000.0);
                 // Clamp to map boundaries during replay
                 replayedX = Math.max(selfData.radius, Math.min(mapWidth - selfData.radius, replayedX));
                 replayedY = Math.max(selfData.radius, Math.min(mapHeight - selfData.radius, replayedY));
            }
       });

      // The result of the replay is our new predicted state
      predictedState.x = replayedX;
      predictedState.y = replayedY;
}


function handleOtherPlayerState(playerData, serverTime) {
    const renderTime = Date.now() - INTERPOLATION_DELAY; // Target time to render

    if (!players.has(playerData.id)) {
        // New player seen
        players.set(playerData.id, {
            data: playerData,
            interpBuffer: [{ timestamp: serverTime, x: playerData.x, y: playerData.y }],
            renderX: playerData.x, // Start rendering at initial position
            renderY: playerData.y
        });
         console.log(`New player ${playerData.name} (${playerData.id}) detected.`);
    } else {
        // Existing player - add state to buffer
        const playerState = players.get(playerData.id);
        playerState.data = playerData; // Update latest data (for UI, etc.)

        // Add to interpolation buffer, keeping it sorted by time
        playerState.interpBuffer.push({ timestamp: serverTime, x: playerData.x, y: playerData.y });

        // Remove old states from buffer (older than needed for interpolation)
        while (playerState.interpBuffer.length > 2 && playerState.interpBuffer[1].timestamp < renderTime) {
            playerState.interpBuffer.shift();
        }
         // console.log(`Player ${playerData.id} buffer size: ${playerState.interpBuffer.length}`);
    }
}

function sendInputToServer() {
    // Add check: Only send if game loop is running and we have selfId
    if (!isGameLoopRunning || !ws || ws.readyState !== WebSocket.OPEN || !selfId || predictedState.isDead) {
        if (predictedState.isDead) {
            inputState = { up: false, down: false, left: false, right: false, attack: false, mouseX: 0, mouseY: 0 };
        }
        return;
    }

    // Determine aiming coordinates (World Space)
    let aimX, aimY;
    if (isTouchDevice && joystickActive) {
        aimX = predictedState.x + aimFromJoystick.x * 100;
        aimY = predictedState.y + aimFromJoystick.y * 100;
    } else {
        // Use camera's *target* position for more responsive aiming with smoothed camera
        aimX = camera.targetX + (mouseScreenX - canvasHalfWidth);
        aimY = camera.targetY + (mouseScreenY - canvasHalfHeight);
    }

    inputSequenceNumber++;
    const currentInput = {
        ...inputState,
        mouseX: aimX,
        mouseY: aimY,
        seq: inputSequenceNumber
    };

    // Store for prediction reconciliation
    inputHistory.push({ seq: inputSequenceNumber, input: { ...currentInput } }); // Store a copy
    // Keep history buffer reasonably sized
    if (inputHistory.length > 60) { // Keep ~2 seconds of history (at 30 inputs/sec)
        inputHistory.shift();
    }

    ws.send(JSON.stringify({ type: 'input', input: currentInput }));
    inputState.attack = false;
}

// =============================================================================
// INPUT HANDLING (Keyboard, Mouse, Touch)
// =============================================================================

function setupInputListeners() {
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
    canvas.addEventListener('mouseup', (e) => {
         // if (e.button === 0) inputState.attack = false; // Reset on mouse up if needed
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Prevent right-click menu
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
     attackButton.addEventListener('touchend', (e) => {
          e.preventDefault();
          // inputState.attack = false; // Attack resets after sendInput
     }, { passive: false });
}

// --- Joystick Logic ---
function handleJoystickStart(e) {
    e.preventDefault();
    if (level2SelectionScreen.style.display !== 'none' || e.touches.length > 1) return; // Ignore if choosing class or multi-touch on joystick

    const touch = e.changedTouches[0];
    if (!touch) return;

    joystickActive = true;
    touchIdentifier = touch.identifier;
    const rect = joystickArea.getBoundingClientRect();
    joystickStartX = rect.left + joystickRadius; // Center X
    joystickStartY = rect.top + joystickRadius;  // Center Y
    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickVisuals();
    updateInputFromJoystick(); // Update input state immediately
}

function handleJoystickMove(e) {
    e.preventDefault();
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;

    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return; // Not our tracked touch

    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickVisuals();
    updateInputFromJoystick();
}

function handleJoystickEnd(e) {
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return; // Not our tracked touch ending

    resetJoystick();
}

function updateJoystickVisuals() {
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    let thumbX = dx;
    let thumbY = dy;

    if (distance > maxJoystickDist) {
        const scale = maxJoystickDist / distance;
        thumbX = dx * scale;
        thumbY = dy * scale;
    }

    // Position thumb relative to joystick center
    joystickThumb.style.transform = `translate(${thumbX}px, ${thumbY}px)`;
}

function updateInputFromJoystick() {
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const normalizedDist = Math.min(1, distance / maxJoystickDist); // 0 to 1

    if (normalizedDist < JOYSTICK_DEAD_ZONE) {
        // Inside dead zone - stop movement, keep last aim direction?
        inputState.up = false;
        inputState.down = false;
        inputState.left = false;
        inputState.right = false;
        // Don't reset aimFromJoystick here, keep last direction
        return;
    }

    // Normalize the direction vector outside the dead zone
    const angle = Math.atan2(dy, dx);
    const effectiveDx = Math.cos(angle);
    const effectiveDy = Math.sin(angle);

     // Store normalized aim direction
     aimFromJoystick.x = effectiveDx;
     aimFromJoystick.y = effectiveDy;

    // Determine movement based on angle (more precise zones)
    const pi = Math.PI;
    inputState.up = angle > -pi * 0.875 && angle < -pi * 0.125;
    inputState.down = angle > pi * 0.125 && angle < pi * 0.875;
    inputState.left = angle > pi * 0.625 || angle < -pi * 0.625;
    inputState.right = angle > -pi * 0.375 && angle < pi * 0.375;

     // Diagonal checks (optional, improves diagonal feel)
     if (Math.abs(effectiveDx) > 0.6 && Math.abs(effectiveDy) > 0.6) {
          inputState.up = effectiveDy < 0;
          inputState.down = effectiveDy > 0;
          inputState.left = effectiveDx < 0;
          inputState.right = effectiveDx > 0;
     }
}

function resetJoystick() {
    joystickActive = false;
    touchIdentifier = null;
    joystickThumb.style.transform = `translate(0px, 0px)`; // Reset thumb position
    inputState.up = false;
    inputState.down = false;
    inputState.left = false;
    inputState.right = false;
    // Don't reset aimFromJoystick, player might want to shoot in last direction
}

// =============================================================================
// LEVEL 2 SELECTION
// =============================================================================

function showLevel2Selection() {
    const player = players.get(selfId)?.data; // Get latest data
    if (!player) return;

    level2OptionsDiv.innerHTML = ''; // Clear previous

    let choices = [];
    // Determine choices based on race (MUST match server logic)
     switch (player.race) {
         case 'human': case 'elf': case 'gnome':
             choices = [{ id: 'warrior', name: 'Warrior', desc: '+HP, Melee Dmg' }, { id: 'mage', name: 'Mage', desc: 'Ranged Attack' }]; break;
         case 'vampire':
             choices = [{ id: 'lord', name: 'Lord Vampire', desc: 'High Lifesteal, +HP' }, { id: 'higher', name: 'Higher Vampire', desc: '+Speed, +Atk Speed' }]; break;
         case 'goblin':
             choices = [{ id: 'king', name: 'Goblin King', desc: '++HP, Okay Dmg' }, { id: 'hobgoblin', name: 'Hobgoblin', desc: '+HP, High Melee Dmg, -Speed' }]; break;
     }

    choices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = `${choice.name} (${choice.desc})`;
        button.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'selectClass', choice: choice.id }));
                // Hide immediately for responsiveness, server confirms later
                level2SelectionScreen.style.display = 'none';
            }
        };
        level2OptionsDiv.appendChild(button);
    });

    level2SelectionScreen.style.display = 'block';
}

// =============================================================================
// CLIENT-SIDE MOVEMENT (PREDICTION)
// =============================================================================

function updateSelfPlayerPrediction(deltaTime) {
    if (!selfId || predictedState.isDead) return;

    const selfData = players.get(selfId)?.data; // Get latest authoritative data if available
    const radius = selfData?.radius || 15; // Use default if data missing
    // Determine current speed based on latest data or base speed
     const playerSpeed = selfData ? getPlayerCurrentSpeed(selfData) : PLAYER_SPEED;
     const speedPerSecond = playerSpeed * BASE_TICK_RATE; // Speed units per second


    let moveX = 0;
    let moveY = 0;
    if (inputState.up) moveY -= 1;
    if (inputState.down) moveY += 1;
    if (inputState.left) moveX -= 1;
    if (inputState.right) moveX += 1;

    const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
    if (magnitude > 0) {
        const dx = (moveX / magnitude) * speedPerSecond * deltaTime;
        const dy = (moveY / magnitude) * speedPerSecond * deltaTime;
        predictedState.x += dx;
        predictedState.y += dy;
    }

    // Clamp predicted position to map boundaries
    predictedState.x = Math.max(radius, Math.min(mapWidth - radius, predictedState.x));
    predictedState.y = Math.max(radius, Math.min(mapHeight - radius, predictedState.y));
}

// Helper to get current speed based on player data (race, class etc)
// THIS IS A SIMPLIFIED GUESS - Server holds the true speed value
// Ideally, server would send the speed stat in player data
function getPlayerCurrentSpeed(playerData) {
     // Rough estimate based on class/race, MUST be kept in sync with server logic for accurate prediction
     let baseSpeed = PLAYER_SPEED;
     // Apply race modifiers
     if (playerData.race === 'elf') baseSpeed *= 1.1;
     if (playerData.race === 'goblin') baseSpeed *= 1.05;

     // Apply class/mutation modifiers
     if (playerData.classOrMutation === 'higher') baseSpeed *= 1.2;
     if (playerData.classOrMutation === 'hobgoblin') baseSpeed *= 0.85;

     return baseSpeed;
}


// =============================================================================
// GAME LOOP & RENDERING
// =============================================================================

function startGameLoop() {
    if (isGameLoopRunning) {
        console.warn("Game loop start requested, but already running.");
        return;
    }
    if (!selfId) {
         console.error("Cannot start game loop: selfId not set.");
         return;
    }
    console.log("Starting game loop...");
    isGameLoopRunning = true;
    lastFrameTime = performance.now();
    gameLoopId = requestAnimationFrame(gameLoop);
}

function stopGameLoop() {
    if (gameLoopId) {
        cancelAnimationFrame(gameLoopId);
        gameLoopId = null;
    }
    // Important: Set flag to false *after* cancelling frame
    isGameLoopRunning = false;
    console.log("Game loop stopped.");
}

// Reset client state completely to return to start screen cleanly
function resetClientState() {
     stopGameLoop(); // Ensure loop is stopped
     selfId = null;
     players.clear();
     orbs = [];
     projectiles = [];
     inputHistory = [];
     inputSequenceNumber = 0;
     predictedState = { x: -1000, y: -1000, isDead: true, radius: PLAYER_RADIUS };
     camera = { x: -1000, y: -1000, targetX: -1000, targetY: -1000, speed: 0.1 };
     level2SelectionScreen.style.display = 'none';
     touchControls.style.display = 'none';
     canvas.style.display = 'none';
     startScreen.style.display = 'block'; // Show start screen
}

function gameLoop(currentTime) {
    // Primary safeguard: If loop somehow runs before ready, exit.
    if (!isGameLoopRunning || !selfId || !players.has(selfId)) {
         console.warn("Game loop running prematurely, skipping frame.");
         // Request next frame ONLY if the flag indicates it should be running
         if (isGameLoopRunning) {
              gameLoopId = requestAnimationFrame(gameLoop);
         }
         return;
    }

    const deltaTime = Math.min(0.05, (currentTime - lastFrameTime) / 1000.0); // Cap delta time at 50ms (20fps min)
    lastFrameTime = currentTime;

    // --- Update ---
    updateSelfPlayerPrediction(deltaTime);
    updateCamera(deltaTime); // Uses PREDICTED state now
    updateOtherPlayerInterpolation(currentTime);

    // --- Rendering ---
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply camera transform (using smoothed camera position)
    ctx.save();
    ctx.translate(canvasHalfWidth - camera.x, canvasHalfHeight - camera.y);

    // Get current view bounds based on SMOOTHED camera
    const viewBounds = getCameraViewBounds();

    // Draw world elements with culling
    drawMapBackground(viewBounds); // Pass bounds for optimization
    drawOrbs(orbs, viewBounds);
    drawProjectiles(projectiles, viewBounds);
    drawPlayers(viewBounds); // Pass bounds for culling

    ctx.restore();

    // Draw UI elements (fixed on screen)
    drawUI();

    // Draw Level 2 Selection Overlay if active
    if (level2SelectionScreen.style.display !== 'none') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; // Darken background
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Request next frame (only if loop should continue)
    if (isGameLoopRunning) {
        gameLoopId = requestAnimationFrame(gameLoop);
    }
}

function updateCamera(deltaTime) {
     // Camera smoothly follows the *predicted* player position
     // Ensure predictedState exists and has valid coords
     if (typeof predictedState.x === 'number' && typeof predictedState.y === 'number') {
          camera.targetX = predictedState.x;
          camera.targetY = predictedState.y;

          // Use lerp for smooth camera following
          camera.x = lerp(camera.x, camera.targetX, camera.speed);
          camera.y = lerp(camera.y, camera.targetY, camera.speed);

          // Snap close to target to prevent drifting
          if (Math.abs(camera.x - camera.targetX) < 0.5) camera.x = camera.targetX;
          if (Math.abs(camera.y - camera.targetY) < 0.5) camera.y = camera.targetY;
     }
}

function updateOtherPlayerInterpolation(currentTime) {
     const renderTime = currentTime - INTERPOLATION_DELAY;

     players.forEach((playerState, id) => {
         if (id === selfId) return; // Skip self

         const buffer = playerState.interpBuffer;
         if (buffer.length < 2) {
              // Not enough data to interpolate, just use latest known position
              if (buffer.length === 1) {
                   playerState.renderX = buffer[0].x;
                   playerState.renderY = buffer[0].y;
              } else if (playerState.data) { // Fallback to last data received
                   playerState.renderX = playerState.data.x;
                   playerState.renderY = playerState.data.y;
              }
             return;
         }

         // Find two buffer entries surrounding the renderTime
         let state1 = null;
         let state2 = null;
         for (let i = buffer.length - 1; i >= 0; i--) {
             if (buffer[i].timestamp <= renderTime) {
                 state1 = buffer[i];
                 state2 = buffer[i + 1] || state1; // Use next state or duplicate if at end
                 break;
             }
         }

          if (!state1) { // Render time is before the oldest state in buffer, extrapolate? Or clamp.
              state1 = buffer[0];
              state2 = buffer[1] || state1;
              // console.warn(`Render time (${renderTime.toFixed(0)}) is before oldest state for player ${id}. Clamping.`);
          }


         // Calculate interpolation factor (alpha)
         const timeDiff = state2.timestamp - state1.timestamp;
         const alpha = timeDiff > 0 ? Math.max(0, Math.min(1, (renderTime - state1.timestamp) / timeDiff)) : 1;

         // Interpolate position
         playerState.renderX = lerp(state1.x, state2.x, alpha);
         playerState.renderY = lerp(state1.y, state2.y, alpha);

         // Debug: Log interpolation results occasionally
         // if (Math.random() < 0.01) {
         //     console.log(`Interpolating ${id}: t1=${state1.timestamp}, t2=${state2.timestamp}, renderT=${renderTime.toFixed(0)}, alpha=${alpha.toFixed(2)} -> (${playerState.renderX.toFixed(1)}, ${playerState.renderY.toFixed(1)})`);
         // }
     });
 }


// --- Drawing Functions ---

function drawMapBackground(viewBounds) { // Receive viewBounds
    // Simple boundary box (always draw if map is small relative to view?)
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);

    // Optimized grid drawing
    const gridSize = 100;
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    // Calculate start/end based on viewBounds
    const startX = Math.floor(viewBounds.left / gridSize) * gridSize;
    const endX = Math.ceil(viewBounds.right / gridSize) * gridSize;
    const startY = Math.floor(viewBounds.top / gridSize) * gridSize;
    const endY = Math.ceil(viewBounds.bottom / gridSize) * gridSize;

    ctx.beginPath();
    // Draw only lines that intersect the view
    for (let x = startX; x <= endX; x += gridSize) {
        if (x >= 0 && x <= mapWidth) { // Clamp line drawing to map boundaries
             ctx.moveTo(x, Math.max(0, viewBounds.top));
             ctx.lineTo(x, Math.min(mapHeight, viewBounds.bottom));
        }
    }
    for (let y = startY; y <= endY; y += gridSize) {
         if (y >= 0 && y <= mapHeight) {
             ctx.moveTo(Math.max(0, viewBounds.left), y);
             ctx.lineTo(Math.min(mapWidth, viewBounds.right), y);
         }
    }
    ctx.stroke();
}

function drawOrbs(orbsToDraw, viewBounds) { // Receive viewBounds
    ctx.fillStyle = '#f0e370';
    orbsToDraw.forEach(orb => {
        // Cull check: Use orb radius as margin
        if (isPointInBounds(orb.x, orb.y, viewBounds, orb.radius)) {
            ctx.beginPath();
            ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function drawProjectiles(projectilesToDraw, viewBounds) { // Receive viewBounds
    projectilesToDraw.forEach(proj => {
         // Cull check: Use projectile radius
        if (isPointInBounds(proj.x, proj.y, viewBounds, proj.radius)) {
            ctx.fillStyle = proj.color || '#ffffff';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function drawPlayers(viewBounds) { // Receive viewBounds
    players.forEach((playerState, id) => {
        const data = playerState.data;
        if (!data) return; // Skip if no data yet

        let drawX, drawY, radius;
        let isSelf = (id === selfId);

        if (isSelf) {
             if (predictedState.isDead) return; // Don't draw self if dead
             drawX = predictedState.x;
             drawY = predictedState.y;
             radius = predictedState.radius; // Use radius from predicted state (updated from server)
        } else {
             if (data.isDead) return; // Don't draw others if dead
             drawX = playerState.renderX;
             drawY = playerState.renderY;
             radius = data.radius;
             if (isNaN(drawX) || isNaN(drawY)) { // Fallback if interpolation failed
                  drawX = data.x; drawY = data.y;
             }
        }

         // Culling: Check if the *center* of the player is within bounds (+radius margin)
         if (!isPointInBounds(drawX, drawY, viewBounds, radius)) {
             return; // Skip drawing entirely if center is too far off-screen
         }

         // Draw Player Circle
         ctx.fillStyle = data.color || '#cccccc';
         ctx.strokeStyle = '#000000';
         ctx.lineWidth = 2;
         ctx.beginPath();
         ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
         ctx.fill();
         ctx.stroke();

         // Draw Name & Level (with text shadow)
         ctx.fillStyle = '#ffffff';
         ctx.textAlign = 'center';
         ctx.font = 'bold 12px sans-serif';
         ctx.shadowColor = 'black'; ctx.shadowBlur = 3; // Slightly stronger shadow
         ctx.fillText(`${data.name} [${data.level}]`, drawX, drawY - radius - 15);
         ctx.shadowBlur = 0; // Reset shadow

         // Draw HP Bar
         drawHpBar(ctx, drawX, drawY, radius, data.hp, data.maxHp);
    });
}

function drawHpBar(context, x, y, ownerRadius, hp, maxHp) {
    const hpBarWidth = ownerRadius * 2.5;
    const hpBarHeight = 6;
    const hpBarX = x - hpBarWidth / 2;
    const hpBarY = y - ownerRadius - 10; // Position above name
    const hpPercent = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;

    context.fillStyle = '#555'; // Background
    context.fillRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
    context.fillStyle = hpPercent > 0.6 ? '#4CAF50' : (hpPercent > 0.3 ? '#ffc107' : '#f44336'); // Green/Yellow/Red
    context.fillRect(hpBarX, hpBarY, hpBarWidth * hpPercent, hpBarHeight);
    context.strokeStyle = '#333';
    context.lineWidth = 1;
    context.strokeRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
}


function drawUI() {
    const selfData = players.get(selfId)?.data;
    if (!selfData) return;

     // Draw XP Bar only if level 1
     if (selfData.level === 1) {
          const xpBarWidth = Math.min(400, canvas.width * 0.5);
          const xpBarHeight = 18;
          const xpBarX = (canvas.width - xpBarWidth) / 2;
          const xpBarY = canvas.height - xpBarHeight - 20;
          const xpProgress = Math.max(0, selfData.xp); // XP is reset on death/level? Assume starts from 0 for level 1
          const xpNeeded = XP_TO_LEVEL_2;
          const xpPercent = Math.min(1, xpNeeded > 0 ? xpProgress / xpNeeded : 1);

         // Don't draw if already full (avoids flashing when hitting level 2)
         if (xpPercent < 1) {
              ctx.fillStyle = 'rgba(85, 85, 85, 0.7)';
              ctx.fillRect(xpBarX, xpBarY, xpBarWidth, xpBarHeight);
              ctx.fillStyle = '#f0e370';
              ctx.fillRect(xpBarX, xpBarY, xpBarWidth * xpPercent, xpBarHeight);
              // XP Text
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.font = 'bold 12px sans-serif';
              const xpText = `${xpProgress} / ${xpNeeded} XP`;
              ctx.shadowColor = 'black'; ctx.shadowBlur = 2;
              ctx.fillText(xpText, canvasHalfWidth, xpBarY + xpBarHeight / 1.5);
              ctx.shadowBlur = 0;
         }
     }

     // Draw Level (always show)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'center';
     ctx.font = 'bold 16px sans-serif';
     ctx.shadowColor = 'black'; ctx.shadowBlur = 3;
     ctx.fillText(`Level: ${selfData.level}`, canvasHalfWidth, canvas.height - 50);
     ctx.shadowBlur = 0;

     // Draw HP Circle (Bottom Left - example)
     const uiHpX = 80;
     const uiHpY = canvas.height - 80;
     const uiHpRadius = 50;
     const hpPercent = selfData.maxHp > 0 ? Math.max(0, selfData.hp / selfData.maxHp) : 0;
     const angle = hpPercent * Math.PI * 2;

     ctx.lineWidth = 8;
     // Background circle
     ctx.strokeStyle = 'rgba(80, 80, 80, 0.7)';
     ctx.beginPath();
     ctx.arc(uiHpX, uiHpY, uiHpRadius, 0, Math.PI * 2);
     ctx.stroke();
     // HP Fill arc
     ctx.strokeStyle = hpPercent > 0.6 ? '#4CAF50' : (hpPercent > 0.3 ? '#ffc107' : '#f44336');
     ctx.beginPath();
     ctx.arc(uiHpX, uiHpY, uiHpRadius, -Math.PI / 2, -Math.PI / 2 + angle); // Start from top
     ctx.stroke();
     // HP Text
     ctx.fillStyle = '#ffffff';
     ctx.font = 'bold 18px sans-serif';
     ctx.textAlign = 'center';
     ctx.shadowColor = 'black'; ctx.shadowBlur = 2;
     ctx.fillText(selfData.hp, uiHpX, uiHpY + 6); // Adjust vertical alignment
     ctx.shadowBlur = 0;


     // Draw Kill Count (Top Right)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'right';
     ctx.font = '16px sans-serif';
     ctx.shadowColor = 'black'; ctx.shadowBlur = 3;
     ctx.fillText(`Kills: ${selfData.killCount || 0}`, canvas.width - 20, 30);
     ctx.shadowBlur = 0;

     // Draw crosshair if not using touch
      if (!isTouchDevice) {
           ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
           ctx.lineWidth = 1;
           ctx.beginPath();
           ctx.moveTo(mouseScreenX - 8, mouseScreenY); ctx.lineTo(mouseScreenX + 8, mouseScreenY);
           ctx.moveTo(mouseScreenX, mouseScreenY - 8); ctx.lineTo(mouseScreenX, mouseScreenY + 8);
           ctx.stroke();
      }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function lerp(start, end, amount) {
    return start + (end - start) * amount;
}

function getCameraViewBounds() {
     // Use cached half-dimensions
     return {
         left: camera.x - canvasHalfWidth,
         right: camera.x + canvasHalfWidth,
         top: camera.y - canvasHalfHeight,
         bottom: camera.y + canvasHalfHeight
     };
}

function isPointInBounds(x, y, bounds, margin = 0) {
     // Simplified check
     return x + margin >= bounds.left &&
            x - margin <= bounds.right &&
            y + margin >= bounds.top &&
            y - margin <= bounds.bottom;
}

// --- Start the application ---
init();
