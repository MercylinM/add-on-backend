import WebSocket from "ws";
import { spawn } from "child_process";

export class SoxClient {
    constructor(backendUrl = "ws://localhost:3000") {
        this.backendUrl = backendUrl;
        this.ws = null;
        this.audioProcess = null;
        this.isConnected = false;
    }

    connect() {
        this.ws = new WebSocket(`${this.backendUrl}/ws/audio`);

        this.ws.on("open", () => {
            console.log("[sox-client] Connected to backend WS");
            this.isConnected = true;
            this.startAudioCapture();
        });

        this.ws.on("message", (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                console.log("[sox-client] backend ->", data);
            } catch {
                console.log("[sox-client] raw msg:", msg.toString());
            }
        });

        this.ws.on("close", () => {
            console.log("[sox-client] WS closed");
            this.isConnected = false;
        });

        this.ws.on("error", (error) => {
            console.error("[sox-client] WS error:", error);
        });
    }

    startAudioCapture() {
        this.audioProcess = spawn("sox", [
            "-d",
            "-r", "16000",
            "-c", "1",
            "-b", "16",
            "-e", "signed-integer",
            "-t", "raw", "-"
        ]);

        this.audioProcess.stdout.on("data", (chunk) => {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
            }
        });

        this.audioProcess.stderr.on("data", (err) => {
            console.error("[sox-client] SoX error:", err.toString());
        });

        this.audioProcess.on("close", () => {
            console.log("[sox-client] SoX closed");
            if (this.ws) this.ws.close();
        });
    }

    disconnect() {
        if (this.audioProcess) {
            this.audioProcess.kill();
        }
        if (this.ws) {
            this.ws.close();
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const client = new SoxClient();
    client.connect();
}