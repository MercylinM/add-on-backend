import WebSocket from "ws";
import { spawn } from "child_process";

const ws = new WebSocket("ws://localhost:3000/ws/audio");

ws.on("open", () => {
    console.log("[sox-client] Connected to backend WS");

    // Spawn SoX to capture mic → raw PCM 16k mono
    const sox = spawn("sox", [
        "-d",              
        "-r", "16000",     
        "-c", "1",         
        "-b", "16",        
        "-e", "signed-integer",
        "-t", "raw", "-"   
    ]);

    sox.stdout.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
        }
    });

    sox.stderr.on("data", (err) => {
        console.error("[sox-client] SoX error:", err.toString());
    });

    sox.on("close", () => {
        console.log("[sox-client] SoX closed");
        ws.close();
    });
});

ws.on("message", (msg) => {
    try {
        const data = JSON.parse(msg.toString());
        console.log("[sox-client] backend ->", data);
    } catch {
        console.log("[sox-client] raw msg:", msg.toString());
    }
});

ws.on("close", () => {
    console.log("[sox-client] WS closed");
});
