// functions/gameroom.mjs

// --- Constants ---
// Moved relevant constants here
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
        await this.state.storage.put('canvasState', this.canvasState);
        await this.state.storage.put('scores', this.scores);
        await this.state.storage.put('timeLeft', this.timeLeft);
        await this.state.storage.put('gameStarted', this.gameStarted);
        await this.state.storage.put('gameOver', this.gameOver);
    }

    // Handle WebSocket connections routed to this Durable Object
    async fetch(request) {
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        const { 0: clientWs, 1: serverWs } = new WebSocketPair();

        const url = new URL(request.url);
        const playerId = url.searchParams.get('playerId') || crypto.randomUUID();
        const assignedColor = this.assignColor(); // Assign color within the DO

        await this.handleSession(serverWs, playerId, assignedColor);

        return new Response(null, {
            status: 101,
            webSocket: clientWs,
        });
    }

    assignColor() {
        const usedColors = this.sessions.map(s => s.color);
        for (const color of PLAYER_COLORS) {
            if (!usedColors.includes(color)) {
                return color;
            }
        }
        return `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`;
    }

    async handleSession(ws, playerId, color) {
        ws.accept();

        if (this.sessions.length >= MAX_PLAYERS_PER_ROOM) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game room is full.' }));
            ws.close(1008, 'Room full');
            return;
        }
        if (this.gameOver) {
             ws.send(JSON.stringify({ type: 'error', message: 'Game has already ended.' }));
             ws.close(1000, 'Game ended');
             return;
        }

        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${playerId.substring(0,6)} (${color}) connected.`);
        const session = { ws, playerId, color, lastPlacement: 0 };
        this.sessions.push(session);

        if (!this.scores[color]) {
            this.scores[color] = 0;
        }

        ws.send(JSON.stringify({
            type: 'assignInfo', // Send assignment info from DO now
            roomId: this.state.id.toString(),
            playerId: playerId,
            color: color
        }));

        ws.send(JSON.stringify({
            type: 'gameState',
            canvasState: this.canvasState,
            scores: this.scores,
            timeLeft: this.gameStarted ? this.timeLeft : null,
        }));

        this.broadcast({ type: 'scoreUpdate', scores: this.scores });

        if (!this.gameStarted && this.sessions.length >= MIN_PLAYERS_TO_START) {
            this.startGame();
        }

        ws.addEventListener('message', async event => {
            try {
                const message = JSON.parse(event.data);
                console.log(`[DO ${this.state.id.toString().substring(0,6)}] Message from ${playerId.substring(0,6)}:`, message);
                if (message.type === 'placePixel') {
                    if (!this.gameStarted || this.gameOver) return;
                    this.handlePlacePixel(session, message.payload);
                }
            } catch (error) {
                console.error(`[DO ${this.state.id.toString().substring(0,6)}] Failed to handle message:`, error);
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
            }
        });

        const closeOrErrorHandler = (event) => {
            console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${playerId.substring(0,6)} (${color}) disconnected/errored.`);
            this.removeSession(session);
            if (this.sessions.length === 0 && this.gameStarted) {
                 console.log(`[DO ${this.state.id.toString().substring(0,6)}] Room empty, stopping timer.`);
                 this.stopTimer();
                 this.state.storage.put('gameEndedDueToEmpty', true);
            }
        };
        ws.addEventListener('close', closeOrErrorHandler);
        ws.addEventListener('error', closeOrErrorHandler);
    }

    removeSession(sessionToRemove) {
        this.sessions = this.sessions.filter(s => s !== sessionToRemove);
    }

    startGame() {
        if (this.gameStarted) return;
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Starting game!`);
        this.gameStarted = true;
        this.timeLeft = GAME_DURATION_SECONDS;
        this.state.storage.put('gameStarted', true);
        this.startTimer();
        this.broadcast({ type: 'timerUpdate', timeLeft: this.timeLeft });
    }

    startTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            if (this.timeLeft > 0) {
                this.timeLeft--;
                this.broadcast({ type: 'timerUpdate', timeLeft: this.timeLeft });
                if (this.timeLeft % 10 === 0) {
                     this.saveState();
                }
            } else {
                this.endGame();
            }
        }, 1000);
        this.state.waitUntil(new Promise(resolve => this.timerResolve = resolve));
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
         if (this.timerResolve) {
            this.timerResolve();
            this.timerResolve = null;
        }
    }

    endGame() {
        console.log(`[DO ${this.state.id.toString().substring(0,6)}] Game over!`);
        this.stopTimer();
        this.gameOver = true;
        this.gameStarted = false;

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
        const finalWinner = isDraw ? null : winnerColor;

        this.broadcast({ type: 'gameOver', winnerColor: finalWinner, scores: this.scores });
        this.state.storage.put('gameOver', true);
        this.state.storage.put('gameStarted', false);
        this.saveState();
    }

    handlePlacePixel(session, payload) {
        const { x, y } = payload;
        const now = Date.now();

        if (typeof x !== 'number' || typeof y !== 'number' ||
            x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
            session.ws.send(JSON.stringify({ type: 'error', message: 'Invalid coordinates.' }));
            return;
        }
        if (now - session.lastPlacement < COOLDOWN_MS) {
            console.log(`[DO ${this.state.id.toString().substring(0,6)}] Player ${session.playerId.substring(0,6)} cooldown active.`);
            return;
        }

        const oldColor = this.canvasState[y][x];
        const newColor = session.color;
        if (oldColor === newColor) return;

        this.canvasState[y][x] = newColor;
        session.lastPlacement = now;

        if (oldColor !== '#FFFFFF' && this.scores[oldColor]) {
            this.scores[oldColor] = Math.max(0, this.scores[oldColor] - 1);
        }
        this.scores[newColor] = (this.scores[newColor] || 0) + 1;

        this.broadcast({ type: 'pixelUpdate', x, y, color: newColor, scores: this.scores });
        this.saveState(); // Consider debouncing later
    }

    broadcast(message) {
        const messageString = JSON.stringify(message);
        this.sessions.forEach(session => {
            try {
                session.ws.send(messageString);
            } catch (error) {
                console.error(`[DO ${this.state.id.toString().substring(0,6)}] Failed to send message to ${session.playerId.substring(0,6)}:`, error);
                this.removeSession(session); // Remove session on send error
            }
        });
    }
}
