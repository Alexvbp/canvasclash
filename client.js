// --- Constants and Configuration ---
const CANVAS_WIDTH = 100; // Logical pixels
const CANVAS_HEIGHT = 100; // Logical pixels
const PIXEL_SIZE = 5; // Display size of each logical pixel
const COOLDOWN_TIME = 1000; // 1 second in milliseconds

// --- DOM Elements ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const playerColorEl = document.getElementById('player-color');
const timerEl = document.getElementById('timer');
const scoreEl = document.getElementById('score');
const cooldownEl = document.getElementById('cooldown');
const scoreListEl = document.getElementById('score-list');

// --- State ---
let webSocket = null;
let playerColor = '#FFFFFF'; // Default/unset color
let playerId = null; // Unique ID for this client session (optional but good practice)
let currentScore = 0;
let isOnCooldown = false;
let lastPlacementTime = 0;
let gameRoomId = null; // The ID of the Durable Object room we are in

// --- Canvas Setup ---
canvas.width = CANVAS_WIDTH * PIXEL_SIZE;
canvas.height = CANVAS_HEIGHT * PIXEL_SIZE;
ctx.imageSmoothingEnabled = false; // Ensure crisp pixels

// --- WebSocket Connection ---
function connectWebSocket() {
    statusEl.textContent = 'Connecting to matchmaking...';
    // In a real deployment, use wss:// for secure connections
    // The initial connection goes to the main worker, which will then redirect
    // us to the specific Durable Object WebSocket.
    const wsUrl = `ws://${window.location.host}/websocket`; // Connect to the main worker endpoint

    console.log(`Attempting to connect to WebSocket at: ${wsUrl}`);
    webSocket = new WebSocket(wsUrl);

    webSocket.onopen = () => {
        console.log('WebSocket connection established with matchmaking.');
        statusEl.textContent = 'Waiting for game...';
        // The server (matchmaking worker) will send us the room details
    };

    webSocket.onmessage = (event) => {
        console.log('WebSocket message received:', event.data);
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    };

    webSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        statusEl.textContent = 'Connection error!';
    };

    webSocket.onclose = (event) => {
        console.log('WebSocket connection closed:', event.code, event.reason);
        statusEl.textContent = `Disconnected: ${event.reason || 'Connection closed'}`;
        webSocket = null;
        // Optional: Implement reconnection logic here
    };
}

// --- WebSocket Message Handling ---
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'assignInfo':
            // Received from matchmaking worker, telling us which room and color
            console.log(`Assigned to room ${message.roomId} with color ${message.color}`);
            gameRoomId = message.roomId;
            playerColor = message.color;
            playerId = message.playerId; // Store our unique ID
            playerColorEl.style.backgroundColor = playerColor;
            statusEl.textContent = `Joined Game Room ${gameRoomId.substring(0, 6)}...`;
            // Note: The actual WebSocket connection might be implicitly handled by the Worker
            // redirecting the initial connection, or we might need to explicitly reconnect
            // to a DO-specific endpoint if the architecture requires it.
            // For now, assume the single connection is routed correctly by the Worker.
            break;
        case 'gameState':
            // Full initial state of the canvas
            console.log('Received initial game state');
            drawCanvas(message.canvasState);
            updateScores(message.scores);
            updateTimer(message.timeLeft);
            statusEl.textContent = 'Game in progress!';
            break;
        case 'pixelUpdate':
            // A single pixel was updated
            console.log(`Pixel update: [${message.x}, ${message.y}] to ${message.color}`);
            drawPixel(message.x, message.y, message.color);
            updateScores(message.scores); // Scores might change with pixel updates
            break;
        case 'timerUpdate':
            updateTimer(message.timeLeft);
            break;
        case 'scoreUpdate':
            updateScores(message.scores);
            break;
        case 'gameOver':
            statusEl.textContent = `Game Over! Winner: ${message.winnerColor || 'Draw'}`;
            // Optionally disable canvas clicking
            canvas.removeEventListener('click', handleCanvasClick);
            break;
        case 'error':
            console.error('Server error:', message.message);
            statusEl.textContent = `Error: ${message.message}`;
            break;
        default:
            console.warn('Unknown WebSocket message type:', message.type);
    }
}

// --- Drawing Functions ---
function drawPixel(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
}

function drawCanvas(canvasState) {
    console.log('Drawing full canvas...');
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
        for (let x = 0; x < CANVAS_WIDTH; x++) {
            drawPixel(x, y, canvasState[y][x] || '#FFFFFF'); // Default to white if null/undefined
        }
    }
    console.log('Canvas drawn.');
}

// --- UI Updates ---
function updateTimer(timeLeftSeconds) {
    if (timeLeftSeconds === null || timeLeftSeconds < 0) {
        timerEl.textContent = '--:--';
        return;
    }
    const minutes = Math.floor(timeLeftSeconds / 60);
    const seconds = timeLeftSeconds % 60;
    timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateScores(scores) {
    scoreListEl.innerHTML = ''; // Clear previous scores
    let playerScore = 0;
    // Sort scores descending for leaderboard
    const sortedScores = Object.entries(scores).sort(([, a], [, b]) => b - a);

    sortedScores.forEach(([color, score]) => {
        const li = document.createElement('li');
        li.textContent = `Score: ${score}`;
        li.style.color = color; // Use player color for text
        li.style.fontWeight = 'bold';
        // Add a color swatch
        const swatch = document.createElement('span');
        swatch.style.display = 'inline-block';
        swatch.style.width = '15px';
        swatch.style.height = '15px';
        swatch.style.backgroundColor = color;
        swatch.style.border = '1px solid #ccc';
        swatch.style.marginRight = '8px';
        swatch.style.verticalAlign = 'middle';
        li.prepend(swatch); // Add swatch before text
        scoreListEl.appendChild(li);

        if (color === playerColor) {
            playerScore = score;
        }
    });
    scoreEl.textContent = playerScore; // Update current player's score display
}

function setCooldownState(active) {
    isOnCooldown = active;
    if (active) {
        cooldownEl.textContent = 'Waiting...';
        cooldownEl.classList.add('active');
        // Set a timer to visually reset the cooldown indicator
        setTimeout(() => {
            // Only reset if it hasn't been reactivated in the meantime
            if (Date.now() - lastPlacementTime >= COOLDOWN_TIME) {
                 setCooldownState(false);
            }
        }, COOLDOWN_TIME - (Date.now() - lastPlacementTime)); // Adjust timer based on actual placement time
    } else {
        cooldownEl.textContent = 'Ready';
        cooldownEl.classList.remove('active');
    }
}

// --- Event Handlers ---
function handleCanvasClick(event) {
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket not connected. Cannot place pixel.');
        statusEl.textContent = 'Error: Not connected!';
        return;
    }

    if (isOnCooldown) {
        console.log('Cooldown active. Cannot place pixel yet.');
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;

    const pixelX = Math.floor(canvasX / PIXEL_SIZE);
    const pixelY = Math.floor(canvasY / PIXEL_SIZE);

    // Basic boundary check
    if (pixelX < 0 || pixelX >= CANVAS_WIDTH || pixelY < 0 || pixelY >= CANVAS_HEIGHT) {
        console.warn('Clicked outside canvas boundaries.');
        return;
    }

    console.log(`Attempting to place pixel at [${pixelX}, ${pixelY}] with color ${playerColor}`);

    // Send pixel placement request to the server (Durable Object)
    const message = {
        type: 'placePixel',
        payload: {
            x: pixelX,
            y: pixelY,
            // Color is implicitly the player's assigned color, managed server-side
        }
    };
    webSocket.send(JSON.stringify(message));

    // Start cooldown
    lastPlacementTime = Date.now();
    setCooldownState(true);
}

// --- Initialization ---
function init() {
    console.log('Initializing Pixel Canvas Clash client...');
    // Set initial canvas background (optional, DO state will overwrite)
    ctx.fillStyle = '#EEEEEE';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    canvas.addEventListener('click', handleCanvasClick);
    connectWebSocket();
}

// --- Start the application ---
init();
