const freqSlider = document.getElementById('freq-slider');
const freqValue = document.getElementById('freq-value');
const volumeSlider = document.getElementById('volume-slider');
const statusDisplay = document.getElementById('status-display');
const pttBtn = document.getElementById('btn-ptt');
const systemLog = document.getElementById('system-log');
const statusIndicator = document.getElementById('connection-status');
const currentFreqDisplay = document.getElementById('current-freq-display');
const paddlesContainer = document.getElementById('paddles-container');
const paddleLeft = document.getElementById('paddle-left'); // DOT
const paddleRight = document.getElementById('paddle-right'); // DASH

// State
let audioCtx = null;
let oscillator = null;
let gainNode = null;
let ws = null;
let isTransmitting = false;
let currentFreq = 440;
let masterVolume = 0.5;

// Feedback State
let enableSound = true;
let enableLight = true;
let enableVibe = false;

// Decoder State
let lastSignalTime = 0;
let lastSignalEndFunc = null; // Time when LAST signal ended
let signalStartFunc = null;   // Time when CURRENT signal started
let decoderBuffer = "";       // Builds up .-.. etc
let decoderTimeout = null;
const TIME_UNIT = 60; // Base timing in ms (adjust manually or auto-detect eventually)

// Keyer State
let isKeyerMode = false;
let keyerWpm = 20;
let keyerUnit = 1200 / keyerWpm;
let keyerInterval = null;
let paddleState = { left: false, right: false }; // left=dot, right=dash
let keyerNext = null; // 'dot', 'dash', or null

// Init Toggles
if (fbSoundCheck) {
    enableSound = fbSoundCheck.checked;
    fbSoundCheck.addEventListener('change', (e) => enableSound = e.target.checked);
}
if (fbLightCheck) {
    enableLight = fbLightCheck.checked;
    fbLightCheck.addEventListener('change', (e) => enableLight = e.target.checked);
}
if (fbVibeCheck) {
    enableVibe = fbVibeCheck.checked;
    fbVibeCheck.addEventListener('change', (e) => {
        enableVibe = e.target.checked;
        if (enableVibe && navigator.vibrate) navigator.vibrate(50); // Test buzz
    });
}

// Audio Setup
function initAudio() {
    if (audioCtx) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioCtx.destination);

    oscillator = audioCtx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 600;
    oscillator.connect(gainNode);
    oscillator.start();
}



function startTone() {
    // Feedback: SOUND
    if (enableSound) {
        if (!audioCtx) initAudio();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
        gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(masterVolume, audioCtx.currentTime + 0.005);
    }

    // Feedback: LIGHT & VIBE
    if (enableLight) {
        document.body.style.backgroundColor = '#1a2a1a'; // Subtle flash
        setTimeout(() => document.body.style.backgroundColor = '', 50);
    }

    if (enableVibe && navigator.vibrate) {
        try { navigator.vibrate(50); } catch (e) { }
    }


    // Visuals
    if (!isKeyerMode) telegraphKey.classList.add('active'); // Only light up manual key if in manual?
    // Actually we can light up whichever is active.

    drawSignal(true);
}

function stopTone() {
    if (!audioCtx) return;

    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.005);

    if (!isKeyerMode) telegraphKey.classList.remove('active');

    drawSignal(false);
}


// Location State REMOVED


// WebSocket Setup
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Append current path to support subdirectories (e.g. aeoyna.com/morse)
    // Ensure trailing slash for consistent WebSocket connection
    const path = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    const wsUrl = `${protocol}//${window.location.host}${path}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        statusIndicator.textContent = "ONLINE";
        statusIndicator.classList.remove('disconnected');
        statusIndicator.classList.add('connected');

        // Re-tune if we were already on a freq
        tuneFrequency(currentFreq);
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'signal') {
            handleReceivedSignal(data.state, data.volume);
        } else if (data.type === 'status') {
            console.log("Server:", data.msg);
        }
    };

    ws.onclose = () => {
        statusIndicator.textContent = "OFFLINE";
        statusIndicator.classList.remove('connected');
        statusIndicator.classList.add('disconnected');
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => { console.error("Socket error", err); };
}

function tuneFrequency(freq) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Send tune request
        const payload = { type: 'tune', freq: freq };
        ws.send(JSON.stringify(payload));

        if (currentFreqDisplay) {
            currentFreqDisplay.textContent = `FREQ: ${freq}.0 Hz`;
        }
        // Update display logic if needed needed? 
        // freqValue is updated by slider listener. 
        // If we tune programmatically, we should update slider too.
        // But usually tuning happens via slider.
    }
}

function sendSignal(state) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = {
            type: 'signal',
            state: state,
            clientId: 'me'
        };
        // Always send latest location just in case I moved
        if (myLat !== null && myLon !== null) {
            payload.lat = myLat;
            payload.lon = myLon;
        }
        ws.send(JSON.stringify(payload));
    }
}


// ----------------------------------------------------------------------
// DECODER LOGIC
// ----------------------------------------------------------------------

function handleReceivedSignal(state) {
    const now = Date.now();

    if (state === 'on') {
        startTone(); // Modified startTone signature below


        // Gap calculation: how long was it OFF?
        if (lastSignalEndFunc) {
            const gapDuration = now - lastSignalEndFunc;

            // Heuristic for spacing
            // 3 units = Letter Gap
            // 7 units = Word Gap
            // Using a flexible adaptive timing or fixed standard for now?
            // Let's use simpler fixed thresholds for beta.
            // Assuming approx 20 WPM standard (60ms unit) -> 3 units = 180ms, 7 units = 420ms

            if (gapDuration > keyerUnit * 6) { // Word space
                decodeChar(' ');
                decoderBuffer = "";
            } else if (gapDuration > keyerUnit * 2.5) { // Letter space
                decodeBuffer();
            }
        }

        signalStartFunc = now;

    } else { // state === 'off'
        stopTone();

        // Tone Duration
        if (signalStartFunc) {
            const duration = now - signalStartFunc;
            lastSignalEndFunc = now;

            // Dot vs Dash
            // Dot = 1 unit, Dash = 3 units.
            // Threshold = 1.5 units?
            // If < 2 * unit -> Dot
            // If > 2 * unit -> Dash

            if (duration > keyerUnit * 2) {
                decoderBuffer += "-";
            } else {
                decoderBuffer += ".";
            }

            // Wait to see if more comes, or if we should decode a character
            clearTimeout(decoderTimeout);
            decoderTimeout = setTimeout(() => {
                decodeBuffer();
            }, keyerUnit * 4); // Wait > 3 units to confirm end of char
        }
    }
}

function decodeBuffer() {
    if (!decoderBuffer) return;

    // Look up buffer in MORSE_TO_CHAR
    // Check if 'morse_dict.js' loaded properly? We assume yes.
    if (typeof MORSE_TO_CHAR !== 'undefined') {
        const char = MORSE_TO_CHAR[decoderBuffer] || '?';
        decodeChar(char);
    } else {
        console.warn("Dictionary not loaded");
    }
    decoderBuffer = "";
}

function decodeChar(char) {
    incomingText.textContent += char;
    incomingText.scrollTop = incomingText.scrollHeight;
}

// ----------------------------------------------------------------------
// ELECTRONIC KEYER LOGIC
// ----------------------------------------------------------------------

function startKeyerLoop() {
    if (keyerInterval) return;

    // We utilize a simple state machine loop for Iambic Mode B behavior (or simpler A)
    // Actually, simpler approach:
    // If paddle pressed, schedule Dot or Dash.

    let isBusy = false; // Is currently playing a symbol or space

    keyerInterval = setInterval(() => {
        if (isBusy) return;

        // Check paddles
        let symbol = null;

        if (paddleState.left) symbol = 'dot';
        if (paddleState.right) symbol = 'dash';

        // Priority / Iambic Squeeze
        // For simple Iambic, we can just alternate if both held.
        // Let's do simple priority for now: Left (Dot) if not busy? 
        // Or implement a queue.

        if (symbol) {
            isBusy = true;
            playElement(symbol).then(() => {
                isBusy = false;
            });
        }

    }, 10); // High polling rate
}

function stopKeyerLoop() {
    clearInterval(keyerInterval);
    keyerInterval = null;
}

function playElement(type) {
    return new Promise(resolve => {
        // Dot: 1 ON, 1 OFF
        // Dash: 3 ON, 1 OFF

        const onTime = type === 'dot' ? keyerUnit : keyerUnit * 3;

        // Transmit ON
        startTone();
        sendSignal('on');
        handleReceivedSignal('on'); // Feed local decoder

        if (type === 'dot') paddleLeft.classList.add('active');
        if (type === 'dash') paddleRight.classList.add('active');

        setTimeout(() => {
            // Transmit OFF
            stopTone();
            sendSignal('off');
            handleReceivedSignal('off'); // Feed local decoder

            if (type === 'dot') paddleLeft.classList.remove('active');
            if (type === 'dash') paddleRight.classList.remove('active');

            // Intra-char space (1 unit)
            setTimeout(() => {
                resolve();
            }, keyerUnit);

        }, onTime);
    });
}

// ----------------------------------------------------------------------
// EVENT LISTENERS
// ----------------------------------------------------------------------

// Toggle Mode
keyerModeToggle.addEventListener('change', (e) => {
    isKeyerMode = e.target.checked;

    if (isKeyerMode) {
        keyerModeLabel.textContent = "AUTO KEYER (IAMBIC)";
        telegraphKey.style.display = 'none';
        paddlesContainer.style.display = 'flex';
        startKeyerLoop();
    } else {
        keyerModeLabel.textContent = "MANUAL KEY";
        telegraphKey.style.display = 'inline-block';
        paddlesContainer.style.display = 'none';
        stopKeyerLoop();
    }
});

// Init Audio
document.body.addEventListener('click', () => {
    if (!audioCtx) initAudio();
}, { once: true });

// Manual Key (Mouse/Touch)
function handleKeyStart(e) {
    if (isKeyerMode) return;
    e.preventDefault();
    if (!isTransmitting) {
        isTransmitting = true;
        startTone();
        sendSignal('on');
        handleReceivedSignal('on');
    }
}

function handleKeyStop(e) {
    if (isKeyerMode) return;
    e.preventDefault();
    if (isTransmitting) {
        isTransmitting = false;
        stopTone();
        sendSignal('off');
        handleReceivedSignal('off');
    }
}

telegraphKey.addEventListener('mousedown', handleKeyStart);
telegraphKey.addEventListener('touchstart', handleKeyStart);

telegraphKey.addEventListener('mouseup', handleKeyStop);
telegraphKey.addEventListener('mouseleave', handleKeyStop);
telegraphKey.addEventListener('touchend', handleKeyStop);

// Mouse/Touch Paddles
paddleLeft.addEventListener('mousedown', (e) => { e.preventDefault(); paddleState.left = true; });
paddleLeft.addEventListener('mouseup', (e) => { e.preventDefault(); paddleState.left = false; });
paddleLeft.addEventListener('mouseleave', (e) => { e.preventDefault(); paddleState.left = false; });

paddleRight.addEventListener('mousedown', (e) => { e.preventDefault(); paddleState.right = true; });
paddleRight.addEventListener('mouseup', (e) => { e.preventDefault(); paddleState.right = false; });
paddleRight.addEventListener('mouseleave', (e) => { e.preventDefault(); paddleState.right = false; });

// Keyboard Controls
document.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    if (e.code === 'Space' && !isKeyerMode) {
        // Manual
        if (!isTransmitting) {
            isTransmitting = true;
            startTone();
            sendSignal('on');
            handleReceivedSignal('on');
        }
    }

    if (isKeyerMode) {
        if (e.key.toLowerCase() === 'z') paddleState.left = true;
        if (e.key.toLowerCase() === 'x') paddleState.right = true;
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isKeyerMode) {
        if (isTransmitting) {
            isTransmitting = false;
            stopTone();
            sendSignal('off');
            handleReceivedSignal('off');
        }
    }

    if (isKeyerMode) {
        if (e.key.toLowerCase() === 'z') paddleState.left = false;
        if (e.key.toLowerCase() === 'x') paddleState.right = false;
    }
});

// Slider updates
freqSlider.addEventListener('input', (e) => {
    currentFreq = e.target.value;
    freqValue.textContent = currentFreq;
});
freqSlider.addEventListener('change', () => tuneFrequency(currentFreq));

volumeSlider.addEventListener('input', (e) => {
    masterVolume = parseFloat(e.target.value);
    if (gainNode && isTransmitting) {
        gainNode.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.01);
    }
});



// Visualizer
function drawSignal(isActive) {
    const width = visualizerCanvas.width = visualizerCanvas.parentElement.clientWidth;
    const height = visualizerCanvas.height = visualizerCanvas.parentElement.clientHeight;

    visualizerCtx.clearRect(0, 0, width, height);
    visualizerCtx.beginPath();
    visualizerCtx.strokeStyle = isActive ? '#39ff14' : '#1e800a';
    visualizerCtx.lineWidth = 2;
    visualizerCtx.moveTo(0, height / 2);

    if (isActive) {
        for (let i = 0; i < width; i += 5) {
            const jitter = (Math.random() - 0.5) * height * 0.8;
            visualizerCtx.lineTo(i, height / 2 + jitter);
        }
    } else {
        visualizerCtx.lineTo(width, height / 2);
    }
    visualizerCtx.stroke();

    if (isActive) {
        requestAnimationFrame(() => drawSignal(true));
    }
}

// Init
window.addEventListener('load', () => {
    connectWebSocket();
    drawSignal(false);
});
