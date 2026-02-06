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
            const data = JSON.parse(message);

            // Update client location if provided
            if (data.lat !== undefined && data.lon !== undefined) {
                ws.lat = data.lat;
                ws.lon = data.lon;
            }

            if (data.type === 'tune') {
                handleTune(ws, data.freq);
            } else if (data.type === 'signal') {
                broadcastSignal(ws, data);
            }
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    });

    ws.on('close', () => {
        removeFromChannel(ws);
        console.log('Client disconnected');
    });
});

function handleTune(ws, freq) {
    // Remove from old channel
    removeFromChannel(ws);

    // Add to new channel
    if (!channels.has(freq)) {
        channels.set(freq, new Set());
    }
    channels.get(freq).add(ws);
    ws.currentFreq = freq;

    console.log(`Client tuned to ${freq}Hz`);

    // Notify client of success (optional)
    ws.send(JSON.stringify({ type: 'status', msg: `Tuned to ${freq}Hz` }));
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

function broadcastSignal(sender, data) {
    const freq = sender.currentFreq;
    if (!freq || !channels.has(freq)) return;

    const clients = channels.get(freq);

    clients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            let volume = 1.0;

            // Calculate distance if both have location
            if (sender.lat != null && sender.lon != null && client.lat != null && client.lon != null) {
                const dist = getDistanceFromLatLonInKm(sender.lat, sender.lon, client.lat, client.lon);

                // Linear attenuation: 10km limit
                // 0km -> 1.0, 10km -> 0.0
                volume = Math.max(0, 1.0 - (dist / 10.0));

                // If completely out of range, maybe don't send? 
                // Or send with vol 0 so they know someone is there but too far?
                // Let's send with vol 0 for now so debugging is easier, or maybe strictly enforce range.
                // Request said "faintly audible at 10km", so at 10km vol is 0. 
                // Let's stop sending if dist > 10 to save bandwidth?
                if (dist > 10) return;
            }

            const payload = JSON.stringify({
                type: 'signal',
                state: data.state, // 'on' or 'off'
                senderId: data.clientId,
                volume: volume // SECURE: Only sending volume, not coordinates
            });

            client.send(payload);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
