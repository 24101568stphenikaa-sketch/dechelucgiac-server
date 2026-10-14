const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

let waitingQueue = [];

console.log(`🚀 Matchmaking Server đang chạy trên cổng ${PORT}`);

wss.on('connection', (ws) => {
    console.log('👤 Có người chơi vừa kết nối!');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        // Khi người chơi bấm tìm trận
        if (data.type === 'FIND_MATCH') {
            if (!waitingQueue.includes(ws)) {
                waitingQueue.push(ws);
                console.log(`⏳ Đã thêm vào hàng đợi. Tổng số người chờ: ${waitingQueue.length}`);
            }

            // Gửi thông báo số lượng đang chờ về client
            ws.send(JSON.stringify({ type: 'WAITING', queueCount: waitingQueue.length }));

            // Nếu gom đủ 5 người trong hàng đợi, tạo phòng ngay lập tức
            if (waitingQueue.length >= 5) {
                let matchGroup = waitingQueue.splice(0, 5);
                dispatchRoom(matchGroup);
            }
        }

        // Khi người chơi chờ đủ 60s hoặc bấm hủy/hết giờ, yêu cầu gom nhóm những ai đang đứng chờ lại thành 1 phòng chung
        if (data.type === 'FORCE_MATCH') {
            let index = waitingQueue.indexOf(ws);
            if (index !== -1) {
                waitingQueue.splice(index, 1);
            }
            // Gom tất cả những người còn lại trong hàng đợi vào chung một trận
            if (waitingQueue.length > 0) {
                let matchGroup = [ws, ...waitingQueue];
                waitingQueue = []; // Reset hàng đợi
                dispatchRoom(matchGroup);
            } else {
                // Nếu chỉ có một mình người này lẻ loi, tạo phòng 1 người (còn lại bù AI)
                dispatchRoom([ws]);
            }
        }

        if (data.type === 'CANCEL_MATCH') {
            removeFromQueue(ws);
        }
    });

    ws.on('close', () => {
        removeFromQueue(ws);
    });
});

function removeFromQueue(ws) {
    let index = waitingQueue.indexOf(ws);
    if (index !== -1) {
        waitingQueue.splice(index, 1);
    }
}

// Hàm phân phát phòng chung cho tất cả người chơi đang chờ
function dispatchRoom(group) {
    let roomId = 'room_' + Math.random().toString(36).substring(2, 9);
    let totalRealPlayers = group.length;
    console.log(`⚔️ Tạo phòng chung: ${roomId} với ${totalRealPlayers} người chơi thực tế.`);

    group.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'MATCH_FOUND',
                room: roomId,
                playerIndex: index, // Vị trí của từng người (0, 1, 2...)
                totalPlayers: totalRealPlayers // Số người thực tế để client biết đường bù AI cho đủ 5 phe
            }));
        }
    });
}
