// --- Constants ---
const GAME_DURATION_SECONDS = 5 * 60; // 5 minutes
const CANVAS_WIDTH = 100;
const CANVAS_HEIGHT = 100;
const MAX_PLAYERS_PER_ROOM = 8;
const MIN_PLAYERS_TO_START = 2;
const PLAYER_COLORS = [
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
    '#FF00FF', '#00FFFF', '#FFA500', '#800080' // Red, Lime, Blue, Yellow, Magenta, Cyan, Orange, Purple
];
const COOLDOWN_MS = 1000; // 1 second

// --- Durable Object Class: GameRoom ---
// Each instance of this class manages a single game room.
export class GameRoom {
    constructor(state, env) {
        this.state = state; // Storage API provided by Cloudflare
        this.env = env;     // Environment variables (like bindings)
        this.sessions = []; // Array to hold connected WebSocket sessions { ws: WebSocket, playerId: string, color: string, lastPlacement: number }
        this.canvasState = null; // Will be loaded from storage or initialized
        this.scores = {}; // { color: score }
        this.timerInterval = null;
        this.timeLeft = GAME_DURATION_SECONDS;
        this.gameStarted = false;
        this.gameOver = false;

        // Initialize storage if it's the first time.
        // `blockConcurrencyWhile()` ensures that only one execution context
        // runs this initialization logic, preventing race conditions.
        this.state.blockConcurrencyWhile(async () => {
            await this.loadState();
        });
    }

    async loadState() {
        // Load canvas, scores, timer, etc., from durable storage
        this.canvasState = await this.state.storage.get('canvasState') || this.initializeCanvas();
        this.scores = await this.state.storage.get('scores') || {};
        this.timeLeft = await this.state.storage.get('timeLeft') ?? GAME_DURATION_SECONDS;
        this.gameStarted = await this.state.storage.get('gameStarted') || false;
        this.gameOver = await this.state.storage.get('gameOver') || false;
        // Note: sessions are transient and not stored persistently. They reconnect.
        // We might need to load player metadata if we want persistence across DO restarts.
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] State loaded. GameStarted: ${this.gameStarted}, TimeLeft: ${this.timeLeft}`);

        // Restart timer if game was in progress
        if (this.gameStarted && !this.gameOver && this.timeLeft > 0 && !this.timerInterval) {
            this.startTimer();
        }
    }

    initializeCanvas() {
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Initializing new canvas state.`);
        const state = [];
        for (let y = 0; y < CANVAS_HEIGHT; y++) {
            state[y] = [];
            for (let x = 0; x < CANVAS_WIDTH; x++) {
                state[y][x] = '#FFFFFF'; // Initialize with white
            }
        }
        return state;
    }

    async saveState() {
        // Save the current game state to durable storage
        // No need to block concurrency here usually, just write.
        await this.state.storage.put('canvasState', this.canvasState);
        await this.state.storage.put('scores', this.scores);
        await this.state.storage.put('timeLeft', this.timeLeft);
        await this.state.storage.put('gameStarted', this.gameStarted);
        await this.state.storage.put('gameOver', this.gameOver);
        // console.log(`[DO ${this.state.id.toString().substring(0,6)}] State saved.`);
    }

    // Handle WebSocket connections routed to this Durable Object
    async fetch(request) {
        // Expecting a WebSocket upgrade request
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        // Create the WebSocket pair
        const { 0: clientWs, 1: serverWs } = new WebSocketPair();

        // Extract player info potentially passed during the upgrade request (e.g., via headers or URL)
        // For simplicity, let's assume the matchmaking worker adds necessary info.
        // A more robust way might involve a token or temporary ID passed in the URL.
        const url = new URL(request.url);
        const playerId = url.searchParams.get('playerId') || crypto.randomUUID(); // Assign random if not provided
        const assignedColor = url.searchParams.get('color') || this.assignColor();

        // Handle the server side of the WebSocket connection
        await this.handleSession(serverWs, playerId, assignedColor);

        // Return the client side to the connecting user
        return new Response(null, {
            status: 101, // Switching Protocols
            webSocket: clientWs,
        });
    }

    assignColor() {
        // Find a color not currently used by connected sessions
        const usedColors = this.sessions.map(s => s.color);
        for (const color of PLAYER_COLORS) {
            if (!usedColors.includes(color)) {
                return color;
            }
        }
        // Fallback if all primary colors are taken (shouldn't happen with MAX_PLAYERS)
        return `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`;
    }

    async handleSession(ws, playerId, color) {
        // Accept the WebSocket connection
        ws.accept();

        // Check if player limit reached
        if (this.sessions.length >= MAX_PLAYERS_PER_ROOM) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game room is full.' }));
            ws.close(1008, 'Room full');
            return;
        }

        // Check if game is already over
        if (this.gameOver) {
             ws.send(JSON.stringify({ type: 'error', message: 'Game has already ended.' }));
             ws.close(1000, 'Game ended');
             return;
        }

        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${playerId.substring(0,6)} (${color}) connected.`);

        // Store session information
        const session = { ws, playerId, color, lastPlacement: 0 };
        this.sessions.push(session);

        // Initialize score if new player
        if (!this.scores[color]) {
            this.scores[color] = 0;
        }

        // Send initial game state to the new player
        ws.send(JSON.stringify({
            type: 'gameState',
            canvasState: this.canvasState,
            scores: this.scores,
            timeLeft: this.gameStarted ? this.timeLeft : null, // Only send time if game started
            yourColor: color, // Tell the client its color explicitly
            playerId: playerId
        }));

        // Broadcast updated scores to everyone (including the new player)
        this.broadcast({ type: 'scoreUpdate', scores: this.scores });

        // Check if enough players to start the game
        if (!this.gameStarted && this.sessions.length >= MIN_PLAYERS_TO_START) {
            this.startGame();
        }

        // Handle messages from this client
        ws.addEventListener('message', async event => {
            try {
                const message = JSON.parse(event.data);
                console.log(`[DO ${this.state.id.toString().substring(0,6)}] Message from ${playerId.substring(0,6)}:`, message);

                if (message.type === 'placePixel') {
                    if (!this.gameStarted || this.gameOver) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Game not active.' }));
                        return;
                    }
                    this.handlePlacePixel(session, message.payload);
                }
                // Add handlers for other message types if needed
            } catch (error) {
                console.error(`[DO ${this.state.id.toString().substring(0,6)}] Failed to handle message:`, error);
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
            }
        });

        // Handle client disconnection
        ws.addEventListener('close', event => {
            console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${playerId.substring(0,6)} (${color}) disconnected.`);
            this.removeSession(session);
            // Optionally: If game hasn't started and players drop below min, reset?
            // Or just let it continue if started. For simplicity, we'll let it continue.
            // If the room becomes empty, the DO might eventually be evicted.
            if (this.sessions.length === 0 && this.gameStarted) {
                 console.log(`[DO ${this.state.id.toString().substring(0,6)}] Room empty, stopping timer.`);
                 this.stopTimer();
                 // Consider persisting state before potential eviction
                 this.state.storage.put('gameEndedDueToEmpty', true);
            }
        });
         ws.addEventListener('error', error => {
            console.error(`[DO ${this.state.id.toString().substring(0,6)}] WebSocket error for player ${playerId.substring(0,6)}:`, error);
            this.removeSession(session);
             if (this.sessions.length === 0 && this.gameStarted) {
                 console.log(`[DO ${this.state.id.toString().substring(0,6)}] Room empty after error, stopping timer.`);
                 this.stopTimer();
                 this.state.storage.put('gameEndedDueToEmpty', true);
            }
        });
    }

    removeSession(sessionToRemove) {
        this.sessions = this.sessions.filter(s => s !== sessionToRemove);
        // Don't remove score immediately, keep it for final results
        // this.broadcast({ type: 'scoreUpdate', scores: this.scores }); // Optionally update scores on leave
    }

    startGame() {
        if (this.gameStarted) return;
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Starting game!`);
        this.gameStarted = true;
        this.timeLeft = GAME_DURATION_SECONDS; // Reset timer
        this.state.storage.put('gameStarted', true); // Persist
        this.startTimer();
        this.broadcast({ type: 'timerUpdate', timeLeft: this.timeLeft }); // Inform clients timer started
    }

    startTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval); // Clear existing if any

        this.timerInterval = setInterval(() => {
            if (this.timeLeft > 0) {
                this.timeLeft--;
                // Broadcast timer updates periodically (e.g., every second)
                this.broadcast({ type: 'timerUpdate', timeLeft: this.timeLeft });

                // Save state periodically or less frequently to reduce writes
                if (this.timeLeft % 10 === 0) { // Save every 10 seconds
                     this.saveState();
                }
            } else {
                this.endGame();
            }
        }, 1000); // Update every second

        // Ensure the interval doesn't keep the DO alive indefinitely if empty
        this.state.waitUntil(new Promise(resolve => this.timerResolve = resolve));
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
         if (this.timerResolve) {
            this.timerResolve(); // Allow DO to potentially sleep if needed
            this.timerResolve = null;
        }
    }

    endGame() {
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Game over!`);
        this.stopTimer();
        this.gameOver = true;
        this.gameStarted = false; // Reset for potential future games? Or keep DO specific to one game? Let's keep it ended.

        // Determine winner
        let winnerColor = null;
        let highScore = -1;
        let isDraw = false;
        for (const [color, score] of Object.entries(this.scores)) {
            if (score > highScore) {
                highScore = score;
                winnerColor = color;
                isDraw = false;
            } else if (score === highScore) {
                isDraw = true;
            }
        }

        const finalWinner = isDraw ? null : winnerColor; // Null for draw

        this.broadcast({ type: 'gameOver', winnerColor: finalWinner, scores: this.scores });

        // Persist final state
        this.state.storage.put('gameOver', true);
        this.state.storage.put('gameStarted', false); // Mark as not active
        this.saveState(); // Save final scores etc.

        // Close all connections after a short delay? Or let clients disconnect?
        // setTimeout(() => this.sessions.forEach(s => s.ws.close(1000, "Game Over")), 5000);
    }

    handlePlacePixel(session, payload) {
        const { x, y } = payload;
        const now = Date.now();

        // Validation
        if (typeof x !== 'number' || typeof y !== 'number' ||
            x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
            session.ws.send(JSON.stringify({ type: 'error', message: 'Invalid coordinates.' }));
            return;
        }

        // Cooldown check
        if (now - session.lastPlacement < COOLDOWN_MS) {
            // Optionally send a 'cooldown' message back, but might be noisy.
            // Client handles visual cooldown. Log it server-side for now.
            console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${session.playerId.substring(0,6)} cooldown active.`);
            return;
        }

        const oldColor = this.canvasState[y][x];
        const newColor = session.color;

        // If the pixel is already the player's color, do nothing
        if (oldColor === newColor) {
            return;
        }

        // Update canvas state
        this.canvasState[y][x] = newColor;
        session.lastPlacement = now; // Update last placement time

        // Update scores
        if (oldColor !== '#FFFFFF' && this.scores[oldColor]) { // Decrement score of the previous owner (if not white)
            this.scores[oldColor] = Math.max(0, this.scores[oldColor] - 1);
        }
        this.scores[newColor] = (this.scores[newColor] || 0) + 1; // Increment score of the new owner

        // Broadcast the pixel update and score changes
        this.broadcast({ type: 'pixelUpdate', x, y, color: newColor, scores: this.scores });

        // Persist state (maybe less frequently than every pixel)
        // Consider batching writes or writing only periodically. For simplicity, writing now.
        // Debounce this later if performance becomes an issue.
        this.saveState();
    }

    // Broadcast a message to all connected clients in this room
    broadcast(message) {
        const messageString = JSON.stringify(message);
        // console.log(`[DO ${this.state.id.toString().substring(0,6)}] Broadcasting: ${messageString}`);
        this.sessions.forEach(session => {
            try {
                session.ws.send(messageString);
            } catch (error) {
                console.error(`[DO ${this.state.id.toString().substring(0,6)}] Failed to send message to ${session.playerId.substring(0,6)}:`, error);
                // Handle potential broken connections - remove session if send fails?
                this.removeSession(session);
            }
        });
    }
}

// --- Main Worker ---
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Route WebSocket connections for matchmaking/joining
        if (url.pathname === '/websocket') {
            console.log("Incoming WebSocket request to /websocket");
            // This is the initial connection. We need to find or create a game room (DO).
            return this.handleWebSocketConnection(request, env);
        }

        // Serve the static frontend files (HTML, CSS, JS)
        // In a real app, use Cloudflare Pages static asset handling.
        // For a pure Worker setup, you might embed files or use KV.
        // Here, we'll just serve index.html for the root.
        if (url.pathname === '/') {
            // This is a simplified way to serve HTML.
            // In a Pages deployment, Pages handles serving static assets automatically.
            // If deploying *only* as a Worker, you'd need a more robust way
            // (e.g., importing HTML as text, using KV, or R2).
            // Since the target is Pages, we assume Pages serves index.html,
            // and the worker mainly handles the /websocket endpoint and DOs.
            // However, to make it runnable standalone via `wrangler dev`,
            // let's add a basic HTML response here.
             return new Response(`
                <!DOCTYPE html>
                <html><head><title>Pixel Canvas Clash</title></head>
                <body>
                    <h1>Error</h1>
                    <p>This Worker expects to be deployed alongside static assets on Cloudflare Pages.</p>
                    <p>Access the root path ('/') of your Pages deployment to load the game.</p>
                    <p>The '/websocket' endpoint is handled by the Worker.</p>
                </body></html>`,
                { headers: { 'Content-Type': 'text/html' } }
            );
            // Ideally, Pages serves index.html, style.css, client.js automatically.
            // The worker only needs to handle the /websocket path and the DO.
        }

         if (url.pathname === '/client.js' || url.pathname === '/style.css') {
             // Basic serving for wrangler dev - Pages handles this in production
             return new Response(`/* Asset ${url.pathname} should be served by Cloudflare Pages */`, {
                 headers: { 'Content-Type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css' }
             });
         }


        // Handle Durable Object requests (forwarded by the runtime)
        // The runtime automatically routes requests for the DO based on wrangler.toml
        // We don't need explicit routing here if the DO fetch handles its path.

        return new Response('Not found.', { status: 404 });
    },

    async handleWebSocketConnection(request, env) {
        // This worker acts as the matchmaker.
        // It finds an appropriate GameRoom DO instance and forwards the WebSocket connection.

        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        // Find an available room or create a new one.
        // This is a very basic matchmaking strategy.
        let roomStub = null;
        let assignedColor = null;
        const playerId = crypto.randomUUID(); // Generate a unique ID for this connection attempt

        // Option 1: Use a known, named DO for simplicity (e.g., always use "lobby")
        // This isn't scalable for multiple rooms but is simple for one room.
        // let lobbyId = env.GAME_ROOM.idFromName("shared-lobby");
        // roomStub = env.GAME_ROOM.get(lobbyId);

        // Option 2: More complex matchmaking (find non-full room or create)
        // This requires tracking room occupancy, maybe in KV or another DO.
        // For this example, let's simplify: create a *new* room ID each time
        // for testing, or use idFromName for a single shared room.
        // Let's use idFromName for simplicity now. A real system needs better logic.

        const roomName = "default-room"; // All players join the same room for now
        const roomId = env.GAME_ROOM.idFromName(roomName);
        roomStub = env.GAME_ROOM.get(roomId);

        console.log(`Matchmaking: Attempting to connect player ${playerId.substring(0,6)} to room DO ${roomId}`);

        // We need to assign a color *before* forwarding. The DO can refine this.
        // This is tricky - the DO should ideally own color assignment.
        // Let's pass a suggestion or let the DO handle it fully.
        // We'll let the DO handle color assignment based on current players in the room.

        // Forward the WebSocket request to the Durable Object's fetch handler.
        // We can pass initial info via URL parameters.
        const doUrl = new URL(request.url);
        doUrl.pathname = `/websocket/connect`; // Internal path for DO fetch (can be anything)
        doUrl.searchParams.set('playerId', playerId);
        // doUrl.searchParams.set('color', assignedColor); // Let DO assign color

        console.log(`Forwarding WebSocket request to DO at URL: ${doUrl.toString()}`);

        try {
            // The DO's fetch method will handle the WebSocket upgrade.
            return await roomStub.fetch(doUrl.toString(), request);
        } catch (error) {
            console.error("Error fetching from Durable Object:", error);
            return new Response("Failed to connect to game room", { status: 500 });
        }
    }
};
