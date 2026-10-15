const crypto = require('node:crypto');
const http = require('node:http');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 5;
const WAIT_TIME_MS = 60_000;
const SESSION_DURATION_DAYS = 30;
const scrypt = promisify(crypto.scrypt);
const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ...(process.env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {})
    })
    : null;
const httpServer = http.createServer(handleHttpRequest);
const wss = new WebSocket.Server({ server: httpServer });
const waitingQueue = [];
const rooms = new Map();

httpServer.listen(PORT, () => {
    console.log(`🚀 Matchmaking và account server đang chạy trên cổng ${PORT}`);
});
httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
});

let databaseReady = initializeDatabase();

async function initializeDatabase() {
    if (!pool) {
        console.warn('DATABASE_URL chưa được cấu hình; các API tài khoản hiện chưa khả dụng.');
        return false;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_users (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                username_normalized TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                cups INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS account_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS account_sessions_expires_at_idx ON account_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS match_results (
                user_id BIGINT NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
                match_id TEXT NOT NULL,
                rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
                cup_change INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, match_id)
            );
        `);
        console.log('Account database schema is ready.');
        return true;
    } catch (error) {
        console.error('Could not initialize account database:', error);
        return false;
    }
}

async function ensureDatabaseReady() {
    if (!pool) return false;
    if (!(await databaseReady)) databaseReady = initializeDatabase();
    return databaseReady;
}

function sendJson(response, status, body) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    });
    response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) {
            const error = new Error('Nội dung yêu cầu vượt quá giới hạn.');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('Yêu cầu không phải JSON hợp lệ.');
        error.statusCode = 400;
        throw error;
    }
}

function validAccountInput(body) {
    return body && typeof body.username === 'string' &&
        /^[a-zA-Z0-9_-]{3,24}$/.test(body.username) &&
        typeof body.password === 'string' &&
        body.password.length >= 8 && body.password.length <= 128;
}

function getBearerToken(request) {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.authorization || '');
    return match ? match[1] : null;
}

async function getAuthenticatedUser(request) {
    const token = getBearerToken(request);
    if (!pool || !token) return null;
    const result = await pool.query(`
        SELECT u.id, u.username, u.cups
        FROM account_sessions s
        JOIN game_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()
    `, [crypto.createHash('sha256').update(token).digest('hex')]);
    return result.rows[0] || null;
}

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(`
        INSERT INTO account_sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'))
    `, [tokenHash, userId, SESSION_DURATION_DAYS]);
    return token;
}

function publicProfile(user) {
    return { username: user.username, cups: Number(user.cups) };
}

async function handleHttpRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    const path = new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Không tìm thấy API.' });
        return;
    }
    if (!await ensureDatabaseReady()) {
        sendJson(response, 503, { error: 'Cơ sở dữ liệu chưa sẵn sàng. Hãy cấu hình DATABASE_URL trên máy chủ.' });
        return;
    }

    try {
        if (request.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
            const body = await readJsonBody(request);
            if (!validAccountInput(body)) {
                sendJson(response, 400, { error: 'Tên tài khoản phải có 3-24 ký tự chữ/số/_/-. Mật khẩu cần 8-128 ký tự.' });
                return;
            }

            const normalizedUsername = body.username.toLowerCase();
            let user;
            if (path === '/api/register') {
                const salt = crypto.randomBytes(16).toString('hex');
                const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex');
                try {
                    const inserted = await pool.query(`
                        INSERT INTO game_users (username, username_normalized, password_hash, password_salt)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id, username, cups
                    `, [body.username, normalizedUsername, passwordHash, salt]);
                    user = inserted.rows[0];
                } catch (error) {
                    if (error.code === '23505') {
                        sendJson(response, 409, { error: 'Tên tài khoản này đã được sử dụng.' });
                        return;
                    }
                    throw error;
                }
            } else {
                const found = await pool.query(`
                    SELECT id, username, password_hash, password_salt, cups
                    FROM game_users WHERE username_normalized = $1
                `, [normalizedUsername]);
                if (!found.rows.length) {
                    sendJson(response, 401, { error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
                    return;
                }
                const stored = found.rows[0];
                const candidate = await scrypt(body.password, stored.password_salt, 64);
                const expected = Buffer.from(stored.password_hash, 'hex');
                if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
                    sendJson(response, 401, { error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
                    return;
                }
                user = stored;
            }

            const token = await createSession(user.id);
            sendJson(response, 200, { token, profile: publicProfile(user) });
            return;
        }

        if (request.method === 'GET' && path === '/api/profile') {
            const user = await getAuthenticatedUser(request);
            if (!user) {
                sendJson(response, 401, { error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
                return;
            }
            sendJson(response, 200, { profile: publicProfile(user) });
            return;
        }

        if (request.method === 'POST' && path === '/api/match-result') {
            const user = await getAuthenticatedUser(request);
            if (!user) {
                sendJson(response, 401, { error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
                return;
            }
            const body = await readJsonBody(request);
            if (!body || typeof body.matchId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(body.matchId) ||
                !Number.isInteger(body.rank) || body.rank < 1 || body.rank > 5) {
                sendJson(response, 400, { error: 'Kết quả trận đấu không hợp lệ.' });
                return;
            }

            const cupChange = [20, 10, 0, -10, -20][body.rank - 1];
            const result = await pool.query(`
                WITH inserted AS (
                    INSERT INTO match_results (user_id, match_id, rank, cup_change)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (user_id, match_id) DO NOTHING
                    RETURNING cup_change
                )
                UPDATE game_users
                SET cups = cups + COALESCE((SELECT cup_change FROM inserted), 0)
                WHERE id = $1
                RETURNING username, cups
            `, [user.id, body.matchId, body.rank, cupChange]);
            sendJson(response, 200, { profile: publicProfile(result.rows[0]) });
            return;
        }

        sendJson(response, 404, { error: 'Không tìm thấy API.' });
    } catch (error) {
        console.error(`API request failed (${request.method} ${path}):`, error);
        sendJson(response, error.statusCode || 500, {
            error: error.statusCode ? error.message : 'Máy chủ không thể xử lý yêu cầu.'
        });
    }
}

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
    console.error('Matchmaking server error:', error);
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
    const players = group.filter((client) => client.readyState === WebSocket.OPEN);
    if (!players.length) return;

    const roomId = `room_${crypto.randomBytes(5).toString('hex')}`;
    const realPlayers = players.length;
    const seed = crypto.randomInt(1, 0x7fffffff);
    const room = { clients: new Map(), realPlayers };
    rooms.set(roomId, room);

    players.forEach((client, playerIndex) => {
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
