import WebSocket from "ws";
import { spawn } from "child_process";

export class SoxClient {
    constructor(backendUrl = null, audioDevice = null) {
        this.backendUrl = backendUrl || process.env.BACKEND_WS_URL || "ws://localhost:3000";
        this.ws = null;
        this.audioProcess = null;
        this.isConnected = false;
        this.audioDevice = audioDevice || process.env.AUDIO_DEVICE || "default";
    }

    connect() {
        const wsUrl = `${this.backendUrl}/ws/audio`;
        console.log(`[sox-client] Connecting to WebSocket at: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

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
                if (msg instanceof Buffer) {
                    console.log("[sox-client] Received binary data, length:", msg.length);
                } else {
                    console.log("[sox-client] raw msg:", msg.toString());
                }
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
        if (this.audioDevice.startsWith("pulseaudio:")) {
            this.startPulseAudioCapture();
        } else if (this.audioDevice.includes("monitor")) {
            this.startMonitorCapture();
        } else {
            this.startDefaultCapture();
        }
    }

    startPulseAudioCapture() {
        const deviceName = this.audioDevice.replace("pulseaudio:", "");
        console.log("[sox-client] Trying PulseAudio device:", deviceName);

        const parecArgs = [
            "--format=s16le",
            "--rate=16000",
            "--channels=1",
            "--monitor-stream=false",
            deviceName
        ];

        const soxArgs = [
            "-q",
            "-t", "raw",
            "-r", "16000",
            "-c", "1",
            "-b", "16",
            "-e", "signed-integer",
            "-t", "raw",
            "-"
        ];

        console.log("[sox-client] Parec command: parec", parecArgs.join(" "));
        console.log("[sox-client] Sox command: sox", soxArgs.join(" "));

        const parecProcess = spawn("parec", parecArgs);

        this.audioProcess = spawn("sox", soxArgs);

        parecProcess.stdout.pipe(this.audioProcess.stdin);

        this.audioProcess.stdout.on("data", (chunk) => {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
            }
        });

        parecProcess.stderr.on("data", (err) => {
            console.error("[sox-client] Parec error:", err.toString());
        });

        this.audioProcess.stderr.on("data", (err) => {
            console.error("[sox-client] Sox error:", err.toString());
        });

        parecProcess.on("close", (code) => {
            console.log(`[sox-client] Parec closed with code ${code}`);
            if (this.audioProcess) {
                this.audioProcess.kill();
            }
        });

        this.audioProcess.on("close", (code) => {
            console.log(`[sox-client] Sox closed with code ${code}`);
            if (parecProcess) {
                parecProcess.kill();
            }
            if (this.ws) this.ws.close();
        });
    }

    startMonitorCapture() {
        console.log("[sox-client] Trying monitor device:", this.audioDevice);

        const parecArgs = [
            "--format=s16le",
            "--rate=16000",
            "--channels=1",
            "--monitor-stream=true",
            this.audioDevice
        ];

        const soxArgs = [
            "-q",
            "-t", "raw",
            "-r", "16000",
            "-c", "1",
            "-b", "16",
            "-e", "signed-integer",
            "-t", "raw",
            "-"
        ];

        console.log("[sox-client] Parec command: parec", parecArgs.join(" "));
        console.log("[sox-client] Sox command: sox", soxArgs.join(" "));

        const parecProcess = spawn("parec", parecArgs);

        this.audioProcess = spawn("sox", soxArgs);

        parecProcess.stdout.pipe(this.audioProcess.stdin);

        this.audioProcess.stdout.on("data", (chunk) => {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
            }
        });

        parecProcess.stderr.on("data", (err) => {
            console.error("[sox-client] Parec error:", err.toString());
        });

        this.audioProcess.stderr.on("data", (err) => {
            console.error("[sox-client] Sox error:", err.toString());
        });

        parecProcess.on("close", (code) => {
            console.log(`[sox-client] Parec closed with code ${code}`);
            if (this.audioProcess) {
                this.audioProcess.kill();
            }
        });

        this.audioProcess.on("close", (code) => {
            console.log(`[sox-client] Sox closed with code ${code}`);
            if (parecProcess) {
                parecProcess.kill();
            }
            if (this.ws) this.ws.close();
        });
    }

    startDefaultCapture() {
        console.log("[sox-client] Using default device:", this.audioDevice);

        const soxArgs = [
            "-q",
            this.audioDevice === "default" ? "-d" : this.audioDevice,
            "-r", "16000",
            "-c", "1",
            "-b", "16",
            "-e", "signed-integer",
            "-t", "raw", "-"
        ];

        console.log("[sox-client] Sox command: sox", soxArgs.join(" "));

        this.audioProcess = spawn("sox", soxArgs);

        this.audioProcess.stdout.on("data", (chunk) => {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
            }
        });

        this.audioProcess.stderr.on("data", (err) => {
            console.error("[sox-client] SoX error:", err.toString());
        });

        this.audioProcess.on("close", (code) => {
            console.log(`[sox-client] SoX closed with code ${code}`);
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
    const audioDevice = process.argv[2];
    const backendUrl = process.argv[3] || "ws://localhost:3000"; 
    const client = new SoxClient(backendUrl, audioDevice);
    client.connect();
}