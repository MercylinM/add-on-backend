import dotenv from "dotenv"
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import http from "http"; 
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SpeechClient, } from "@google-cloud/speech";
import speech from "@google-cloud/speech"
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Writable } from 'stream';


puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.json());

// =============== Interview Bot Class ===============
class InterviewBot {
    constructor(aiJoinUrl) {
        this.aiJoinUrl = aiJoinUrl;
        this.googleEmail = process.env.GOOGLE_EMAIL;
        this.googlePassword = process.env.GOOGLE_PASSWORD;
        this.browser = null;
        this.page = null;
        this.isJoined = false;
    }

    async joinInterview() {
        try {
            console.log('[interview-bot] Starting to join interview with Chrome...');

            const chromePaths = [
                '/usr/bin/google-chrome-stable',
                '/usr/bin/google-chrome',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' 
            ];

            let executablePath = null;
            for (const path of chromePaths) {
                try {
                    const fs = await import('fs');
                    if (fs.existsSync(path)) {
                        executablePath = path;
                        console.log(`[interview-bot] Found Chrome at: ${path}`);
                        break;
                    }
                } catch (error) {
                    // Continue checking next path
                }
            }

            if (!executablePath) {
                console.log('[interview-bot] Chrome not found, falling back to Chromium');
            }

            this.browser = await puppeteer.launch({
                headless: false,
                executablePath: executablePath, 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=TranslateUI',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--window-size=1280,720',
                    '--user-data-dir=./chrome_user_data' 
                ],
                ignoreHTTPSErrors: true
            });

            const pages = await this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();

            await this.page.setViewport({ width: 1280, height: 720 });

            await this.page.setUserAgent(
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            await this.page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            });

            console.log('[interview-bot] Navigating to Google Meet with Chrome...');
            await this.page.goto(this.aiJoinUrl, {
                waitUntil: 'networkidle2',
                timeout: 90000
            });

            await this.delay(10000);

            const currentUrl = this.page.url();
            console.log('[interview-bot] Current URL:', currentUrl);

            if (currentUrl.includes('accounts.google.com')) {
                console.log('[interview-bot] 🔐 Google authentication required');
                await this.handleGoogleAuth();
            } else if (currentUrl.includes('meet.google.com')) {
                console.log('[interview-bot] 🎯 On Google Meet page');
                const joinResult = await this.joinMeet();
                if (joinResult) {
                    this.isJoined = true;
                    return true;
                }
            }

            console.log('[interview-bot] ⚠️ Could not auto-join, keeping browser open for manual join');
            this.isJoined = true;
            return true;

        } catch (error) {
            console.error('[interview-bot] Error:', error);
            await this.cleanup();
            throw error;
        }
    }

    async handleGoogleAuth() {
        try {
            if (this.googleEmail && this.googlePassword) {
                console.log('[interview-bot] Attempting automated Google sign-in...');
                await this.autoSignIn();
            } else {
                console.log('[interview-bot] ❗ No Google credentials provided');
                console.log('[interview-bot] Please sign in manually in the browser window');
                console.log('[interview-bot] Waiting 45 seconds for manual sign-in...');
                await this.delay(45000);

                if (this.page.url().includes('meet.google.com')) {
                    return await this.joinMeet();
                }
            }
        } catch (error) {
            console.error('[interview-bot] Auth handling error:', error);
        }
        return false;
    }

    async autoSignIn() {
        try {
            await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
            await this.page.type('input[type="email"]', this.googleEmail);
            await this.page.click('#identifierNext');

            await this.delay(3000);

            await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
            await this.page.type('input[type="password"]', this.googlePassword);
            await this.page.click('#passwordNext');

            await this.delay(8000);

            console.log('[interview-bot] Sign-in completed, checking redirect...');

        } catch (error) {
            console.error('[interview-bot] Automated sign-in failed:', error);
            throw error;
        }
    }

    async joinMeet() {
        console.log('[interview-bot] Attempting to join Google Meet...');

        await this.delay(8000);

        const strategies = [
            this.clickJoinButton.bind(this),
            this.pressEnterKey.bind(this),
            this.checkAlreadyJoined.bind(this)
        ];

        for (const strategy of strategies) {
            const result = await strategy();
            if (result) {
                console.log('[interview-bot] ✅ Join successful!');
                return true;
            }
            await this.delay(3000);
        }

        return false;
    }

    async clickJoinButton() {
        const joinSelectors = [
            'div[role="button"][aria-label*="Join" i]',
            'button[aria-label*="Join" i]',
            'button:has-text("Join now")',
            'button:has-text("Ask to join")',
            '[data-tooltip*="Join" i]',
            '.join-button',
            'button[custom-data="join"]'
        ];

        for (const selector of joinSelectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 5000 });
                await this.page.click(selector);
                console.log(`[interview-bot] Clicked: ${selector}`);

                await this.delay(6000);

                if (await this.isInMeeting()) {
                    return true;
                }
            } catch (error) {
                // Continue to next selector
            }
        }
        return false;
    }
    

    async pressEnterKey() {
        try {
            await this.page.keyboard.press('Enter');
            await this.delay(5000);
            return await this.isInMeeting();
        } catch (error) {
            return false;
        }
    }

    async checkAlreadyJoined() {
        return await this.isInMeeting();
    }

    async isInMeeting() {
        try {
            return await this.page.evaluate(() => {
                const indicators = [
                    '[aria-label="Leave call"]',
                    '[aria-label*="leave call" i]',
                    'video',
                    '.video-tile',
                    '[data-meeting-code]',
                    '[class*="meeting"]'
                ];

                for (const selector of indicators) {
                    if (document.querySelector(selector)) {
                        return true;
                    }
                }

                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes('leave call') ||
                    bodyText.includes('turn off camera') ||
                    bodyText.includes('participants') ||
                    bodyText.includes('meeting details');
            });
        } catch (error) {
            return false;
        }
    }

    async leaveInterview() {
        if (!this.isJoined) return;

        console.log('[interview-bot] Leaving interview...');
        try {
            const leaveSelectors = [
                'button[aria-label*="Leave" i]',
                'div[aria-label*="Leave" i]',
                '[data-tooltip*="Leave" i]',
                '.leave-call-button'
            ];

            for (const selector of leaveSelectors) {
                try {
                    await this.page.click(selector);
                    await this.delay(2000);
                    break;
                } catch (error) {
                    // Try next selector
                }
            }
        } catch (error) {
            console.error('[interview-bot] Error leaving interview:', error);
        }

        await this.cleanup();
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
        }
        this.isJoined = false;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// =============== Bot Manager ===============
class BotManager {
    constructor() {
        this.currentBot = null;
        this.isActive = false;
    }

    async startBot(aiJoinUrl) {
        try {
            if (this.currentBot) {
                await this.stopBot();
            }

            console.log('[bot-manager] Starting interview bot...');
            this.currentBot = new InterviewBot(aiJoinUrl);
            await this.currentBot.joinInterview();
            this.isActive = true;

            console.log('[bot-manager] Interview bot started successfully');
            return true;

        } catch (error) {
            console.error('[bot-manager] Failed to start interview bot:', error);
            this.isActive = false;
            throw error;
        }
    }

    async stopBot() {
        if (this.currentBot) {
            await this.currentBot.leaveInterview();
            this.currentBot = null;
        }
        this.isActive = false;
        console.log('[bot-manager] Interview bot stopped');
    }

    getStatus() {
        return {
            isActive: this.isActive,
            hasBot: !!this.currentBot
        };
    }
}

const botManager = new BotManager();

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

// =============== Bot Control Endpoints ===============
app.post("/bot/join", async (req, res) => {
    try {
        const { ai_join_url } = req.body;

        if (!ai_join_url) {
            return res.status(400).json({ error: "ai_join_url is required" });
        }

        await botManager.startBot(ai_join_url);
        res.json({ success: true, message: "Bot joined the interview" });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/bot/leave", async (req, res) => {
    try {
        await botManager.stopBot();
        res.json({ success: true, message: "Bot left the interview" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/bot/status", (req, res) => {
    res.json(botManager.getStatus());
});

app.post("/bot/debug", async (req, res) => {
    try {
        const { ai_join_url } = req.body;

        if (!ai_join_url) {
            return res.status(400).json({ error: "ai_join_url is required" });
        }

        console.log('[debug] Testing URL:', ai_join_url);

        const browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.goto(ai_join_url);

        await new Promise(resolve => setTimeout(resolve, 10000));
        await page.screenshot({ path: 'debug-meet.png' });

        const pageInfo = await page.evaluate(() => ({
            title: document.title,
            url: window.location.href,
            bodyText: document.body.innerText
        }));

        await browser.close();

        res.json({
            success: true,
            message: "Debug completed - check debug-meet.png",
            pageInfo: {
                title: pageInfo.title,
                url: pageInfo.url,
                textSample: pageInfo.bodyText.substring(0, 500)
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// =============== WebSocket: Audio Relay ===============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/audio" });

// Add CORS headers to the HTTP server
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

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
const streamingLimit = 290000; // Reduced to 4:50 to avoid 5-min API timeout

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

wss.on("connection", (client) => {
    console.log("[server] Bot audio WS connected");

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
    await botManager.stopBot();
    process.exit(0);
});
