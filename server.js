import dotenv from "dotenv";
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";
import speech from "@google-cloud/speech";
import { Writable } from 'stream';
import cors from 'cors';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
globalThis.fetch = fetch;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============== Configuration ===============
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SPEECH: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
        streamingLimit: 600000,
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
        silenceThresholdMs: 2000
    },
    CORS: {
        allowedOrigins: [
            'https://recos-meet-addon.vercel.app',
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:10000',
            'https://gmeet-bot.onrender.com'
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
    const required = ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'DJANGO_API_TOKEN'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new ServerError(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (!process.env.DJANGO_API_URL) {
        console.warn('[server] DJANGO_API_URL not set, using default: http://localhost:8000/api');
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
        endpoints: [
            '/health',
            '/participant-map',
            '/api/sox/*',
            '/api/bot/*',
            '/api/analytics'
        ],
        services: {
            speech: 'Active',
            gemini: 'Active',
            bot: 'Available',
            sox: 'Available'
        }
    });
});

// =============== Interview Management ===============
class InterviewManager {
    constructor() {
        this.currentInterview = null;
        this.interviews = new Map();
        this.djangoUrl = process.env.DJANGO_API_URL || 'http://localhost:8000/api';
        this.apiToken = process.env.DJANGO_API_TOKEN;
    }

    async fetchInterviews(token) {
        try {
            console.log('[interview-manager] Fetching interviews from Django...');

            const response = await fetch(`${this.djangoUrl}/interview/`, {
                headers: {
                    'Authorization': `Token ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch interviews: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`[interview-manager] Loaded ${data.length} interviews`);


            this.interviews.clear();

            data.forEach(interview => {
                this.interviews.set(interview.interview_id, interview);
            });

            return data;
        } catch (error) {
            console.error('[interview-manager] Error fetching interviews:', error);
            throw new ServerError(`Failed to fetch interviews: ${error.message}`, 500);
        }
    }

    async getInterviewById(interviewId, token) {
        if (this.interviews.has(interviewId)) {
            return this.interviews.get(interviewId);
        }

        try {
            const response = await fetch(`${this.djangoUrl}/interview/${interviewId}/`, {
                headers: {
                    'Authorization': `Token ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Interview ${interviewId} not found`);
            }

            const interview = await response.json();
            this.interviews.set(interviewId, interview);
            return interview;
        } catch (error) {
            console.error(`[interview-manager] Error fetching interview ${interviewId}:`, error);
            return null;
        }
    }

    setCurrentInterview(interviewId, meetLink, duration, token) {
        this.currentInterview = {
            id: interviewId,
            meet_link: meetLink,
            duration: duration,
            token: token,
            startTime: new Date().toISOString(),
            status: 'starting'
        };

        console.log(`[interview-manager] Set current interview: ID ${interviewId}, Meet: ${meetLink}`);
        return this.currentInterview;
    }

    getCurrentInterview() {
        return this.currentInterview;
    }

    clearCurrentInterview() {
        this.currentInterview = null;
        console.log('[interview-manager] Cleared current interview');
    }

    getAllInterviews() {
        return Array.from(this.interviews.values());
    }
}

const interviewManager = new InterviewManager();

// =============== Bot Management ===============
class BotManager {
    constructor() {
        this.botUrl = process.env.BOT_SERVICE_URL || 'http://localhost:10000';
        this.currentSession = null;
        this.status = 'idle';
    }

    async startBot(meetLink, duration = 60, token, interview_id) {
        try {
            console.log(`[bot-manager] Starting bot for meeting: ${meetLink}`);
            console.log(`[bot-manager] Using bot service URL: ${this.botUrl}`);

            try {
                const healthResponse = await fetch(`${this.botUrl}/health`);
                if (!healthResponse.ok) {
                    console.error(`[bot-manager] Bot service health check failed: ${healthResponse.status}`);
                    const healthText = await healthResponse.text();
                    console.error(`[bot-manager] Health check response: ${healthText.substring(0, 200)}`);
                } else {
                    const healthData = await healthResponse.json();
                    console.log(`[bot-manager] Bot service health: ${JSON.stringify(healthData)}`);
                }
            } catch (healthError) {
                console.error(`[bot-manager] Bot service health check error: ${healthError.message}`);
                throw new Error(`Bot service is unreachable: ${healthError.message}`);
            }

            const response = await fetch(`${this.botUrl}/start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    meet_link: meetLink,
                    duration: duration,
                    token: `Token ${token}`,
                    interview_id: interview_id
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[bot-manager] Bot service returned error: ${response.status}`);
                console.error(`[bot-manager] Error response content type: ${response.headers.get('content-type')}`);
                console.error(`[bot-manager] Error response (first 500 chars): ${errorText.substring(0, 500)}`);
                throw new Error(`Bot service returned ${response.status}: ${errorText.substring(0, 200)}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const responseText = await response.text();
                console.error('[bot-manager] Expected JSON but got:', contentType, responseText.substring(0, 200));
                throw new Error(`Bot service returned non-JSON response: ${contentType}`);
            }

            const result = await response.json();

            if (result.success) {
                this.currentSession = {
                    meetLink: meetLink,
                    startTime: new Date().toISOString(),
                    duration: duration,
                    status: 'starting'
                };
                this.status = 'starting';

                console.log(`[bot-manager] Bot started successfully: ${meetLink}`);
                return { success: true, ...result };
            } else {
                throw new ServerError(result.error || 'Failed to start bot', 500);
            }

        } catch (error) {
            console.error('[bot-manager] Error starting bot:', error);
            throw new ServerError(`Failed to start bot: ${error.message}`, 500);
        }
    }

    async stopBot() {
        try {
            console.log('[bot-manager] Stopping bot...');

            const response = await fetch(`${this.botUrl}/stop`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[bot-manager] Bot service returned error:', response.status, errorText);
                throw new Error(`Bot service returned ${response.status}: ${errorText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const responseText = await response.text();
                console.error('[bot-manager] Expected JSON but got:', contentType, responseText.substring(0, 200));
                throw new Error(`Bot service returned non-JSON response: ${contentType}`);
            }

            const result = await response.json();

            if (result.success) {
                this.currentSession = null;
                this.status = 'idle';
                console.log('[bot-manager] Bot stopped successfully');
                return { success: true, ...result };
            } else {
                throw new ServerError(result.error || 'Failed to stop bot', 500);
            }

        } catch (error) {
            console.error('[bot-manager] Error stopping bot:', error);
            throw new ServerError(`Failed to stop bot: ${error.message}`, 500);
        }
    }

    async getBotStatus() {
        try {
            const response = await fetch(`${this.botUrl}/status`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[bot-manager] Bot service returned error:', response.status, errorText);
                throw new Error(`Bot service returned ${response.status}: ${errorText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const responseText = await response.text();
                console.error('[bot-manager] Expected JSON but got:', contentType, responseText.substring(0, 200));
                throw new Error(`Bot service returned non-JSON response: ${contentType}`);
            }

            const result = await response.json();

            if (result.success) {
                this.status = result.status;
                if (result.isRunning && this.currentSession) {
                    this.currentSession.status = 'running';
                }
                return { success: true, ...result };
            } else {
                throw new ServerError(result.error || 'Failed to get bot status', 500);
            }

        } catch (error) {
            console.error('[bot-manager] Error getting bot status:', error);
            throw new ServerError(`Failed to get bot status: ${error.message}`, 500);
        }
    }

    async getBotHealth() {
        try {
            const response = await fetch(`${this.botUrl}/health`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[bot-manager] Bot service returned error:', response.status, errorText);
                throw new Error(`Bot service returned ${response.status}: ${errorText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const responseText = await response.text();
                console.error('[bot-manager] Expected JSON but got:', contentType, responseText.substring(0, 200));
                throw new Error(`Bot service returned non-JSON response: ${contentType}`);
            }

            return await response.json();
        } catch (error) {
            console.error('[bot-manager] Error getting bot health:', error);
            throw new ServerError(`Bot server is unreachable: ${error.message}`, 503);
        }
    }

    getCurrentSession() {
        return this.currentSession;
    }

    getStatus() {
        return {
            status: this.status,
            currentSession: this.currentSession,
            botUrl: this.botUrl
        };
    }
}

const botManager = new BotManager();

// =============== Bot Management API Routes ===============

app.post("/api/bot/start", async (req, res, next) => {
    console.log('Request Body:', req.body);
    try {
        const { interview_id, auth_token, meet_link, duration = 60 } = req.body;

        if (!interview_id) {
            throw new ServerError('Interview ID is required', 400);
        }

        if (!auth_token ) {
            throw new ServerError('Invalid or missing auth token', 401);
        }

        if (!meet_link) {
            throw new ServerError('Meeting link is required', 400);
        }

        if (!meet_link.includes('meet.google.com')) {
            throw new ServerError('Invalid Google Meet link', 400);
        }

        await interviewManager.fetchInterviews(auth_token);
        const interview = await interviewManager.getInterviewById(interview_id, auth_token);
        if (!interview) {
            throw new ServerError(`Interview with ID ${interview_id} not found`, 404);
        }

        interviewManager.setCurrentInterview(interview_id, meet_link, duration, auth_token);

        const result = await botManager.startBot(meet_link, duration, auth_token, interview_id);
        res.json({
            ...result,
            interview_id: interview_id,
            interview_data: {
                id: interview.id,
                title: interview.title || `Interview ${interview.id}`,
                candidate_name: interview.candidate_name || 'Unknown Candidate',
                position: interview.position || 'Unknown Position'
            }
        });

    } catch (error) {
        next(error);
    }
});

app.post("/api/bot/stop", async (req, res, next) => {
    try {
        const result = await botManager.stopBot();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get("/api/bot/status", async (req, res, next) => {
    try {
        const result = await botManager.getBotStatus();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get("/api/bot/health", async (req, res, next) => {
    try {
        const result = await botManager.getBotHealth();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get("/api/interviews", async (req, res, next) => {
    try {
        const interviews = await interviewManager.fetchInterviews();
        res.json({
            success: true,
            interviews: interviews,
            count: interviews.length
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/interviews/current", async (req, res, next) => {
    try {
        const currentInterview = interviewManager.getCurrentInterview();

        if (!currentInterview) {
            return res.json({
                success: true,
                current_interview: null,
                message: "No active interview"
            });
        }

        // Get full interview details
        const interviewDetails = await interviewManager.getInterviewById(currentInterview.id);

        res.json({
            success: true,
            current_interview: {
                ...currentInterview,
                details: interviewDetails
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/interviews/clear", async (req, res, next) => {
    try {
        interviewManager.clearCurrentInterview();
        res.json({
            success: true,
            message: "Current interview cleared"
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/interviews/:id", async (req, res, next) => {
    try {
        const interviewId = parseInt(req.params.id);

        if (isNaN(interviewId)) {
            throw new ServerError('Invalid interview ID', 400);
        }

        const interview = await interviewManager.getInterviewById(interviewId);

        if (!interview) {
            throw new ServerError(`Interview ${interviewId} not found`, 404);
        }

        res.json({
            success: true,
            interview: interview
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/analytics", async (req, res) => {
    try {
        const botStatus = await botManager.getBotStatus().catch(() => ({
            success: false,
            status: 'unreachable'
        }));

        const currentInterview = interviewManager.getCurrentInterview();

        res.json({
            success: true,
            gemini: geminiAnalyzer.getStats(),
            participants: participantManager.getAll(),
            sox: audioDeviceManager.getStatus(),
            bot: botStatus.success ? botStatus : { status: 'unreachable' },
            interview: {
                current: currentInterview,
                total_loaded: interviewManager.getAllInterviews().length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            success: true,
            gemini: geminiAnalyzer.getStats(),
            participants: participantManager.getAll(),
            sox: audioDeviceManager.getStatus(),
            bot: { status: 'error', error: error.message },
            interview: { current: null, error: error.message },
            timestamp: new Date().toISOString()
        });
    }
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

// ===============  Audio Device Management ===============
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

// =============== Question/Answer Extraction ===============
function extractQuestionAndAnswer(transcript) {
    const commonQuestionPatterns = [
        /(?:could you|can you|tell me|describe|what|how|why|when).*\?/gi,
        /(?:tell me about|describe a time|give an example|explain).*?(?=[.!?]|$)/gi
    ];

    let detectedQuestion = '';
    let candidateAnswer = transcript;

    for (const pattern of commonQuestionPatterns) {
        const matches = transcript.match(pattern);
        if (matches && matches.length > 0) {
            detectedQuestion = matches[0].trim();

            candidateAnswer = transcript.replace(detectedQuestion, '').trim();

            if (detectedQuestion) break;
        }
    }

    if (!detectedQuestion) {
        const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 0);

        const potentialQuestions = sentences.filter(s =>
            s.length < 100 &&
            (s.toLowerCase().includes('?') ||
                s.toLowerCase().includes('could you') ||
                s.toLowerCase().includes('can you') ||
                s.toLowerCase().includes('tell me') ||
                s.toLowerCase().includes('what') ||
                s.toLowerCase().includes('how') ||
                s.toLowerCase().includes('why'))
        );

        if (potentialQuestions.length > 0) {
            detectedQuestion = potentialQuestions[0].trim();
            candidateAnswer = transcript.replace(detectedQuestion, '').trim();
        }
    }

    return {
        detectedQuestion,
        candidateAnswer: candidateAnswer || transcript
    };
}

// =============== Interview Question Mapper ===============
class InterviewQuestionMapper {
    constructor() {
        this.commonQuestions = [
            "tell me about yourself",
            "what are your strengths",
            "what are your weaknesses",
            "why do you want to work here",
            "where do you see yourself in 5 years",
            "tell me about a time you solved a difficult problem",
            "describe a challenging situation",
            "how do you handle pressure",
            "what is your greatest achievement",
            "why should we hire you",
            "how do you handle conflict",
            "describe your leadership style",
            "what are your salary expectations",
            "do you have any questions for us"
        ];
    }

    findMatchingQuestion(transcript) {
        const cleanTranscript = transcript.toLowerCase();

        for (const question of this.commonQuestions) {
            if (cleanTranscript.includes(question) ||
                this.calculateSimilarity(cleanTranscript, question) > 0.7) {
                return question;
            }
        }

        const questionMatch = transcript.match(/(?:could you|can you|tell me|describe|what|how|why).*\?/i);
        if (questionMatch) {
            return questionMatch[0];
        }

        return null;
    }

    calculateSimilarity(str1, str2) {
        const words1 = str1.split(' ');
        const words2 = str2.split(' ');
        const intersection = words1.filter(word => words2.includes(word));
        return intersection.length / Math.max(words1.length, words2.length);
    }

    extractAnswer(transcript, question) {
        if (!question) return transcript;

        const questionIndex = transcript.toLowerCase().indexOf(question.toLowerCase());
        if (questionIndex !== -1) {
            return transcript.substring(questionIndex + question.length).trim();
        }
        return transcript;
    }
}

const questionMapper = new InterviewQuestionMapper();

// ===============  Speech Processing ===============
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
        this.botConnected = false;
        this.firstAudioReceived = false;
        this.audioTimeout = null;

        this.maxStreamDuration = 280000;
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
                enableWordTimeOffsets: true,
                maxAlternatives: 1,
                profanityFilter: false,
                adaptation: {
                    phrase_set: [], // You can add common phrases here
                }
            },
            interimResults: true,
            single_utterance: false,
        };

        this.recognizeStream = this.client
            .streamingRecognize(request)
            .on('error', (err) => this.handleStreamError(err))
            .on('data', (stream) => this.handleSpeechData(stream))
            .on('end', () => this.handleStreamEnd());

        const productionTimeout = process.env.NODE_ENV === 'production' ? 180000 : this.maxStreamDuration;

        this.streamTimeout = setTimeout(() => {
            console.log('[speech-stream] Restarting due to time limit (avoiding 305s API limit)');
            this.restartStream();
        }, this.maxStreamDuration);

        console.log(`[speech-stream] Stream started with ${this.maxStreamDuration / 1000}s timeout (restart counter: ${this.restartCounter})`);
        this.firstAudioReceived = false;
    }

    setBotConnected(connected) {
        this.botConnected = connected;
        console.log(`[speech-stream] Bot connected status: ${connected}`);

        if (!connected && this.isStreamAlive) {
            this.setAudioTimeout(60000);
        }
    }

    onFirstAudioReceived() {
        if (!this.firstAudioReceived) {
            this.firstAudioReceived = true;
            console.log('[speech-stream] First audio received, setting longer timeout');
            this.setAudioTimeout(this.maxStreamDuration);
        }
    }

    setAudioTimeout(timeout) {
        if (this.audioTimeout) {
            clearTimeout(this.audioTimeout);
        }

        this.audioTimeout = setTimeout(() => {
            console.log('[speech-stream] Restarting due to audio timeout');
            this.restartStream();
        }, timeout);

        console.log(`[speech-stream] Audio timeout set to ${timeout / 60000} minutes`);
    }

    createAudioStream() {
        return new Writable({
            write: (chunk, encoding, next) => {
                try {
                    if (!this.isStreamAlive || !this.recognizeStream) {
                        return next();
                    }

                    if (!this.firstAudioReceived) {
                        this.onFirstAudioReceived();
                    }

                    if (this.firstAudioReceived) {
                        this.resetStreamTimeout();
                    }

                    if (this.audioInput.length > 100) {
                        console.log('[speech-stream] Audio buffer too large, clearing to prevent timeout');
                        this.audioInput = this.audioInput.slice(-50);
                    }

                    if (this.newStream && this.lastAudioInput.length > 0) {
                        const chunkTime = this.maxStreamDuration / this.lastAudioInput.length;
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

    resetStreamTimeout() {
        if (this.streamTimeout) {
            clearTimeout(this.streamTimeout);
        }

        this.streamTimeout = setTimeout(() => {
            console.log('[speech-stream] Restarting due to time limit (avoiding 305s API limit)');
            this.restartStream();
        }, this.maxStreamDuration);
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
                if (process.env.NODE_ENV === 'production') {
                    this.cleanup();
                    this.resetStreamState();
                    setTimeout(() => this.startStream(), 500);
                } else {
                    this.restartStream();
                }
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

        if (this.audioTimeout) {
            clearTimeout(this.audioTimeout);
            this.audioTimeout = null;
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

        // Use a more aggressive restart strategy in production
        const baseDelay = process.env.NODE_ENV === 'production' ? 500 : 1000;
        const maxDelay = process.env.NODE_ENV === 'production' ? 3000 : 10000;
        const delay = Math.min(baseDelay * Math.pow(1.5, this.restartCounter % 5), maxDelay);

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
                this.resultEndTime - this.bridgingOffset + this.maxStreamDuration * this.restartCounter;

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

                    // Reduce the buffer size for production to prevent timeouts
                    const productionMinSegmentLength = process.env.NODE_ENV === 'production' ? 30 : CONFIG.BUFFER.minSegmentLength;
                    const productionMaxSegmentLength = process.env.NODE_ENV === 'production' ? 300 : CONFIG.BUFFER.maxSegmentLength;
                    const productionSilenceThreshold = process.env.NODE_ENV === 'production' ? 1500 : CONFIG.BUFFER.silenceThresholdMs;

                    const shouldProcess =
                        this.speakerBuffer[mappedSpeaker].length >= productionMaxSegmentLength ||
                        (this.speakerBuffer[mappedSpeaker].length >= productionMinSegmentLength &&
                            Date.now() - this.lastSpeechTime[mappedSpeaker] > productionSilenceThreshold);

                    if (shouldProcess) {
                        const textToAnalyze = this.speakerBuffer[mappedSpeaker].trim();

                        if (textToAnalyze.length > productionMinSegmentLength) {
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
        this.model = this.genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.3,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048,
            }
        });

        this.requestCount = 0;
        this.errorCount = 0;
        this.currentModel = "gemini-2.5-flash";
    }

    async analyze(speaker, text, interviewDetails) {
        if (!text || text.trim().length < 20 || this.isNoise(text)) {
            console.log('[gemini] Skipping analysis - text too short or noise:', text.substring(0, 50));
            return this.getFallbackResponse();
        }

        this.requestCount++;

        const candidateName = interviewDetails?.candidate_name || 'the candidate';
        const jobPosition = interviewDetails?.position || 'a specific job position';

        const prompt = `
            You are an AI assistant analyzing an interview conversation between an interviewer and ${candidateName} for a ${jobPosition} position.
            Analyze the following transcript and identify:
            1. The interview question being asked (if any)
            2. The candidate's answer
            3. Key insights about the answer, specifically relating to ${candidateName}'s suitability for the ${jobPosition} role.

            Speaker: ${speaker}
            Transcript: "${text}"

            Please provide a JSON response with the following structure:
            {
                "detected_question": "The actual interview question that was asked, if identifiable",
                "candidate_answer_summary": "Brief summary of the candidate's response",
                "semantics": "Key semantic meaning, skills, experience, or attitudes mentioned, especially regarding ${candidateName}'s fit for ${jobPosition}",
                "questions": ["Question 1 for follow-up", "Question 2 for follow-up"],
                "confidence": 0.95,
                "keywords": ["keyword1", "keyword2", "keyword3"],
                "answer_quality": "Assessment of answer quality (excellent/good/fair/poor)"
            }

            Important: Return ONLY valid JSON, no additional text or markdown.
        `;

        try {
            console.log(`[gemini] Analyzing transcript (${text.length} chars): ${text}`);

            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const analysisText = response.text();

            console.log('[gemini] Raw response received, length:', analysisText.length);
            console.log('[gemini] Raw response preview:', analysisText);

            const parsedResult = this.parseResponse(analysisText);
            console.log('[gemini] Parsed result:', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (err) {
            this.errorCount++;
            console.error("[gemini] Analysis error:", err.message);

            if (err.status === 404 || err.message.includes('not found')) {
                console.log('[gemini] Model not found, trying fallback model...');
                return await this.tryFallbackModel(speaker, text);
            }

            return this.getFallbackResponse();
        }
    }

    async tryFallbackModel(speaker, text) {
        try {
            console.log('[gemini] Trying fallback model: gemini-2.0-flash-001');
            const fallbackModel = this.genAI.getGenerativeModel({
                model: "gemini-2.0-flash-001",
                generationConfig: {
                    temperature: 0.3,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 2048,
                }
            });

            const prompt = `
                You are an AI assistant analyzing interview conversations. Analyze the following transcript and identify:
                1. The interview question being asked (if any)
                2. The candidate's answer
                3. Key insights about the answer

                Speaker: ${speaker}
                Transcript: "${text}"

                Please provide a JSON response with:
                {
                    "detected_question": "The actual interview question",
                    "candidate_answer_summary": "Brief summary",
                    "semantics": "Key meaning",
                    "questions": ["Question 1", "Question 2"],
                    "confidence": 0.9,
                    "keywords": ["kw1", "kw2"],
                    "answer_quality": "good"
                }

                Return ONLY valid JSON.
            `;

            const result = await fallbackModel.generateContent(prompt);
            const response = result.response;
            const analysisText = response.text();

            this.currentModel = "gemini-2.0-flash-001";
            return this.parseResponse(analysisText);

        } catch (fallbackError) {
            console.error('[gemini] Fallback model also failed:', fallbackError.message);
            return this.getFallbackResponse();
        }
    }

    isNoise(text) {
        const cleanText = text.trim().toLowerCase();
        const noisePatterns = [
            /^\s*(okay|yes|no|uh|um|ah|eh|oh|hm|hmm|mmm)\s*[.!?]*\s*$/,
            /^\s*(hello|hi|hey)\s*[.!?]*\s*$/,
            /^\s*(thank you|thanks)\s*[.!?]*\s*$/,
            /^\s*[.,!?;:\s]*$/,
            /^\s*(yeah|yep|nope|maybe|probably|possibly)\s*[.!?]*\s*$/,
            /^\s*(ok|k|alright|right|sure)\s*[.!?]*\s*$/,
            /^\s*[0-9\s]*$/
        ];

        return noisePatterns.some(pattern => pattern.test(cleanText)) || cleanText.split(' ').length < 3;
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

        const jsonMatch = cleanedRaw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            cleanedRaw = jsonMatch[0];
        }

        try {
            const parsed = JSON.parse(cleanedRaw);

            return {
                detected_question: parsed.detected_question || "",
                candidate_answer_summary: parsed.candidate_answer_summary || "No summary available",
                semantics: parsed.semantics || "No semantic analysis available",
                questions: Array.isArray(parsed.questions) ? parsed.questions : ["Could you tell me more about that?"],
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
                keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
                answer_quality: parsed.answer_quality || "unknown"
            };

        } catch (parseError) {
            console.error('[gemini] Failed to parse response as JSON:', parseError.message);
            console.error('[gemini] Raw response that failed:', raw.substring(0, 200));

            return this.extractFallbackData(cleanedRaw);
        }
    }

    extractFallbackData(cleanedRaw) {
        const lines = cleanedRaw.split('\n').filter(line => line.trim().length > 0);

        let detected_question = "";
        let candidate_answer_summary = "Analysis completed but format issue";
        let semantics = "";
        let questions = ["Could you elaborate on that?"];
        let answer_quality = "unknown";

        if (lines.length > 0) {
            const firstLine = lines[0].replace(/["{}]/g, '').trim();
            if (firstLine.length > 10 && !firstLine.includes('{') && !firstLine.includes('}')) {
                summary = firstLine.substring(0, 150);
            }
        }

        const questionLines = lines.filter(line =>
            line.includes('?') ||
            line.toLowerCase().includes('what') ||
            line.toLowerCase().includes('how') ||
            line.toLowerCase().includes('could you') ||
            line.toLowerCase().includes('can you')
        );

        if (questionLines.length > 0) {
            questions = questionLines.slice(0, 2).map(q => q.replace(/["{}]/g, '').trim());
        }

        return {
            detected_question,
            candidate_answer_summary,
            semantics,
            questions,
            confidence: 0.5,
            keywords: [],
            answer_quality
        };
    }

    getFallbackResponse() {
        return {
            detected_question: "",
            candidate_answer_summary: "Analysis unavailable - processing error",
            semantics: "",
            questions: [],
            confidence: 0.0,
            keywords: [],
            answer_quality: "unknown"
        };
    }

    getStats() {
        return {
            requestCount: this.requestCount,
            errorCount: this.errorCount,
            successRate: this.requestCount > 0 ? (this.requestCount - this.errorCount) / this.requestCount : 0,
            currentModel: this.currentModel
        };
    }
}

const geminiAnalyzer = new GeminiAnalyzer();

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

// const DJANGO_URL = "https://recos-7bb46015fb57.herokuapp.com/api/interview_conversations/";
const DJANGO_URL = "http://127.0.0.1:8000/api/interview_conversations/";

speechProcessor.on('analysis', async (data) => {
    const { speaker, text, speakerTag, timestamp } = data;
    try {
        const analysis = await geminiAnalyzer.analyze(speaker, text);

        const currentInterview = interviewManager.getCurrentInterview();

        if (!currentInterview) {
            console.warn('[integration] No current interview set, skipping Django submission');
            return;
        }

        const { detectedQuestion, candidateAnswer } = extractQuestionAndAnswer(text);

        const mappedQuestion = questionMapper.findMatchingQuestion(text);
        const finalQuestion = mappedQuestion || analysis.detected_question || detectedQuestion || analysis.candidate_answer_summary;
        const finalAnswer = questionMapper.extractAnswer(text, finalQuestion) || candidateAnswer || text;

        // Create properly formatted data for frontend
        const frontendData = {
            transcript: text,
            speaker_name: speaker,
            speaker_tag: speakerTag,
            analysis: analysis,
            message_type: "enriched_transcript",
            end_of_turn: true,
            timestamp: timestamp || Date.now(),
            is_final: true
        };

        // Send to Django backend
        const djangoPayload = {
            interview: currentInterview.id,
            question_text: finalQuestion,
            expected_answer: analysis.semantics,
            candidate_answer: finalAnswer,
            analysis_confidence: analysis.confidence,
            keywords: analysis.keywords,
            follow_up_questions: analysis.questions,
            answer_quality: analysis.answer_quality,
            transcript_segment: text,
            transcript_time: new Date(timestamp).toISOString()
        };

        console.log('[integration] Sending to Django:', djangoPayload);

        // Send to Django
        fetch(DJANGO_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Token ${currentInterview.token}`
            },
            body: JSON.stringify(djangoPayload)
        })
            .then(res => res.json())
            .then(response => console.log("[integration] Django response:", response))
            .catch(err => console.error("[integration] Django POST error:", err));

        // Send formatted data to WebSocket clients
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(frontendData));
            }
        });

    } catch (error) {
        console.error('[server] Error in Gemini analysis:', error);
    }
});

wss.on("connection", (client, req) => {
    console.log('[server] WebSocket connection attempted');
    const origin = req.headers.origin;

    if (origin && !CONFIG.CORS.allowedOrigins.includes(origin) && origin !== 'null') {
        console.log('[server] WebSocket connection rejected from origin:', origin);
        client.close(1008, 'Origin not allowed');
        return;
    }

    console.log("[server] Bot audio WS connected from", origin);

    speechProcessor.setBotConnected(true);

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
        if (audioDeviceManager.getStatus().running) {
            await audioDeviceManager.stop();
        }

        wss.clients.forEach((client) => {
            client.close(1001, 'Server shutting down');
        });

        server.close(() => {
            console.log('[server] HTTP server closed');
            process.exit(0);
        });

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