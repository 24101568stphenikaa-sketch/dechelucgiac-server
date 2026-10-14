const WebSocket = require('ws');

// Sử dụng cổng động từ Cloud cấp hoặc mặc định là 8080 khi test trên máy cá nhân
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
let waitingPlayer = null;

console.log(`🚀 Matchmaking Server đang chạy trên cổng ${PORT}`);

wss.on('connection', (ws) => {
    console.log('👤 Có một người chơi vừa kết nối thành công!');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        // Khi nhận được tín hiệu tìm trận từ người chơi
        if (data.type === 'FIND_MATCH') {
            if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === WebSocket.OPEN) {
                let roomId = 'room_' + Math.random().toString(36).substring(2, 9);
                
                // Gửi thông báo cho người chơi 1 (Host - Index 0)
                waitingPlayer.send(JSON.stringify({ 
                    type: 'MATCH_FOUND', 
                    room: roomId, 
                    playerIndex: 0 
                }));
                
                // Gửi thông báo cho người chơi 2 (Guest - Index 1)
                ws.send(JSON.stringify({ 
                    type: 'MATCH_FOUND', 
                    room: roomId, 
                    playerIndex: 1 
                }));

                console.log(`⚔️ Ghép trận thành công! Phòng: ${roomId}`);
                waitingPlayer = null; // Reset hàng đợi
            } else {
                waitingPlayer = ws;
                ws.send(JSON.stringify({ type: 'WAITING' }));
                console.log('⏳ Đang chờ thêm người chơi vào hàng đợi...');
            }
        }
    });

    ws.on('close', () => {
        if (waitingPlayer === ws) {
            waitingPlayer = null;
            console.log('❌ Người chơi đã rời hàng đợi.');
        }
    });
});