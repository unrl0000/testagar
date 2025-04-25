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
let serverTimeOffset = 0; // For potential future interpolation/prediction

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
let mouseScreenX = window.innerWidth / 2;
let mouseScreenY = window.innerHeight / 2;

// --- Camera State ---
let camera = {
    x: 0,
    y: 0,
    zoom: 1.0 // Future feature?
};

// --- Touch Control State ---
let touchIdentifier = null;
let joystickActive = false;
let joystickStartX = 0;
let joystickStartY = 0;
let joystickCurrentX = 0;
let joystickCurrentY = 0;
const JOYSTICK_RADIUS = joystickArea.offsetWidth / 2;
const THUMB_RADIUS = joystickThumb.offsetWidth / 2;
const MAX_JOYSTICK_DIST = JOYSTICK_RADIUS - THUMB_RADIUS;

// --- Game Setup ---
function init() {
    setupStartScreen();
    setupInputListeners();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    detectTouchDevice();
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

function detectTouchDevice() {
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (isTouch) {
        touchControls.style.display = 'block'; // Show touch controls
        setupTouchControls();
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
        // Start sending input updates
        setInterval(sendInput, 1000 / 30); // Send input ~30 times/sec
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'welcome':
                    selfId = message.playerId;
                    mapWidth = message.mapWidth;
                    mapHeight = message.mapHeight;
                    console.log(`Joined game with ID: ${selfId}`);
                    requestAnimationFrame(gameLoop); // Start rendering loop
                    break;
                case 'gameState':
                    // Directly update game state. Could add interpolation later.
                    gameState = message;
                    break;
                 case 'levelUpReady':
                     console.log("Level up ready! Showing selection.");
                     showLevel2Selection();
                     break;
                 case 'classSelected':
                     console.log("Class/Mutation confirmed by server.");
                      // Update self player data if necessary (already done via gameState generally)
                     level2SelectionScreen.style.display = 'none'; // Hide selection
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
        // Maybe try to reconnect?
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed.');
        showError('Disconnected from server. Please refresh.');
        // Stop game loop? Show start screen?
        cancelAnimationFrame(gameLoop); // Stop rendering
        startScreen.style.display = 'block';
        canvas.style.display = 'none';
         touchControls.style.display = 'none';
         level2SelectionScreen.style.display = 'none';
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
        mouseScreenX = e.clientX;
        mouseScreenY = e.clientY;
    });

    canvas.addEventListener('mousedown', (e) => {
         if (level2SelectionScreen.style.display !== 'none') return;
        if (e.button === 0) { // Left mouse button
            inputState.attack = true;
        }
    });

     // Prevent continuous attack on mouse down for now, trigger per click
    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) {
            // inputState.attack = false; // If you want attack on hold, remove this line
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
         inputState.attack = true;
     }, { passive: false });

     attackButton.addEventListener('touchend', (e) => {
          e.preventDefault();
         // inputState.attack = false; // If attack on hold is desired
     }, { passive: false });

     // Aiming with touch - use center of screen or last known "tap" location?
     // For simplicity, let's make touch aim towards center initially, or handle tap-to-aim later
     // We will use mouseX/mouseY derived from joystick for aiming if active, otherwise center?
}

function handleJoystickStart(e) {
    e.preventDefault();
    if (level2SelectionScreen.style.display !== 'none') return;
    joystickActive = true;
    const touch = e.changedTouches[0];
    touchIdentifier = touch.identifier;
    const rect = joystickArea.getBoundingClientRect();
    joystickStartX = rect.left + JOYSTICK_RADIUS;
    joystickStartY = rect.top + JOYSTICK_RADIUS;
    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickThumb();
}

function handleJoystickMove(e) {
    e.preventDefault();
    if (!joystickActive || level2SelectionScreen.style.display !== 'none') return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
    if (!touch) return;

    joystickCurrentX = touch.clientX;
    joystickCurrentY = touch.clientY;
    updateJoystickThumb();
    updateInputFromJoystick();
}

function handleJoystickEnd(e) {
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchIdentifier);
     if (!touch) { // Might be a different touch ending
         // Check if ALL touches ended on the joystick, if so reset
         let stillTouchingJoystick = false;
         for(let i=0; i<e.touches.length; i++){
             const t = e.touches[i];
             const rect = joystickArea.getBoundingClientRect();
             if(t.clientX >= rect.left && t.clientX <= rect.right && t.clientY >= rect.top && t.clientY <= rect.bottom) {
                 stillTouchingJoystick = true;
                 break;
             }
         }
         if (!stillTouchingJoystick) {
             resetJoystick();
         }
         return;
     }

    resetJoystick();
}
function resetJoystick(){
     joystickActive = false;
     touchIdentifier = null;
     joystickThumb.style.transform = `translate(0px, 0px)`;
     inputState.up = false;
     inputState.down = false;
     inputState.left = false;
     inputState.right = false;
     // Reset aiming direction? Or keep last known?
     // inputState.mouseX = canvas.width / 2 + camera.x; // Aim center world
     // inputState.mouseY = canvas.height / 2 + camera.y;
}

function updateJoystickThumb() {
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    let clampedX = dx;
    let clampedY = dy;

    if (distance > MAX_JOYSTICK_DIST) {
        const scale = MAX_JOYSTICK_DIST / distance;
        clampedX = dx * scale;
        clampedY = dy * scale;
    }

    joystickThumb.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
}

function updateInputFromJoystick() {
    let dx = joystickCurrentX - joystickStartX;
    let dy = joystickCurrentY - joystickStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const threshold = JOYSTICK_RADIUS * 0.1; // Minimum movement to register

    if (distance < threshold) {
        inputState.up = false;
        inputState.down = false;
        inputState.left = false;
        inputState.right = false;
        return;
    }

    const angle = Math.atan2(dy, dx);

    // Update movement direction based on angle
    inputState.up = (angle > -Math.PI * 0.875 && angle < -Math.PI * 0.125);
    inputState.down = (angle > Math.PI * 0.125 && angle < Math.PI * 0.875);
    inputState.left = (angle > Math.PI * 0.625 || angle < -Math.PI * 0.625);
    inputState.right = (angle > -Math.PI * 0.375 && angle < Math.PI * 0.375);

     // Update aiming direction based on joystick
     // Convert joystick delta to world coordinates for aiming
     const worldAimX = camera.x + dx * 5; // Scale dx for aiming "reach"
     const worldAimY = camera.y + dy * 5; // Scale dy for aiming "reach"
     inputState.mouseX = worldAimX;
     inputState.mouseY = worldAimY;
}


function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId) return;

    // If not using touch joystick, calculate mouse world coordinates
    if (!joystickActive) {
        const selfPlayer = gameState.players.find(p => p.id === selfId);
        if (selfPlayer) {
            const canvasCenterX = canvas.width / 2;
            const canvasCenterY = canvas.height / 2;
            inputState.mouseX = selfPlayer.x + (mouseScreenX - canvasCenterX); // Convert screen mouse to world coords
            inputState.mouseY = selfPlayer.y + (mouseScreenY - canvasCenterY);
        }
    }
     // else: mouseX/mouseY are updated by joystick handler

    ws.send(JSON.stringify({ type: 'input', input: inputState }));

    // Reset attack state after sending if it's a per-click trigger
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
                { id: 'king', name: 'Goblin King', desc: '++HP, Okay Dmg' }, // Desc simplified
                { id: 'hobgoblin', name: 'Hobgoblin', desc: '+HP, High Melee Dmg, -Speed' }
            ];
            break;
    }

    choices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = `${choice.name} (${choice.desc})`;
        button.onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'selectClass', choice: choice.id }));
                 // Optimistically hide, server confirmation will finalize
                 //level2SelectionScreen.style.display = 'none';
            }
        };
        level2OptionsDiv.appendChild(button);
    });

    level2SelectionScreen.style.display = 'block';
}


// --- Rendering ---
function gameLoop(timestamp) {
    if (!selfId || !ws || ws.readyState !== WebSocket.OPEN) {
        // Don't run loop if not connected or initialized
        // console.log("Game loop halted - not connected or initialized.");
        return;
    }

    const selfPlayer = gameState.players.find(p => p.id === selfId);

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update camera to follow player
    if (selfPlayer) {
        camera.x = selfPlayer.x;
        camera.y = selfPlayer.y;
    }

    // Translate canvas to camera position
    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    // Draw game elements (world relative)
    drawMapBackground(); // Draw simple grid or boundaries
    drawOrbs(gameState.orbs);
    drawProjectiles(gameState.projectiles);
    drawPlayers(gameState.players);

    // Restore context for UI elements
    ctx.restore();

    // Draw UI elements (screen relative)
    if (selfPlayer) {
        drawUI(selfPlayer);
    }

    // Request next frame
    requestAnimationFrame(gameLoop);
}

function drawMapBackground() {
    // Simple boundary box
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, mapWidth, mapHeight);

    // Optional: Simple grid
    const gridSize = 100;
    ctx.strokeStyle = '#444';
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

function drawOrbs(orbs) {
    ctx.fillStyle = '#f0e370'; // Orb color
    orbs.forEach(orb => {
         if(isElementVisible(orb, orb.radius * 2)) {
              ctx.beginPath();
              ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
              ctx.fill();
         }
    });
}

function drawProjectiles(projectiles) {
    projectiles.forEach(proj => {
          if(isElementVisible(proj, proj.radius * 2)) {
            ctx.fillStyle = proj.color || '#ffffff';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function drawPlayers(players) {
    players.forEach(player => {
        if (player.isDead) return; // Don't draw dead players for now

        if(isElementVisible(player, player.radius * 4)) { // Wider check for name/hp bar
            // Draw Player Circle
            ctx.fillStyle = player.color || '#cccccc';
            ctx.strokeStyle = '#000000'; // Black outline
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

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
        }
    });
}

function drawUI(selfPlayer) {
    // Draw XP Bar (Bottom Center)
    const xpBarWidth = canvas.width * 0.4;
    const xpBarHeight = 15;
    const xpBarX = (canvas.width - xpBarWidth) / 2;
    const xpBarY = canvas.height - xpBarHeight - 15; // 15px from bottom

    let xpForNextLevel = Infinity; // Default for max level
    let xpCurrentLevelBase = 0;

    if (selfPlayer.level === 1) {
        xpForNextLevel = 100; // XP_TO_LEVEL_2 should match server
        xpCurrentLevelBase = 0;
    }
     // Add logic here if higher levels are implemented

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
    const xpText = xpNeeded > 0 ? `${xpProgress} / ${xpNeeded} XP` : `Level ${selfPlayer.level} (MAX)`;
    ctx.fillText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.5;
    ctx.strokeText(xpText, canvas.width / 2, xpBarY + xpBarHeight / 1.5);


     // Draw Level (above XP bar)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'center';
     ctx.font = 'bold 16px sans-serif';
     ctx.fillText(`Level: ${selfPlayer.level}`, canvas.width / 2, xpBarY - 8);


     // Optional: Display Kill Count (Top Right)
     ctx.fillStyle = '#ffffff';
     ctx.textAlign = 'right';
     ctx.font = '14px sans-serif';
     ctx.fillText(`Kills: ${selfPlayer.killCount || 0}`, canvas.width - 15, 25);

     // Optional: Draw simple crosshair?
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mouseScreenX - 10, mouseScreenY);
      ctx.lineTo(mouseScreenX + 10, mouseScreenY);
      ctx.moveTo(mouseScreenX, mouseScreenY - 10);
      ctx.lineTo(mouseScreenX, mouseScreenY + 10);
      ctx.stroke();
}


// --- Utility ---
// Basic culling check (is the center of the element within the viewport + margin?)
function isElementVisible(element, margin = 100) {
     const screenX = element.x - camera.x + canvas.width / 2;
     const screenY = element.y - camera.y + canvas.height / 2;

     return screenX > -margin &&
            screenX < canvas.width + margin &&
            screenY > -margin &&
            screenY < canvas.height + margin;
}


// --- Start the application ---
init();
