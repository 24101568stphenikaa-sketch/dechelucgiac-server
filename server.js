const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 5;
const WAIT_TIME_MS = 60_000;
const httpServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
});
const wss = new WebSocket.Server({ server: httpServer });
const waitingQueue = [];
const rooms = new Map();

httpServer.listen(PORT, () => {
    console.log(`🚀 Matchmaking server đang chạy trên cổng ${PORT}`);
});
httpServer.on('error', (error) => {
    console.error('Matchmaking server error:', error);
});

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
            send(ws, { type: 'ERROR', message: 'Yêu cầu không phải JSON hợp lệ.' });
            return;
        }

        if (!data || typeof data.type !== 'string') return;

        if (data.type === 'FIND_MATCH') {
            if (ws.matchRoom) return;
            if (!waitingQueue.some((entry) => entry.ws === ws) && ws.readyState === WebSocket.OPEN) {
                waitingQueue.push({ ws, queuedAt: Date.now() });
                console.log(`⏳ Hàng đợi: ${waitingQueue.length}/${MAX_PLAYERS}`);
            }
            dispatchReadyGroups();
            if (waitingQueue.some((entry) => entry.ws === ws)) sendQueueStatus();
        } else if (data.type === 'FORCE_MATCH') {
            forceMatch(ws);
        } else if (data.type === 'CANCEL_MATCH') {
            if (removeFromQueue(ws)) sendQueueStatus();
        } else if (data.type === 'GAME_ACTION') {
            relayGameAction(ws, data.action);
        }
    });

    ws.on('close', () => {
        if (removeFromQueue(ws)) sendQueueStatus();
        removeFromRoom(ws);
    });
});

wss.on('error', (error) => {
    console.error('Matchmaking WebSocket error:', error);
});

const queueTimer = setInterval(dispatchReadyGroups, 250);
queueTimer.unref();

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function sendQueueStatus() {
    const queueCount = waitingQueue.length;
    for (const entry of waitingQueue) {
        send(entry.ws, {
            type: 'WAITING',
            queueCount,
            waitMs: Math.max(0, Date.now() - entry.queuedAt)
        });
    }
}

function removeFromQueue(ws) {
    const index = waitingQueue.findIndex((entry) => entry.ws === ws);
    if (index === -1) return false;
    waitingQueue.splice(index, 1);
    return true;
}

function dispatchReadyGroups() {
    let dispatched = false;
    while (waitingQueue.length >= MAX_PLAYERS) {
        dispatchRoom(waitingQueue.splice(0, MAX_PLAYERS).map((entry) => entry.ws));
        dispatched = true;
    }

    if (waitingQueue.length && Date.now() - waitingQueue[0].queuedAt >= WAIT_TIME_MS) {
        dispatchRoom(waitingQueue.splice(0, MAX_PLAYERS).map((entry) => entry.ws));
        dispatched = true;
    }

    if (dispatched) sendQueueStatus();
}

function forceMatch(ws) {
    if (!waitingQueue.some((entry) => entry.ws === ws)) return;
    dispatchRoom(waitingQueue.splice(0, MAX_PLAYERS).map((entry) => entry.ws));
    sendQueueStatus();
}

function dispatchRoom(group) {
    const clients = group.filter((client) => client.readyState === WebSocket.OPEN);
    if (!clients.length) return;

    const roomId = `room_${crypto.randomBytes(5).toString('hex')}`;
    const realPlayers = clients.length;
    const seed = crypto.randomInt(1, 0x7fffffff);
    const room = { clients: new Map(), realPlayers };
    rooms.set(roomId, room);

    clients.forEach((client, playerIndex) => {
        client.matchRoom = roomId;
        client.matchPlayerIndex = playerIndex;
        room.clients.set(client, playerIndex);
        send(client, {
            type: 'MATCH_FOUND',
            room: roomId,
            playerIndex,
            realPlayers,
            aiCount: MAX_PLAYERS - realPlayers,
            totalPlayers: MAX_PLAYERS,
            seed
        });
    });

    console.log(`⚔️ Phòng ${roomId}: ${realPlayers} người thật, ${MAX_PLAYERS - realPlayers} AI.`);
}

function relayGameAction(ws, action) {
    const room = rooms.get(ws.matchRoom);
    if (!room || !room.clients.has(ws) || !action || typeof action.type !== 'string') return;

    const playerIndex = room.clients.get(ws);
    let safeAction;

    if (action.type === 'BUY_TILE' && isValidCoordinate(action)) {
        safeAction = {
            type: 'BUY_TILE',
            q: action.q,
            r: action.r,
            owner: playerIndex,
            moneySpent: validMoney(action.moneySpent)
        };
    } else if (action.type === 'BUILD' && isValidCoordinate(action) &&
        ['house', 'service', 'industrial'].includes(action.building)) {
        safeAction = {
            type: 'BUILD',
            q: action.q,
            r: action.r,
            building: action.building,
            owner: playerIndex,
            moneySpent: validMoney(action.moneySpent)
        };
    } else if (action.type === 'AI_TURN' && playerIndex === 0 &&
        Number.isInteger(action.owner) && action.owner >= room.realPlayers &&
        action.owner < MAX_PLAYERS && isValidCoordinate(action) &&
        ['house', 'service', 'industrial'].includes(action.building)) {
        safeAction = {
            type: 'AI_TURN',
            q: action.q,
            r: action.r,
            owner: action.owner,
            building: action.building,
            moneySpent: validMoney(action.moneySpent)
        };
    } else {
        return;
    }

    const message = JSON.stringify({ type: 'GAME_ACTION', room: ws.matchRoom, action: safeAction });
    for (const client of room.clients.keys()) {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(message);
    }
}

function isValidCoordinate(action) {
    return Number.isInteger(action.q) && Number.isInteger(action.r);
}

function validMoney(value) {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function removeFromRoom(ws) {
    const roomId = ws.matchRoom;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (room) {
        room.clients.delete(ws);
        for (const client of room.clients.keys()) {
            send(client, { type: 'PLAYER_DISCONNECTED', room: roomId, playerIndex: ws.matchPlayerIndex });
        }
        if (room.clients.size === 0) rooms.delete(roomId);
    }

    ws.matchRoom = null;
}

module.exports = { httpServer, wss, waitingQueue, rooms, dispatchReadyGroups };
