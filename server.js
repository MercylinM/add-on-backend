import dotenv from "dotenv"
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import http from "http"; 
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SpeechClient } from "@google-cloud/speech";

const app = express();
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

const base64Credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const credentials = JSON.parse(Buffer.from(base64Credentials, 'base64').toString('utf8'));
const speechClient = new SpeechClient({ credentials });

wss.on("connection", (client) => {
    console.log("[server] Bot audio WS connected");

    const request = {
        config: {
            encoding: "LINEAR16", 
            sampleRateHertz: 16000,
            languageCode: "en-US",
            enableAutomaticPunctuation: true,
            diarizationConfig: {
                enableSpeakerDiarization: true,
                speakerTag: 1 
            }
        },
        interimResults: true,
    };

    const audioStream = speechClient.streamingRecognize(request);

    client.on("message", (msg) => {
        audioStream.write(msg);
    });

    audioStream.on("data", async (data) => {
        const result = data.results[0];
        if (result.isFinal) {
            const speakerTag = result.alternatives[0].words[0].speakerTag;
            const mapped = mapSpeakerLabel(`Speaker ${speakerTag}`);
            const transcript = result.alternatives[0].transcript;

            // ===== Gemini semantic analysis =====
            const analysis = await runGeminiAnalysis(mapped, transcript);

            const enriched = {
                transcript,
                speaker_name: mapped,
                analysis,
                message_type: "enriched_transcript",
                end_of_turn: true,
            };
            client.send(JSON.stringify(enriched));
        } else {
            const partial = {
                transcript: result.alternatives[0].transcript,
                message_type: "PartialTranscript",
            };
            client.send(JSON.stringify(partial));
        }
    });

    audioStream.on("end", () => {
        console.log("[server] Google Cloud stream ended");
    });

    audioStream.on("error", (err) => {
        console.error("[server] Google Cloud error:", err);
        client.send(JSON.stringify({ error: "Google Cloud error", err }));
    });

    client.on("close", () => {
        console.log("[server] Bot WS closed");
        audioStream.end();
    });
});

function mapSpeakerLabel(label) {
    if (!label) return "Unknown";
    const index = label.charCodeAt(0) - "A".charCodeAt(0);
    return participantMap[index]?.name || `Speaker ${label}`;
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
Return JSON with fields: { "summary": "...", "semantics": "...", "questions": ["...", "..."] }.
  `;

    try {
        const resp = await model.generateContent(prompt);
        const raw = resp.response.text();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = { summary: raw, semantics: "", questions: [] };
        }
        return parsed;
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