import dotenv from "dotenv";
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";
import speech from "@google-cloud/speech";
import { Writable } from 'stream';
import cors from 'cors';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============== Configuration ===============
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SPEECH: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
        streamingLimit: 290000,
        minSpeakerCount: 1,
        maxSpeakerCount: 6,
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
        profanityFilter: false,
        useEnhanced: true,
        model: 'latest_long'
    },
    BUFFER: {
        minSegmentLength: 50,    
        maxSegmentLength: 500,   
        silenceThresholdMs: 3000 
    },
    CORS: {
        allowedOrigins: [
            'https://recos-meet-addon.vercel.app',
            'http://localhost:3000'
        ]
    }
};

// =============== Error Handling & Validation ===============
class ServerError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
    }
}

const validateEnvironment = () => {
    const required = ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new ServerError(`Missing required environment variables: ${missing.join(', ')}`);
    }
};

// =============== Express Setup ===============
const app = express();

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        if (CONFIG.CORS.allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('[server] Origin not allowed by CORS:', origin);
            callback(new ServerError('Not allowed by CORS', 403));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use((err, req, res, next) => {
    console.error('[server] Error:', err);
    res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || 'Internal Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

app.use((req, res, next) => {
    console.log(`[server] ${req.method} ${req.path} - ${req.ip}`);
    next();
});

app.use(bodyParser.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Meet Add-on Server',
        version: '1.0.0',
        endpoints: ['/health', '/participant-map', '/api/sox/*']
    });
});

// =============== Enhanced Participant Management ===============
class ParticipantManager {
    constructor() {
        this.participants = [];
        this.lastUpdated = null;
    }

    updateParticipants(participantData) {
        if (!Array.isArray(participantData)) {
            throw new ServerError('Invalid participant data format', 400);
        }

        this.participants = participantData.map((participant, index) => ({
            audioIndex: participant.audioIndex ?? index,
            name: participant.name || `Speaker ${index + 1}`,
            id: participant.id || `participant_${index}`,
            joinTime: participant.joinTime || new Date().toISOString()
        }));

        this.lastUpdated = new Date().toISOString();
        console.log('[server] Participant map updated:', this.participants);

        return {
            participants: this.participants,
            lastUpdated: this.lastUpdated,
            count: this.participants.length
        };
    }

    getParticipant(speakerLabel) {
        if (!speakerLabel) return { name: "Unknown", id: "unknown" };

        const index = speakerLabel.charCodeAt(0) - "A".charCodeAt(0);
        return this.participants[index] || {
            name: `Speaker ${speakerLabel}`,
            id: `speaker_${speakerLabel}`
        };
    }

    getAll() {
        return {
            participants: this.participants,
            lastUpdated: this.lastUpdated,
            count: this.participants.length
        };
    }
}

const participantManager = new ParticipantManager();

// =============== Enhanced Audio Device Management ===============
class AudioDeviceManager {
    constructor() {
        this.soxProcess = null;
        this.status = {
            running: false,
            pid: null,
            startTime: null,
            device: null,
            restartCount: 0
        };
    }

    async getDevices() {
        return new Promise((resolve, reject) => {
            exec('which pactl', (error, stdout) => {
                if (error || !stdout.trim()) {
                    return reject(new ServerError(
                        'Audio device management requires PulseAudio (pactl), but it is not installed.',
                        500
                    ));
                }

                exec('pactl list sources', (error, stdout, stderr) => {
                    if (error) {
                        return reject(new ServerError(`Failed to get audio devices: ${error.message}`, 500));
                    }

                    try {
                        const devices = this.parseAudioDevices(stdout);
                        resolve({ success: true, devices });
                    } catch (parseError) {
                        reject(new ServerError(`Failed to parse audio devices: ${parseError.message}`, 500));
                    }
                });
            });
        });
    }

    parseAudioDevices(stdout) {
        const devices = [];
        const lines = stdout.split('\n');
        let currentDevice = null;

        for (const line of lines) {
            if (line.includes('Source #')) {
                if (currentDevice?.name && currentDevice?.description) {
                    devices.push(currentDevice);
                }
                currentDevice = { name: '', description: '' };
            } else if (line.includes('Name:') && currentDevice) {
                currentDevice.name = line.split('Name: ')[1]?.trim() || '';
            } else if (line.includes('Description:') && currentDevice) {
                currentDevice.description = line.split('Description: ')[1]?.trim() || '';
            }
        }

        if (currentDevice?.name && currentDevice?.description) {
            devices.push(currentDevice);
        }

        devices.unshift(
            { name: 'default', description: 'Default input device' },
            { name: 'monitor', description: 'Monitor of output device' }
        );

        return devices;
    }

    async start(device = 'default') {
        if (this.status.running) {
            throw new ServerError('SoxClient is already running', 400);
        }

        try {
            const soxPath = path.join(__dirname, './sox_client.js');
            const backendUrl = process.env.BACKEND_URL || `http://localhost:${CONFIG.PORT}`;
            const wsBackendUrl = backendUrl.replace(/^http/, 'ws');

            this.soxProcess = spawn('node', [soxPath, device, wsBackendUrl], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.soxProcess.stdout?.on('data', (data) => {
                console.log('[sox-client]', data.toString());
            });

            this.soxProcess.stderr?.on('data', (data) => {
                console.error('[sox-client]', data.toString());
            });

            this.soxProcess.unref();

            this.status = {
                running: true,
                pid: this.soxProcess.pid,
                startTime: new Date(),
                device: device,
                restartCount: 0
            };

            console.log(`[server] Started SoxClient with PID ${this.soxProcess.pid} on device ${device}`);

            this.soxProcess.on('exit', (code) => {
                console.log(`[server] SoxClient process exited with code ${code}`);
                this.resetStatus();
            });

            this.soxProcess.on('error', (err) => {
                console.error(`[server] SoxClient error:`, err);
                this.resetStatus();
            });

            return {
                success: true,
                message: "SoxClient started successfully",
                pid: this.soxProcess.pid,
                device: device
            };

        } catch (error) {
            this.resetStatus();
            throw new ServerError(`Failed to start SoxClient: ${error.message}`, 500);
        }
    }

    async stop() {
        if (!this.status.running || !this.soxProcess) {
            throw new ServerError('SoxClient is not running', 400);
        }

        try {
            process.kill(this.status.pid, 'SIGTERM');

            setTimeout(() => {
                if (this.status.running) {
                    console.log('[server] Force killing SoxClient');
                    process.kill(this.status.pid, 'SIGKILL');
                }
            }, 5000);

            this.resetStatus();
            this.soxProcess = null;

            console.log("[server] SoxClient stopped");
            return { success: true, message: "SoxClient stopped successfully" };

        } catch (error) {
            throw new ServerError(`Failed to stop SoxClient: ${error.message}`, 500);
        }
    }

    resetStatus() {
        this.status = {
            running: false,
            pid: null,
            startTime: null,
            device: null,
            restartCount: this.status.restartCount + 1
        };
    }

    getStatus() {
        return this.status;
    }
}

const audioDeviceManager = new AudioDeviceManager();

// =============== Enhanced Speech Processing ===============
class SpeechProcessor {
    constructor() {
        this.credentials = this.loadCredentials();
        this.client = new speech.SpeechClient({ credentials: this.credentials });
        this.recognizeStream = null;
        this.restartCounter = 0;
        this.audioInput = [];
        this.lastAudioInput = [];
        this.resultEndTime = 0;
        this.isFinalEndTime = 0;
        this.finalRequestEndTime = 0;
        this.newStream = true;
        this.bridgingOffset = 0;
        this.isStreamAlive = false;
        this.streamTimeout = null;
        this.pendingRestart = false;
        this.speakerBuffer = {};
        this.lastSpeechTime = {};
    }

    loadCredentials() {
        const base64Credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (!base64Credentials) {
            throw new ServerError('Missing Google Cloud credentials', 500);
        }

        try {
            return JSON.parse(Buffer.from(base64Credentials, 'base64').toString('utf8'));
        } catch (error) {
            throw new ServerError('Invalid Google Cloud credentials format', 500);
        }
    }

    startStream() {
        if (this.streamTimeout) {
            clearTimeout(this.streamTimeout);
            this.streamTimeout = null;
        }

        this.cleanup();
        this.resetStreamState();

        const request = {
            config: {
                encoding: CONFIG.SPEECH.encoding,
                sampleRateHertz: CONFIG.SPEECH.sampleRateHertz,
                languageCode: CONFIG.SPEECH.languageCode,
                enableAutomaticPunctuation: true,
                diarizationConfig: {
                    enableSpeakerDiarization: true,
                    minSpeakerCount: CONFIG.SPEECH.minSpeakerCount,
                    maxSpeakerCount: CONFIG.SPEECH.maxSpeakerCount,
                },
                model: 'latest_long',
                useEnhanced: true,
            },
            interimResults: true,
        };

        this.recognizeStream = this.client
            .streamingRecognize(request)
            .on('error', (err) => this.handleStreamError(err))
            .on('data', (stream) => this.handleSpeechData(stream))
            .on('end', () => this.handleStreamEnd());

        this.streamTimeout = setTimeout(() => {
            console.log('[speech-stream] Restarting due to time limit');
            this.restartStream();
        }, CONFIG.SPEECH.streamingLimit);

        console.log(`[speech-stream] Stream started (restart counter: ${this.restartCounter})`);
    }

    resetStreamState() {
        this.audioInput = [];
        this.lastAudioInput = [];
        this.resultEndTime = 0;
        this.isFinalEndTime = 0;
        this.finalRequestEndTime = 0;
        this.newStream = true;
        this.bridgingOffset = 0;
        this.isStreamAlive = true;
        this.pendingRestart = false;
    }

    cleanup() {
        if (this.recognizeStream) {
            try {
                this.recognizeStream.end();
                this.recognizeStream.removeAllListeners();
            } catch (err) {
                console.error('[speech-stream] Error cleaning up previous stream:', err);
            }
            this.recognizeStream = null;
        }
    }

    handleStreamError(err) {
        console.error('[speech-stream] API error:', err);
        this.isStreamAlive = false;

        if (!this.pendingRestart) {
            this.pendingRestart = true;
            if (err.code === 11) { 
                console.log('[speech-stream] Restarting due to timeout');
                this.restartStream();
            } else {
                console.error('[speech-stream] Non-timeout error:', err);
                setTimeout(() => this.restartStream(), 1000);
            }
        }
    }

    handleStreamEnd() {
        console.log('[speech-stream] Stream ended naturally');
        this.isStreamAlive = false;

        if (!this.pendingRestart) {
            this.pendingRestart = true;
            this.restartStream();
        }
    }

    restartStream() {
        if (this.pendingRestart) return;

        this.pendingRestart = true;
        console.log(`[speech-stream] Restarting stream (counter: ${this.restartCounter})`);

        if (this.streamTimeout) {
            clearTimeout(this.streamTimeout);
            this.streamTimeout = null;
        }

        this.isStreamAlive = false;
        this.cleanup();

        if (this.resultEndTime > 0) {
            this.finalRequestEndTime = this.isFinalEndTime;
            this.lastAudioInput = [...this.audioInput];
        }

        this.audioInput = [];
        this.resultEndTime = 0;
        this.newStream = true;
        this.restartCounter++;

        const delay = Math.min(1000 * Math.pow(1.5, this.restartCounter % 5), 10000);

        setTimeout(() => {
            this.startStream();
        }, delay);
    }
   
    handleSpeechData(stream) {
        try {
            if (stream.results[0] && stream.results[0].resultEndTime) {
                this.resultEndTime =
                    stream.results[0].resultEndTime.seconds * 1000 +
                    Math.round(stream.results[0].resultEndTime.nanos / 1000000);
            }

            const correctedTime =
                this.resultEndTime - this.bridgingOffset + CONFIG.SPEECH.streamingLimit * this.restartCounter;

            if (stream.results[0] && stream.results[0].alternatives[0]) {
                const transcript = stream.results[0].alternatives[0].transcript;
                const isFinal = stream.results[0].isFinal;

                let speakerTag = 'Unknown';
                if (stream.results[0].alternatives[0].words &&
                    stream.results[0].alternatives[0].words.length > 0) {
                    speakerTag = stream.results[0].alternatives[0].words[0].speakerTag || 'Unknown';
                }

                const mappedSpeaker = this.mapSpeakerLabel(`${speakerTag}`);

                if (isFinal) {
                    console.log(`[speech-stream] ${correctedTime}: ${mappedSpeaker} - ${transcript}`);

                    if (!this.speakerBuffer[mappedSpeaker]) {
                        this.speakerBuffer[mappedSpeaker] = '';
                        this.lastSpeechTime[mappedSpeaker] = Date.now();
                    }

                    this.speakerBuffer[mappedSpeaker] += ' ' + transcript;
                    this.lastSpeechTime[mappedSpeaker] = Date.now();

                    const shouldProcess =
                        this.speakerBuffer[mappedSpeaker].length >= CONFIG.BUFFER.maxSegmentLength ||
                        (this.speakerBuffer[mappedSpeaker].length >= CONFIG.BUFFER.minSegmentLength &&
                            Date.now() - this.lastSpeechTime[mappedSpeaker] > CONFIG.BUFFER.silenceThresholdMs);

                    if (shouldProcess) {
                        const textToAnalyze = this.speakerBuffer[mappedSpeaker].trim();

                        if (textToAnalyze.length > CONFIG.BUFFER.minSegmentLength) {
                            this.emit('analysis', {
                                speaker: mappedSpeaker,
                                text: textToAnalyze,
                                speakerTag: speakerTag,
                                timestamp: correctedTime
                            });
                        }

                        this.speakerBuffer[mappedSpeaker] = '';
                    } else {
                        this.emit('transcript', {
                            transcript: transcript,
                            speaker: mappedSpeaker,
                            speakerTag: speakerTag,
                            isFinal: true,
                            timestamp: correctedTime,
                            buffered: false
                        });
                    }
                } else {
                    this.emit('transcript', {
                        transcript: transcript,
                        speaker: mappedSpeaker,
                        speakerTag: speakerTag,
                        isFinal: false,
                        timestamp: correctedTime
                    });
                }
            }
        } catch (error) {
            console.error('[speech-stream] Error processing speech callback:', error);
        }
    }

    mapSpeakerLabel(label) {
        if (!label) return "Unknown";
        const index = label.charCodeAt(0) - "A".charCodeAt(0);
        return participantManager.participants[index]?.name || `Speaker ${label}`;
    }

    createAudioStream() {
        return new Writable({
            write: (chunk, encoding, next) => {
                try {
                    if (!this.isStreamAlive || !this.recognizeStream) {
                        return next();
                    }

                    if (this.newStream && this.lastAudioInput.length > 0) {
                        const chunkTime = CONFIG.SPEECH.streamingLimit / this.lastAudioInput.length;
                        if (chunkTime !== 0) {
                            if (this.bridgingOffset < 0) {
                                this.bridgingOffset = 0;
                            }
                            if (this.bridgingOffset > this.finalRequestEndTime) {
                                this.bridgingOffset = this.finalRequestEndTime;
                            }
                            const chunksFromMS = Math.floor(
                                (this.finalRequestEndTime - this.bridgingOffset) / chunkTime
                            );
                            this.bridgingOffset = Math.floor(
                                (this.lastAudioInput.length - chunksFromMS) * chunkTime
                            );

                            for (let i = chunksFromMS; i < this.lastAudioInput.length; i++) {
                                if (this.recognizeStream && this.isStreamAlive) {
                                    this.recognizeStream.write(this.lastAudioInput[i]);
                                } else {
                                    break;
                                }
                            }
                        }
                        this.newStream = false;
                        this.lastAudioInput = [];
                    }

                    this.audioInput.push(chunk);

                    if (this.recognizeStream && this.isStreamAlive) {
                        this.recognizeStream.write(chunk);
                    }

                    next();
                } catch (error) {
                    console.error('[speech-stream] Error writing to stream:', error);
                    next();
                }
            },

            final() {
                console.log('[speech-stream] Audio stream ended');
            }
        });
    }
}

Object.assign(SpeechProcessor.prototype, {
    _events: {},
    on(event, callback) {
        if (!this._events[event]) {
            this._events[event] = [];
        }
        this._events[event].push(callback);
    },
    emit(event, data) {
        if (this._events[event]) {
            this._events[event].forEach(callback => callback(data));
        }
    }
});

// =============== Enhanced Gemini Analysis ===============
class GeminiAnalyzer {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        this.requestCount = 0;
        this.errorCount = 0;
    }

    async analyze(speaker, text) {
        this.requestCount++;

        const prompt = `
            You are assisting in a recruiter interview.
            Speaker: ${speaker}
            Transcript: "${text}"

            Tasks:
            1. Summarize the intent of what the speaker said in one sentence.
            2. Extract semantic meaning (skills, experience, attitude).
            3. Suggest 1-2 recruiter follow-up questions based on this.
            
            Return ONLY valid JSON with fields: 
            { 
                "summary": "...", 
                "semantics": "...", 
                "questions": ["...", "..."],
                "confidence": 0.95,
                "keywords": ["skill1", "skill2"]
            }.
            
            Do not include any markdown formatting or code blocks.
        `;

        try {
            const resp = await this.model.generateContent(prompt);
            const raw = resp.response.text();

            return this.parseResponse(raw);
        } catch (err) {
            this.errorCount++;
            console.error("[gemini] Analysis error:", err);
            return this.getFallbackResponse();
        }
    }

    parseResponse(raw) {
        let cleanedRaw = raw.trim();

        if (cleanedRaw.startsWith('```json')) {
            cleanedRaw = cleanedRaw.replace(/```json\n?/, '');
            cleanedRaw = cleanedRaw.replace(/\n?```$/, '');
        } else if (cleanedRaw.startsWith('```')) {
            cleanedRaw = cleanedRaw.replace(/```\n?/, '');
            cleanedRaw = cleanedRaw.replace(/\n?```$/, '');
        }

        try {
            const parsed = JSON.parse(cleanedRaw);

            const required = ['summary', 'semantics', 'questions'];
            const missing = required.filter(field => !parsed[field]);

            if (missing.length > 0) {
                throw new Error(`Missing required fields: ${missing.join(', ')}`);
            }

            return {
                ...parsed,
                confidence: parsed.confidence || 0.8,
                keywords: parsed.keywords || []
            };

        } catch (parseError) {
            console.error('[gemini] Failed to parse response:', parseError);
            console.error('[gemini] Raw response:', raw);

            return this.extractFallbackData(cleanedRaw, raw);
        }
    }

    extractFallbackData(cleanedRaw, raw) {
        const summaryMatch = cleanedRaw.match(/"summary"\s*:\s*"([^"]*)"/);
        const semanticsMatch = cleanedRaw.match(/"semantics"\s*:\s*"([^"]*)"/);
        const questionsMatch = cleanedRaw.match(/"questions"\s*:\s*\[([^\]]*)\]/);

        const summary = summaryMatch ? summaryMatch[1] : raw.substring(0, 200);
        const semantics = semanticsMatch ? semanticsMatch[1] : "";
        let questions = [];

        if (questionsMatch) {
            try {
                questions = JSON.parse(`[${questionsMatch[1]}]`);
            } catch (e) {
                const questionMatches = questionsMatch[1].match(/"([^"]*)"/g);
                if (questionMatches) {
                    questions = questionMatches.map(match => match.replace(/^"|"$/g, ''));
                }
            }
        }

        return {
            summary,
            semantics,
            questions,
            confidence: 0.5,
            keywords: []
        };
    }

    getFallbackResponse() {
        return {
            summary: "Analysis unavailable",
            semantics: "",
            questions: [],
            confidence: 0.0,
            keywords: []
        };
    }

    getStats() {
        return {
            requestCount: this.requestCount,
            errorCount: this.errorCount,
            successRate: this.requestCount > 0 ? (this.requestCount - this.errorCount) / this.requestCount : 0
        };
    }
}

// =============== API Routes ===============
app.post("/participant-map", (req, res, next) => {
    try {
        const result = participantManager.updateParticipants(req.body);
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

app.get("/participant-map", (req, res) => {
    const result = participantManager.getAll();
    res.json({ success: true, ...result });
});

app.get("/api/sox/status", (req, res) => {
    res.json({ success: true, status: audioDeviceManager.getStatus() });
});

app.post("/api/sox/start", async (req, res, next) => {
    try {
        const { device = "default" } = req.body;
        const result = await audioDeviceManager.start(device);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.post("/api/sox/stop", async (req, res, next) => {
    try {
        const result = await audioDeviceManager.stop();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get("/api/sox/devices", async (req, res, next) => {
    try {
        const result = await audioDeviceManager.getDevices();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

const geminiAnalyzer = new GeminiAnalyzer();

app.get("/api/analytics", (req, res) => {
    res.json({
        success: true,
        gemini: geminiAnalyzer.getStats(),
        participants: participantManager.getAll(),
        sox: audioDeviceManager.getStatus()
    });
});

// =============== WebSocket Server ===============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/audio" });

const speechProcessor = new SpeechProcessor();

speechProcessor.on('transcript', (data) => {
    const { transcript, speaker, speakerTag, isFinal, timestamp } = data;

    const transcriptData = {
        transcript: transcript,
        speaker_name: speaker,
        speaker_tag: speakerTag,
        message_type: isFinal ? "final_transcript" : "interim_transcript",
        end_of_turn: false,
        timestamp: timestamp,
        is_final: isFinal
    };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(transcriptData));
        }
    });
});

speechProcessor.on('analysis', async (data) => {
    const { speaker, text, speakerTag, timestamp } = data;

    try {
        const analysis = await geminiAnalyzer.analyze(speaker, text);

        const enriched = {
            transcript: text,
            speaker_name: speaker,
            speaker_tag: speakerTag,
            analysis: analysis,
            message_type: "enriched_transcript",
            end_of_turn: true,
            timestamp: timestamp,
            is_final: true
        };

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(enriched));
            }
        });
    } catch (error) {
        console.error('[server] Error in Gemini analysis:', error);
    }
});

wss.on("connection", (client, req) => {
    const origin = req.headers.origin;

    if (origin && !CONFIG.CORS.allowedOrigins.includes(origin) && origin !== 'null') {
        console.log('[server] WebSocket connection rejected from origin:', origin);
        client.close(1008, 'Origin not allowed');
        return;
    }

    console.log("[server] Bot audio WS connected from", origin);

    let isFirstConnection = wss.clients.size === 1;
    let audioStream = null;

    audioStream = speechProcessor.createAudioStream();

    if (isFirstConnection) {
        speechProcessor.startStream();
    }

    client.on("message", (msg) => {
        try {
            if (audioStream && msg instanceof Buffer) {
                audioStream.write(msg);
            }
        } catch (error) {
            console.error('[server] Error processing audio message:', error);
        }
    });

    client.on("close", () => {
        console.log("[server] Bot WS closed");
        if (audioStream) {
            audioStream.end();
        }

        if (wss.clients.size === 0) {
            console.log("[server] No more clients, stopping stream");
            if (speechProcessor.streamTimeout) {
                clearTimeout(speechProcessor.streamTimeout);
                speechProcessor.streamTimeout = null;
            }
            speechProcessor.isStreamAlive = false;
            speechProcessor.cleanup();
            // Reset state
            speechProcessor.audioInput = [];
            speechProcessor.lastAudioInput = [];
            speechProcessor.restartCounter = 0;
            speechProcessor.pendingRestart = false;
        }
    });

    client.on("error", (error) => {
        console.error("[server] WebSocket client error:", error);
    });
});

// =============== Server Startup ===============
const startServer = async () => {
    try {
        validateEnvironment();

        server.listen(CONFIG.PORT, () => {
            console.log(`[server] Server started on port ${CONFIG.PORT}`);
            console.log(`[server] Health check: http://localhost:${CONFIG.PORT}/health`);
            console.log(`[server] WebSocket: ws://localhost:${CONFIG.PORT}/ws/audio`);
        });

    } catch (error) {
        console.error('[server] Failed to start server:', error);
        process.exit(1);
    }
};

// =============== Graceful Shutdown ===============
const gracefulShutdown = async () => {
    console.log('\n[server] Shutting down gracefully...');

    try {
        // Stop sox process if running
        if (audioDeviceManager.getStatus().running) {
            await audioDeviceManager.stop();
        }

        // Close WebSocket connections
        wss.clients.forEach((client) => {
            client.close(1001, 'Server shutting down');
        });

        // Close HTTP server
        server.close(() => {
            console.log('[server] HTTP server closed');
            process.exit(0);
        });

        // Force exit after 10 seconds
        setTimeout(() => {
            console.log('[server] Force exit');
            process.exit(1);
        }, 10000);

    } catch (error) {
        console.error('[server] Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start the server
startServer();