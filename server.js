import dotenv from "dotenv"
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http"; 
import { GoogleGenerativeAI } from "@google/generative-ai";
import speech from "@google-cloud/speech"
import { Writable } from 'stream';
import cors from 'cors';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import path from 'path';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'https://recos-meet-addon.vercel.app',
            'http://localhost:3000'
        ];

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Origin not allowed by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.options('*', cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(bodyParser.json());


// =============== Gemini Setup ===============
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// =============== Participant Map ===============
let participantMap = [];
let lastUpdated = null;

app.post("/participant-map", (req, res) => {
    const map = req.body;
    if (!Array.isArray(map)) {
        return res.status(400).json({ error: "invalid payload" });
    }
    participantMap = map.map((m, i) => ({
        audioIndex: m.audioIndex ?? i,
        name: m.name || `Speaker ${i + 1}`,
    }));
    lastUpdated = new Date().toISOString();
    console.log("[server] participant map updated:", participantMap);
    res.json({ ok: true, updated: lastUpdated });
});

app.get("/participant-map", (req, res) => {
    res.json({ participantMap, lastUpdated });
});


let soxProcess = null;
let soxStatus = {
    running: false,
    pid: null,
    startTime: null,
    device: null
};

app.get("/api/sox/status", (req, res) => {
    res.json(soxStatus);
});

app.post("/api/sox/start", async (req, res) => {
    try {
        if (soxStatus.running) {
            return res.json({ success: false, message: "SoxClient is already running" });
        }

        const { device = "default" } = req.body;

        const soxPath = path.join(__dirname, './sox_client.js');

        const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
        const wsBackendUrl = backendUrl.replace(/^http/, 'ws');

        soxProcess = spawn('node', [soxPath, device, wsBackendUrl], {
            detached: true,
            stdio: 'ignore'
        });

        soxProcess.unref();

        soxStatus = {
            running: true,
            pid: soxProcess.pid,
            startTime: new Date(),
            device: device
        };

        console.log(`[server] Started SoxClient with PID ${soxProcess.pid} on device ${device}`);

        res.json({
            success: true,
            message: "SoxClient started successfully",
            pid: soxProcess.pid,
            device: device
        });

        soxProcess.on('exit', (code) => {
            console.log(`[server] SoxClient process exited with code ${code}`);
            soxStatus = {
                running: false,
                pid: null,
                startTime: null,
                device: null
            };
        });

        soxProcess.on('error', (err) => {
            console.error(`[server] SoxClient error:`, err);
            soxStatus = {
                running: false,
                pid: null,
                startTime: null,
                device: null
            };
        });

    } catch (error) {
        console.error("[server] Error starting SoxClient:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post("/api/sox/stop", (req, res) => {
    try {
        if (!soxStatus.running || !soxProcess) {
            return res.json({ success: false, message: "SoxClient is not running" });
        }

        process.kill(soxStatus.pid, 'SIGTERM');

        setTimeout(() => {
            if (soxStatus.running) {
                process.kill(soxStatus.pid, 'SIGKILL');
            }
        }, 2000);

        soxStatus = {
            running: false,
            pid: null,
            startTime: null,
            device: null
        };

        soxProcess = null;

        console.log("[server] SoxClient stopped");
        res.json({ success: true, message: "SoxClient stopped successfully" });

    } catch (error) {
        console.error("[server] Error stopping SoxClient:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get("/api/sox/devices", (req, res) => {
    try {

        exec('pactl list sources', (error, stdout, stderr) => {
            if (error) {
                console.error("[server] Error getting audio devices:", error);
                return res.status(500).json({ success: false, message: error.message });
            }

            const devices = [];
            const lines = stdout.split('\n');
            let currentDevice = null;

            for (const line of lines) {
                if (line.includes('Source #')) {
                    if (currentDevice) {
                        devices.push(currentDevice);
                    }
                    currentDevice = { name: '', description: '' };
                } else if (line.includes('Name:')) {
                    if (currentDevice) {
                        currentDevice.name = line.split('Name: ')[1].trim();
                    }
                } else if (line.includes('Description:')) {
                    if (currentDevice) {
                        currentDevice.description = line.split('Description: ')[1].trim();
                    }
                }
            }

            if (currentDevice) {
                devices.push(currentDevice);
            }

            devices.unshift(
                { name: 'default', description: 'Default input device' },
                { name: 'monitor', description: 'Monitor of output device' }
            );

            res.json({ success: true, devices });
        });


    } catch (error) {
        console.error("[server] Error getting audio devices:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// =============== WebSocket: Audio Relay ===============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/audio" });

// wss.on("connection", (client) => {
//     console.log("[server] Bot audio WS connected");

//     const assembly = new WebSocket(
//         "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speaker_diarization=true",
//         {
//             headers: {
//                 Authorization: process.env.ASSEMBLYAI_API_KEY,
//             },
//         }
//     );

//     client.on("message", (msg) => {
//         if (assembly.readyState === WebSocket.OPEN) {
//             assembly.send(msg);
//         }
//     });

//     assembly.on("message", async (msg) => {
//         try {
//             const data = JSON.parse(msg.toString());

//             if (data.type === "Turn" && data.end_of_turn) {

//                 if (data.speaker) {
//                     const mapped = mapSpeakerLabel(data.speaker);
//                     data.speaker_name = mapped;

//                     // ===== Gemini semantic analysis =====
//                     const analysis = await runGeminiAnalysis(mapped, data.transcript);

//                     const enriched = {
//                         ...data,
//                         analysis,
//                         message_type: "enriched_transcript",
//                     };

//                     client.send(JSON.stringify(enriched));
//                 } else {
//                     client.send(JSON.stringify(data));
//                 }
//             } else {
//                 client.send(JSON.stringify(data));
//             }
//         } catch (e) {
//             console.error("[server] AssemblyAI msg error:", e);
//         }
//     });


//     assembly.on("close", () => {
//         console.log("[server] AssemblyAI closed");
//         client.close();
//     });

//     assembly.on("error", (err) => {
//         console.error("[server] AssemblyAI error:", err);
//         client.send(JSON.stringify({ error: "AssemblyAI error", err }));
//     });

//     client.on("close", () => {
//         console.log("[server] Bot WS closed");
//         if (assembly.readyState === WebSocket.OPEN) {
//             assembly.close();
//         }
//     });
// });

// =============== WebSocket: Audio Relay with Continuous Streaming ===============

// =============== WebSocket: Audio Relay with Continuous Streaming ===============

// =============== WebSocket: Audio Relay with Continuous Streaming ===============

const base64Credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./keyfile.json";
const credentials = JSON.parse(Buffer.from(base64Credentials, 'base64').toString('utf8'));

const SPEAKER_BUFFER = {};
const MIN_SEGMENT_LENGTH = 50;
const MAX_SEGMENT_LENGTH = 500;
const SILENCE_THRESHOLD_MS = 3000;
let lastSpeechTime = {};

const client = new speech.SpeechClient({ credentials });

const encoding = 'LINEAR16';
const sampleRateHertz = 16000;
const languageCode = 'en-US';
const streamingLimit = 290000;

let recognizeStream = null;
let restartCounter = 0;
let audioInput = [];
let lastAudioInput = [];
let resultEndTime = 0;
let isFinalEndTime = 0;
let finalRequestEndTime = 0;
let newStream = true;
let bridgingOffset = 0;
let lastTranscriptWasFinal = false;
let isStreamAlive = false;
let streamTimeout = null; 
let pendingRestart = false; 

function startStream() {
    if (streamTimeout) {
        clearTimeout(streamTimeout);
        streamTimeout = null;
    }

    if (recognizeStream) {
        try {
            recognizeStream.end();
            recognizeStream.removeAllListeners();
        } catch (err) {
            console.error('[speech-stream] Error cleaning up previous stream:', err);
        }
        recognizeStream = null;
    }

    audioInput = [];
    lastAudioInput = [];
    resultEndTime = 0;
    isFinalEndTime = 0;
    finalRequestEndTime = 0;
    newStream = true;
    bridgingOffset = 0;
    isStreamAlive = true;
    pendingRestart = false;

    const request = {
        config: {
            encoding: encoding,
            sampleRateHertz: sampleRateHertz,
            languageCode: languageCode,
            enableAutomaticPunctuation: true,
            diarizationConfig: {
                enableSpeakerDiarization: true,
                minSpeakerCount: 1,
                maxSpeakerCount: 6,
            },
            model: 'latest_long',
            useEnhanced: true,
        },
        interimResults: true,
    };

    recognizeStream = client
        .streamingRecognize(request)
        .on('error', err => {
            console.error('[speech-stream] API error:', err);
            isStreamAlive = false;

            if (!pendingRestart) {
                pendingRestart = true;
                if (err.code === 11) { 
                    console.log('[speech-stream] Restarting due to timeout');
                    restartStream();
                } else {
                    console.error('[speech-stream] Non-timeout error:', err);
                    setTimeout(() => restartStream(), 1000);
                }
            }
        })
        .on('data', speechCallback)
        .on('end', () => {
            console.log('[speech-stream] Stream ended naturally');
            isStreamAlive = false;

            if (!pendingRestart) {
                pendingRestart = true;
                restartStream();
            }
        });

    streamTimeout = setTimeout(() => {
        console.log('[speech-stream] Restarting due to time limit');
        restartStream();
    }, streamingLimit);

    console.log(`[speech-stream] Stream started (restart counter: ${restartCounter})`);
}

function restartStream() {
    if (pendingRestart) return; 

    pendingRestart = true;
    console.log(`[speech-stream] Restarting stream (counter: ${restartCounter})`);

    if (streamTimeout) {
        clearTimeout(streamTimeout);
        streamTimeout = null;
    }

    isStreamAlive = false;

    if (recognizeStream) {
        try {
            recognizeStream.end();
            recognizeStream.removeAllListeners();
        } catch (err) {
            console.error('[speech-stream] Error during stream cleanup:', err);
        }
        recognizeStream = null;
    }

    if (resultEndTime > 0) {
        finalRequestEndTime = isFinalEndTime;
        lastAudioInput = [...audioInput];
    }

    audioInput = [];
    resultEndTime = 0;
    newStream = true;

    restartCounter++;

    const delay = Math.min(1000 * Math.pow(1.5, restartCounter % 5), 10000);

    setTimeout(() => {
        startStream();
    }, delay);
}

const speechCallback = async (stream) => {
    try {
        if (stream.results[0] && stream.results[0].resultEndTime) {
            resultEndTime =
                stream.results[0].resultEndTime.seconds * 1000 +
                Math.round(stream.results[0].resultEndTime.nanos / 1000000);
        }

        const correctedTime =
            resultEndTime - bridgingOffset + streamingLimit * restartCounter;

        if (stream.results[0] && stream.results[0].alternatives[0]) {
            const transcript = stream.results[0].alternatives[0].transcript;
            const isFinal = stream.results[0].isFinal;

            let speakerTag = 'Unknown';
            if (stream.results[0].alternatives[0].words &&
                stream.results[0].alternatives[0].words.length > 0) {
                speakerTag = stream.results[0].alternatives[0].words[0].speakerTag || 'Unknown';
            }

            const mappedSpeaker = mapSpeakerLabel(`${speakerTag}`);

            if (isFinal) {
                console.log(`[speech-stream] ${correctedTime}: ${mappedSpeaker} - ${transcript}`);

                if (!SPEAKER_BUFFER[mappedSpeaker]) {
                    SPEAKER_BUFFER[mappedSpeaker] = '';
                    lastSpeechTime[mappedSpeaker] = Date.now();
                }

                SPEAKER_BUFFER[mappedSpeaker] += ' ' + transcript;
                lastSpeechTime[mappedSpeaker] = Date.now();

                const shouldProcess =
                    SPEAKER_BUFFER[mappedSpeaker].length >= MAX_SEGMENT_LENGTH ||
                    (SPEAKER_BUFFER[mappedSpeaker].length >= MIN_SEGMENT_LENGTH &&
                        Date.now() - lastSpeechTime[mappedSpeaker] > SILENCE_THRESHOLD_MS);

                if (shouldProcess) {
                    const textToAnalyze = SPEAKER_BUFFER[mappedSpeaker].trim();

                    if (textToAnalyze.length > MIN_SEGMENT_LENGTH) {
                        const analysis = await runGeminiAnalysis(mappedSpeaker, textToAnalyze);

                        const enriched = {
                            transcript: textToAnalyze,
                            speaker_name: mappedSpeaker,
                            speaker_tag: speakerTag,
                            analysis: analysis,
                            message_type: "enriched_transcript",
                            end_of_turn: true,
                            timestamp: correctedTime,
                            is_final: true
                        };

                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(enriched));
                            }
                        });
                    }

                    SPEAKER_BUFFER[mappedSpeaker] = '';
                } else {
                    const interimData = {
                        transcript: transcript,
                        speaker_name: mappedSpeaker,
                        speaker_tag: speakerTag,
                        message_type: "interim_transcript",
                        end_of_turn: false,
                        timestamp: correctedTime,
                        is_final: false
                    };

                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(interimData));
                        }
                    });
                }
            } else {
                const interimData = {
                    transcript: transcript,
                    speaker_name: mappedSpeaker,
                    speaker_tag: speakerTag,
                    message_type: "interim_transcript",
                    end_of_turn: false,
                    timestamp: correctedTime,
                    is_final: false
                };

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(interimData));
                    }
                });
            }
        }
    } catch (error) {
        console.error('[speech-stream] Error processing speech callback:', error);
    }
};

wss.on("connection", (client, req) => {
    const origin = req.headers.origin;

    const allowedOrigins = ['*'];
    if (!allowedOrigins.includes(origin)) {
        client.close(1008, 'Origin not allowed');
        return;
    }

    console.log("[server] Bot audio WS connected from", origin);

    let audioInputStreamTransform = null;
    let isFirstConnection = wss.clients.size === 1; 

    audioInputStreamTransform = new Writable({
        write(chunk, encoding, next) {
            try {
                if (!isStreamAlive || !recognizeStream) {
                    return next();
                }

                if (newStream && lastAudioInput.length > 0) {

                    const chunkTime = streamingLimit / lastAudioInput.length;
                    if (chunkTime !== 0) {
                        if (bridgingOffset < 0) {
                            bridgingOffset = 0;
                        }
                        if (bridgingOffset > finalRequestEndTime) {
                            bridgingOffset = finalRequestEndTime;
                        }
                        const chunksFromMS = Math.floor(
                            (finalRequestEndTime - bridgingOffset) / chunkTime
                        );
                        bridgingOffset = Math.floor(
                            (lastAudioInput.length - chunksFromMS) * chunkTime
                        );

                        for (let i = chunksFromMS; i < lastAudioInput.length; i++) {
                            if (recognizeStream && isStreamAlive) {
                                recognizeStream.write(lastAudioInput[i]);
                            } else {
                                break;
                            }
                        }
                    }
                    newStream = false;
                    lastAudioInput = [];
                }

                audioInput.push(chunk);

                if (recognizeStream && isStreamAlive) {
                    recognizeStream.write(chunk);
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

    if (isFirstConnection) {
        startStream();
    }

    client.on("message", (msg) => {
        try {
            if (audioInputStreamTransform && msg instanceof Buffer) {
                audioInputStreamTransform.write(msg);
            }
        } catch (error) {
            console.error('[server] Error processing audio message:', error);
        }
    });

    client.on("close", () => {
        console.log("[server] Bot WS closed");
        if (audioInputStreamTransform) {
            audioInputStreamTransform.end();
        }

        if (wss.clients.size === 0) {
            console.log("[server] No more clients, stopping stream");
            if (streamTimeout) {
                clearTimeout(streamTimeout);
                streamTimeout = null;
            }
            isStreamAlive = false;
            if (recognizeStream) {
                try {
                    recognizeStream.end();
                    recognizeStream.removeAllListeners();
                } catch (err) {
                    console.error('[speech-stream] Error during final cleanup:', err);
                }
                recognizeStream = null;
            }
            // Reset state
            audioInput = [];
            lastAudioInput = [];
            restartCounter = 0;
            pendingRestart = false;
        }
    });

    client.on("error", (error) => {
        console.error("[server] WebSocket client error:", error);
    });
});

function mapSpeakerLabel(label) {
    if (!label) return "Unknown";
    const index = label.charCodeAt(0) - "A".charCodeAt(0);
    return participantMap[index]?.name || `${label}`;
}

async function runGeminiAnalysis(speaker, text) {
    const prompt = `
        You are assisting in a recruiter interview.
        Speaker: ${speaker}
        Transcript: "${text}"

        Tasks:
        1. Summarize the intent of what the speaker said in one sentence.
        2. Extract semantic meaning (skills, experience, attitude).
        3. Suggest 1-2 recruiter follow-up questions based on this.
        Return ONLY valid JSON with fields: { "summary": "...", "semantics": "...", "questions": ["...", "..."] }.
        Do not include any markdown formatting or code blocks.
    `;

    try {
        const resp = await model.generateContent(prompt);
        const raw = resp.response.text();

        let cleanedRaw = raw.trim();

        if (cleanedRaw.startsWith('```json')) {
            cleanedRaw = cleanedRaw.replace(/```json\n?/, '');
            cleanedRaw = cleanedRaw.replace(/\n?```$/, '');
        } else if (cleanedRaw.startsWith('```')) {
            cleanedRaw = cleanedRaw.replace(/```\n?/, '');
            cleanedRaw = cleanedRaw.replace(/\n?```$/, '');
        }

        let parsed;
        try {
            parsed = JSON.parse(cleanedRaw);

            if (!parsed.summary || !parsed.semantics || !parsed.questions) {
                throw new Error('Invalid JSON structure');
            }

            return parsed;
        } catch (parseError) {
            console.error('[server] Failed to parse Gemini response as JSON:', parseError);
            console.error('[server] Raw response:', raw);
            console.error('[server] Cleaned response:', cleanedRaw);

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

            return { summary, semantics, questions };
        }
    } catch (err) {
        console.error("[server] Gemini error:", err);
        return { summary: "", semantics: "", questions: [] };
    }
}

// =============== HTTP + WS Upgrade ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
    console.log('\n[server] Shutting down...');
    if (soxStatus.running && soxProcess) {
        try {
            process.kill(soxStatus.pid, 'SIGTERM');
            console.log("[server] SoxClient stopped");
        } catch (error) {
            console.error("[server] Error stopping SoxClient during shutdown:", error);
        }
    }
    process.exit(0);
});