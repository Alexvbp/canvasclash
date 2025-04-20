// functions/websocket.js

// This function handles requests to the /websocket path.
export async function onRequest(context) {
    const { request, env } = context; // Get request and environment bindings

    // Ensure this is a WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // Basic matchmaking: Use a single named Durable Object instance for simplicity.
    // A real application would need a more robust matchmaking system (e.g., finding rooms with space).
    const roomName = "default-room";
    const playerId = crypto.randomUUID(); // Generate a unique ID for this connection attempt

    try {
        // Get the Durable Object stub for the game room.
        // env.GAME_ROOM is the binding name defined in wrangler.toml.
        const roomId = env.GAME_ROOM.idFromName(roomName);
        const roomStub = env.GAME_ROOM.get(roomId);

        console.log(`Matchmaking: Attempting to connect player ${playerId.substring(0,6)} to room DO ${roomId}`);

        // Forward the WebSocket request to the Durable Object's fetch handler.
        // Pass the playerId via URL parameter. The DO will handle color assignment.
        const url = new URL(request.url);
        url.pathname = `/internal/do/connect`; // Internal path for DO fetch (doesn't matter to client)
        url.searchParams.set('playerId', playerId);

        console.log(`Forwarding WebSocket request to DO at URL: ${url.toString()}`);

        // Let the Durable Object handle the WebSocket upgrade and connection.
        return await roomStub.fetch(url.toString(), request);

    } catch (error) {
        console.error("Error in /websocket function:", error);
        // If the DO fetch fails, return an error response.
        // Ensure the client doesn't think the upgrade succeeded.
        if (error.message.includes("fetch failed") || error.message.includes("Durable Object")) {
             return new Response("Failed to connect to game room service.", { status: 500 });
        }
        // For other errors, rethrow? Or return generic error.
        return new Response("Internal server error during WebSocket connection.", { status: 500 });
    }
}
