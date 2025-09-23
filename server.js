import dotenv from "dotenv"
dotenv.config();

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (client) => {
    console.log("[server] Bot audio WS connected");

    // Connect to AssemblyAI Realtime WS
    const assembly = new WebSocket(
        "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000",
        {
            headers: {
                Authorization: process.env.ASSEMBLYAI_API_KEY,
            },
        }
    );

    // Relay bot audio → AssemblyAI
    client.on("message", (msg) => {
        if (assembly.readyState === WebSocket.OPEN) {
            assembly.send(msg); 
        }
    });

    // Relay AssemblyAI transcript → client (with mapped names + Gemini analysis)
    assembly.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg.toString());

            if (data.message_type === "FinalTranscript" && data.speaker) {
                // Map AssemblyAI speaker label → participant name
                const mapped = mapSpeakerLabel(data.speaker);
                data.speaker_name = mapped;

                // ===== Gemini semantic analysis =====
                const analysis = await runGeminiAnalysis(mapped, data.text);

                // Bundle transcript + analysis
                const enriched = {
                    ...data,
                    analysis,
                    message_type: "enriched_transcript",
                };

                client.send(JSON.stringify(enriched));
            } else {
                client.send(JSON.stringify(data));
            }
        } catch (e) {
            console.error("[server] AssemblyAI msg error:", e);
        }
    });

    assembly.on("close", () => {
        console.log("[server] AssemblyAI closed");
        client.close();
    });

    assembly.on("error", (err) => {
        console.error("[server] AssemblyAI error:", err);
        client.send(JSON.stringify({ error: "AssemblyAI error", err }));
    });

    client.on("close", () => {
        console.log("[server] Bot WS closed");
        if (assembly.readyState === WebSocket.OPEN) {
            assembly.close();
        }
    });
});

// Helper: map AssemblyAI speaker label → participant name
function mapSpeakerLabel(label) {
    if (!label) return "Unknown";
    const index = label.charCodeAt(0) - "A".charCodeAt(0); 
    return participantMap[index]?.name || `Speaker ${label}`;
}

// Helper: run Gemini semantic analysis
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
        // Try to parse JSON safely
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
const server = app.listen(3000, () => {
    console.log("[server] listening on http://localhost:3000");
});

server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws/audio") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});



