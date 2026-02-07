const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from 'public' directory
// Serve static files from root directory
app.use(express.static(__dirname));

// Store clients by frequency
// Map<Frequency, Set<WebSocket>>
const channels = new Map();

wss.on('connection', (ws) => {
    ws.currentFreq = null;

    ws.on('message', (message) => {
        try {
            // Check if message is binary (audio data)
            // In Node ws, message is Buffer. In browser sent as Blob/ArrayBuffer.
            // We'll treat it as binary if it's not a valid JSON or if explicitly binary.

            // Simple check: try parse JSON. If fail, treat as audio? 
            // Or better: Client sends { type: 'audio', data: base64 }?
            // Sending binary directly is more efficient.
            // Let's assume if it starts with '{' it's JSON, else binary.

            const msgString = message.toString();
            if (msgString.startsWith('{')) {
                const data = JSON.parse(msgString);
                if (data.type === 'tune') {
                    handleTune(ws, data.freq);
                } else if (data.type === 'audio') {
                    // Start of audio relay with frequency check
                    broadcastAudio(ws, msgString);
                }
            } else {
                // Should be binary audio (Legacy support or fallback)
                broadcastAudio(ws, message);
            }
        } catch (e) {
            console.error('Error handling message:', e);
            // broadcastAudio(ws, message); // Disable blind broadcast for now to prefer JSON
        }
    });

    ws.on('close', () => {
        removeFromChannel(ws);
        console.log('Client disconnected');
    });
});

function handleTune(ws, freq) {
    removeFromChannel(ws);
    // For range query, we might want a different struct, but Map iteration is fine for small scale.
    // Ideally we just store all clients in a Set or Map key=ws val=freq?
    // Let's keep `channels` for exact match if needed, but for range we iterate everything.
    // Actually, let's keep `ws.currentFreq` property as primary source of truth.

    ws.currentFreq = parseInt(freq);

    // Add to channel map (still useful for exact match queries if needed)
    if (!channels.has(ws.currentFreq)) {
        channels.set(ws.currentFreq, new Set());
    }
    channels.get(ws.currentFreq).add(ws);
}

function removeFromChannel(ws) {
    if (ws.currentFreq && channels.has(ws.currentFreq)) {
        const clients = channels.get(ws.currentFreq);
        clients.delete(ws);
        if (clients.size === 0) {
            channels.delete(ws.currentFreq);
        }
    }
}

function broadcastAudio(sender, messageData) {
    if (!sender.currentFreq) return;

    // Range: +/- 10Hz
    // Since we need to find clients in range, iteration over all connected clients is required 
    // unless we optimize storage. For now, we iterate through wss.clients or our channels map.
    // wss.clients is a Set of all connected clients.

    wss.clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN && client.currentFreq) {
            const diff = Math.abs(sender.currentFreq - client.currentFreq);
            if (diff <= 10) {
                client.send(messageData);
            }
        }
    });
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
