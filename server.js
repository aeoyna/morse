const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

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
                }
            } else {
                // Should be binary audio
                broadcastAudio(ws, message);
            }
        } catch (e) {
            console.error('Error handling message:', e);
            // If JSON parse failed, it might be binary? 
            // Ideally we differentiate by assuming binary unless it parses as JSON.
            // For now, let's try to broadcast as audio if it failed parse.
            broadcastAudio(ws, message);
        }
    });

    ws.on('close', () => {
        removeFromChannel(ws);
        console.log('Client disconnected');
    });
});

function handleTune(ws, freq) {
    removeFromChannel(ws);
    if (!channels.has(freq)) {
        channels.set(freq, new Set());
    }
    channels.get(freq).add(ws);
    ws.currentFreq = freq;
    // console.log(`Client tuned to ${freq}Hz`);
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

function broadcastAudio(sender, data) {
    const freq = sender.currentFreq;
    if (!freq || !channels.has(freq)) return;

    const clients = channels.get(freq);
    clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
