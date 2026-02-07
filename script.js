const freqSlider = document.getElementById('freq-slider');
const freqValue = document.getElementById('freq-value');
const currentFreqDisplay = document.getElementById('current-freq-display');
const volumeSlider = document.getElementById('volume-slider');
const statusDisplay = document.getElementById('status-display');
const pttBtn = document.getElementById('btn-ptt');
const systemLog = document.getElementById('system-log');
const statusIndicator = document.getElementById('connection-status');
const visualizerCanvas = document.getElementById('signal-visualizer');
const visualizerCtx = visualizerCanvas.getContext('2d');

// State
let audioCtx = null;
let gainNode = null;
let ws = null;
let isTransmitting = false;
let currentFreq = 440;
let masterVolume = 0.5;
let mediaStream = null;
let mediaRecorder = null;
let analyser = null;
let noiseBuffer = null;
let activeFrequencies = {}; // Scan results

// Helper: Log
function log(msg) {
    if (systemLog) systemLog.textContent = `> ${msg}`;
    console.log(msg);
}

function setStatus(text, className) {
    statusDisplay.textContent = text;
    statusDisplay.className = 'transceiver-status ' + className;
}

// WebSocket Setup
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';
    const wsUrl = `${protocol}//${window.location.host}${path}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        statusIndicator.textContent = "ONLINE";
        statusIndicator.classList.remove('disconnected');
        statusIndicator.classList.add('connected');
        log("UPLINK ESTABLISHED");
        tuneFrequency(currentFreq);
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'audio') {
                if (audioCtx) {
                    playAudioChunk(data.data, data.freq);
                    setStatus('RECEIVING', 'receiving');
                }
            } else if (data.type === 'scan') {
                activeFrequencies = data.data;
            }
        } catch (e) {
            console.error("WS Error", e);
        }
    };

    ws.onclose = () => {
        statusIndicator.textContent = "OFFLINE";
        statusIndicator.classList.remove('connected');
        statusIndicator.classList.add('disconnected');
        log("CONNECTION LOST. RETRYING...");
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => { console.error("Socket error", err); };
}

function tuneFrequency(freq) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tune', freq: freq }));
    }
}

// Audio System
async function initAudio() {
    if (audioCtx) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;

        gainNode = audioCtx.createGain();
        gainNode.gain.value = masterVolume;

        gainNode.connect(analyser);
        analyser.connect(audioCtx.destination);

        // Noise Buffer
        noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < output.length; i++) {
            output[i] = Math.random() * 2 - 1;
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        log("AUDIO SYSTEM ONLINE");

    } catch (e) {
        console.error("Audio Init Failed", e);
        log("MIC ACCESS DENIED");
    }
}

// Playback
async function playAudioChunk(base64Data, senderFreq) {
    if (!audioCtx) await initAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    clearTimeout(window.rxTimeout);
    window.rxTimeout = setTimeout(() => setStatus('STANDBY', ''), 500);

    try {
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);

        // Interference
        const diff = Math.abs(currentFreq - senderFreq);
        let volRatio = 1.0;
        let noiseRatio = 0.0;

        if (diff > 0) {
            noiseRatio = Math.min((diff / 10) * 0.8, 0.8);
            volRatio = Math.max(1.0 - (diff / 15), 0.0);
        }

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        const voiceGain = audioCtx.createGain();
        voiceGain.gain.value = volRatio;
        source.connect(voiceGain);
        voiceGain.connect(gainNode);
        source.start();

        if (noiseRatio > 0 && noiseBuffer) {
            const nSource = audioCtx.createBufferSource();
            nSource.buffer = noiseBuffer;
            nSource.loop = true;
            const nGain = audioCtx.createGain();
            nGain.gain.value = noiseRatio * 0.3;
            nSource.connect(nGain);
            nGain.connect(gainNode);
            nSource.start();
            nSource.stop(audioCtx.currentTime + audioBuffer.duration);
        }

    } catch (e) {
        console.error("Decode error", e);
    }
}

// Transmission
async function startTransmission(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (isTransmitting) return;

    if (!audioCtx) await initAudio();
    if (!mediaStream) {
        log("NO MICROPHONE");
        return;
    }

    isTransmitting = true;
    pttBtn.classList.add('active');
    setStatus('TRANSMITTING', 'transmitting');

    const options = { mimeType: 'audio/webm;codecs=opus' };
    try {
        mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch (e) {
        mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result.split(',')[1];
                ws.send(JSON.stringify({
                    type: 'audio',
                    freq: currentFreq,
                    data: base64data
                }));
            };
            reader.readAsDataURL(e.data);
        }
    };

    mediaRecorder.start(100);
}

function stopTransmission(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!isTransmitting) return;

    isTransmitting = false;
    pttBtn.classList.remove('active');
    setStatus('STANDBY', '');

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

// Visualizer with Radar
function drawVisualizer() {
    const width = visualizerCanvas.width = visualizerCanvas.parentElement.clientWidth;
    const height = visualizerCanvas.height = visualizerCanvas.parentElement.clientHeight;

    visualizerCtx.clearRect(0, 0, width, height);

    // Radar
    const range = 300;
    const scaleX = width / range;

    Object.keys(activeFrequencies).forEach(fStr => {
        const f = parseInt(fStr);
        const count = activeFrequencies[fStr];
        const diff = f - currentFreq;

        if (Math.abs(diff) < range / 2) {
            const x = width / 2 + (diff * scaleX);
            const alpha = Math.max(0.2, 1.0 - (Math.abs(diff) / (range / 2)));

            visualizerCtx.fillStyle = `rgba(57, 255, 20, ${alpha * 0.4})`;
            const h = Math.min(count * 20, height * 0.8);
            visualizerCtx.fillRect(x - 1, (height - h) / 2, 3, h);

            visualizerCtx.fillStyle = `rgba(57, 255, 20, ${alpha * 0.8})`;
            visualizerCtx.font = '10px monospace';
            visualizerCtx.fillText(`${f}`, x - 10, (height - h) / 2 - 5);
        }
    });

    // Oscilloscope
    visualizerCtx.lineWidth = 2;
    visualizerCtx.strokeStyle = '#39ff14';
    visualizerCtx.beginPath();
    visualizerCtx.moveTo(0, height / 2);

    if (analyser) {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        const sliceWidth = width * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * height / 2;
            if (i === 0) visualizerCtx.moveTo(x, y);
            else visualizerCtx.lineTo(x, y);
            x += sliceWidth;
        }
    } else {
        visualizerCtx.lineTo(width, height / 2);
    }
    visualizerCtx.stroke();
    requestAnimationFrame(drawVisualizer);
}

// Event Listeners
if (pttBtn) {
    ['mousedown', 'touchstart'].forEach(evt => pttBtn.addEventListener(evt, startTransmission));
    ['mouseup', 'mouseleave', 'touchend'].forEach(evt => pttBtn.addEventListener(evt, stopTransmission));
}

freqSlider.addEventListener('input', (e) => {
    currentFreq = parseInt(e.target.value);
    freqValue.textContent = currentFreq;
    if (currentFreqDisplay) currentFreqDisplay.textContent = `FREQ: ${currentFreq}.0 Hz`;
});

freqSlider.addEventListener('change', () => {
    tuneFrequency(currentFreq);
    if (currentFreqDisplay) currentFreqDisplay.textContent = `FREQ: ${currentFreq}.0 Hz`;
});

volumeSlider.addEventListener('input', (e) => {
    masterVolume = parseFloat(e.target.value);
    if (gainNode) gainNode.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.01);
});

// Init
window.addEventListener('load', () => {
    connectWebSocket();
    drawVisualizer();
    if (currentFreqDisplay) currentFreqDisplay.textContent = `FREQ: ${currentFreq}.0 Hz`;

    document.body.addEventListener('click', () => {
        if (!audioCtx) initAudio();
    }, { once: true });
});
