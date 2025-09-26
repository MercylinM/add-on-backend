import WebSocket from "ws";
import { spawn } from "child_process";
import { EventEmitter } from "events";

export class SoxClient extends EventEmitter {
    constructor(backendUrl = null, audioDevice = null, options = {}) {
        super();
        
        this.backendUrl = backendUrl || process.env.BACKEND_WS_URL || "ws://localhost:3000";
        this.audioDevice = audioDevice || process.env.AUDIO_DEVICE || "default";
        
        // WebSocket properties
        this.ws = null;
        this.isConnected = false;
        this.connectionAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectInterval = options.reconnectInterval || 5000;
        this.reconnectTimer = null;
        this.shouldReconnect = true;
        
        // Audio processing properties
        this.audioProcess = null;
        this.parecProcess = null;
        this.isCapturing = false;
        this.bytesTransmitted = 0;
        this.lastActivityTime = Date.now();
        
        // Configuration
        this.config = {
            audioFormat: {
                format: 's16le',
                rate: 16000,
                channels: 1,
                bits: 16,
                encoding: 'signed-integer'
            },
            bufferSize: options.bufferSize || 4096,
            reconnectBackoff: options.reconnectBackoff || 'exponential', // linear, exponential
            heartbeatInterval: options.heartbeatInterval || 30000,
            maxSilenceTime: options.maxSilenceTime || 300000, // 5 minutes
            enableMetrics: options.enableMetrics !== false
        };
        
        // Metrics
        this.metrics = {
            startTime: null,
            connectionCount: 0,
            disconnectionCount: 0,
            bytesTransmitted: 0,
            audioErrors: 0,
            wsErrors: 0,
            lastError: null
        };
        
        // Heartbeat
        this.heartbeatTimer = null;
        this.lastPong = Date.now();
        
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Handle process termination gracefully
        process.on('SIGINT', () => this.gracefulShutdown());
        process.on('SIGTERM', () => this.gracefulShutdown());
        process.on('uncaughtException', (error) => {
            console.error('[sox-client] Uncaught exception:', error);
            this.emit('error', error);
        });
    }

    async connect() {
        if (this.isConnected) {
            console.log('[sox-client] Already connected');
            return;
        }

        this.shouldReconnect = true;
        await this.attemptConnection();
    }

    async attemptConnection() {
        try {
            const wsUrl = `${this.backendUrl}/ws/audio`;
            console.log(`[sox-client] Connecting to WebSocket at: ${wsUrl} (attempt ${this.connectionAttempts + 1})`);
            
            this.ws = new WebSocket(wsUrl, {
                handshakeTimeout: 10000,
                perMessageDeflate: false
            });

            this.setupWebSocketHandlers();
            
        } catch (error) {
            console.error('[sox-client] Connection error:', error);
            this.handleConnectionError(error);
        }
    }

    setupWebSocketHandlers() {
        this.ws.on("open", () => {
            console.log("[sox-client] Connected to backend WebSocket");
            this.onConnected();
        });

        this.ws.on("message", (msg) => {
            this.handleMessage(msg);
        });

        this.ws.on("close", (code, reason) => {
            console.log(`[sox-client] WebSocket closed: ${code} - ${reason}`);
            this.onDisconnected();
        });

        this.ws.on("error", (error) => {
            console.error("[sox-client] WebSocket error:", error);
            this.metrics.wsErrors++;
            this.metrics.lastError = error;
            this.emit('wsError', error);
        });

        this.ws.on("pong", () => {
            this.lastPong = Date.now();
        });
    }

    onConnected() {
        this.isConnected = true;
        this.connectionAttempts = 0;
        this.metrics.connectionCount++;
        this.metrics.startTime = this.metrics.startTime || Date.now();
        
        this.emit('connected');
        this.startHeartbeat();
        this.startAudioCapture();
    }

    onDisconnected() {
        this.isConnected = false;
        this.metrics.disconnectionCount++;
        
        this.stopHeartbeat();
        this.stopAudioCapture();
        this.emit('disconnected');
        
        if (this.shouldReconnect && this.connectionAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
        } else if (this.connectionAttempts >= this.maxReconnectAttempts) {
            console.error('[sox-client] Max reconnection attempts reached');
            this.emit('maxReconnectAttemptsReached');
        }
    }

    handleConnectionError(error) {
        this.connectionAttempts++;
        this.metrics.wsErrors++;
        this.metrics.lastError = error;
        
        if (this.shouldReconnect && this.connectionAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
        } else {
            this.emit('connectionFailed', error);
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        let delay = this.reconnectInterval;
        
        if (this.config.reconnectBackoff === 'exponential') {
            delay = Math.min(
                this.reconnectInterval * Math.pow(2, this.connectionAttempts - 1),
                60000 // Max 1 minute
            );
        }

        console.log(`[sox-client] Scheduling reconnect in ${delay}ms (attempt ${this.connectionAttempts + 1}/${this.maxReconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.attemptConnection();
        }, delay);
    }

    handleMessage(msg) {
        try {
            const data = JSON.parse(msg.toString());
            console.log("[sox-client] Received message:", data.message_type || 'unknown');
            this.emit('message', data);
        } catch (parseError) {
            if (msg instanceof Buffer) {
                console.log("[sox-client] Received binary data, length:", msg.length);
                this.emit('binaryMessage', msg);
            } else {
                console.log("[sox-client] Received raw message:", msg.toString().substring(0, 100));
                this.emit('rawMessage', msg);
            }
        }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                
                // Check if we've received a pong recently
                const timeSinceLastPong = Date.now() - this.lastPong;
                if (timeSinceLastPong > this.config.heartbeatInterval * 2) {
                    console.warn('[sox-client] Heartbeat timeout, reconnecting...');
                    this.ws.terminate();
                }
            }
        }, this.config.heartbeatInterval);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    startAudioCapture() {
        if (this.isCapturing) {
            console.log('[sox-client] Audio capture already running');
            return;
        }

        console.log(`[sox-client] Starting audio capture for device: ${this.audioDevice}`);
        
        try {
            if (this.audioDevice.startsWith("pulseaudio:")) {
                this.startPulseAudioCapture();
            } else if (this.audioDevice.includes("monitor")) {
                this.startMonitorCapture();
            } else {
                this.startDefaultCapture();
            }
            
            this.isCapturing = true;
            this.emit('captureStarted');
            
        } catch (error) {
            console.error('[sox-client] Failed to start audio capture:', error);
            this.metrics.audioErrors++;
            this.emit('captureError', error);
        }
    }

    stopAudioCapture() {
        if (!this.isCapturing) {
            return;
        }

        console.log('[sox-client] Stopping audio capture');
        
        if (this.parecProcess) {
            this.parecProcess.kill('SIGTERM');
            this.parecProcess = null;
        }
        
        if (this.audioProcess) {
            this.audioProcess.kill('SIGTERM');
            this.audioProcess = null;
        }
        
        this.isCapturing = false;
        this.emit('captureStopped');
    }

    createAudioProcess(command, args, processName) {
        console.log(`[sox-client] ${processName} command: ${command} ${args.join(" ")}`);
        
        const process = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        process.stderr.on("data", (err) => {
            const errorMsg = err.toString();
            console.error(`[sox-client] ${processName} error:`, errorMsg);
            this.metrics.audioErrors++;
            this.emit('audioError', { process: processName, error: errorMsg });
        });

        process.on("close", (code, signal) => {
            console.log(`[sox-client] ${processName} closed with code ${code}, signal ${signal}`);
            this.emit('processExit', { process: processName, code, signal });
            
            if (code !== 0 && this.isCapturing) {
                console.error(`[sox-client] ${processName} exited unexpectedly, attempting to restart audio capture`);
                setTimeout(() => {
                    if (this.isConnected && this.isCapturing) {
                        this.restartAudioCapture();
                    }
                }, 2000);
            }
        });

        process.on("error", (error) => {
            console.error(`[sox-client] ${processName} spawn error:`, error);
            this.metrics.audioErrors++;
            this.emit('audioError', { process: processName, error });
        });

        return process;
    }

    startPulseAudioCapture() {
        const deviceName = this.audioDevice.replace("pulseaudio:", "");
        console.log("[sox-client] Starting PulseAudio capture for device:", deviceName);

        const parecArgs = [
            `--format=${this.config.audioFormat.format}`,
            `--rate=${this.config.audioFormat.rate}`,
            `--channels=${this.config.audioFormat.channels}`,
            "--monitor-stream=false",
            deviceName
        ];

        const soxArgs = [
            "-q",
            "-t", "raw",
            "-r", this.config.audioFormat.rate.toString(),
            "-c", this.config.audioFormat.channels.toString(),
            "-b", this.config.audioFormat.bits.toString(),
            "-e", this.config.audioFormat.encoding,
            "-",
            "-t", "raw", "-"
        ];

        this.parecProcess = this.createAudioProcess("parec", parecArgs, "Parec");
        this.audioProcess = this.createAudioProcess("sox", soxArgs, "Sox");

        this.parecProcess.stdout.pipe(this.audioProcess.stdin);
        this.setupAudioDataHandler();
    }

    startMonitorCapture() {
        console.log("[sox-client] Starting monitor capture for device:", this.audioDevice);

        const parecArgs = [
            `--format=${this.config.audioFormat.format}`,
            `--rate=${this.config.audioFormat.rate}`,
            `--channels=${this.config.audioFormat.channels}`,
            "--monitor-stream=true",
            this.audioDevice
        ];

        const soxArgs = [
            "-q",
            "-t", "raw",
            "-r", this.config.audioFormat.rate.toString(),
            "-c", this.config.audioFormat.channels.toString(),
            "-b", this.config.audioFormat.bits.toString(),
            "-e", this.config.audioFormat.encoding,
            "-",
            "-t", "raw", "-"
        ];

        this.parecProcess = this.createAudioProcess("parec", parecArgs, "Parec");
        this.audioProcess = this.createAudioProcess("sox", soxArgs, "Sox");

        this.parecProcess.stdout.pipe(this.audioProcess.stdin);
        this.setupAudioDataHandler();
    }

    startDefaultCapture() {
        console.log("[sox-client] Starting default capture for device:", this.audioDevice);

        const soxArgs = [
            "-q",
            this.audioDevice === "default" ? "-d" : this.audioDevice,
            "-r", this.config.audioFormat.rate.toString(),
            "-c", this.config.audioFormat.channels.toString(),
            "-b", this.config.audioFormat.bits.toString(),
            "-e", this.config.audioFormat.encoding,
            "-t", "raw", "-"
        ];

        this.audioProcess = this.createAudioProcess("sox", soxArgs, "Sox");
        this.setupAudioDataHandler();
    }

    setupAudioDataHandler() {
        if (!this.audioProcess) {
            return;
        }

        let silenceTimer = null;
        
        this.audioProcess.stdout.on("data", (chunk) => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
                this.bytesTransmitted += chunk.length;
                this.metrics.bytesTransmitted += chunk.length;
                this.lastActivityTime = Date.now();
                
                // Reset silence timer
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                }
                
                silenceTimer = setTimeout(() => {
                    console.log('[sox-client] No audio data for extended period, checking connection...');
                    this.emit('silenceDetected');
                }, this.config.maxSilenceTime);
                
                this.emit('audioData', chunk);
            }
        });
    }

    restartAudioCapture() {
        console.log('[sox-client] Restarting audio capture...');
        this.stopAudioCapture();
        
        setTimeout(() => {
            if (this.isConnected) {
                this.startAudioCapture();
            }
        }, 1000);
    }

    disconnect() {
        console.log('[sox-client] Disconnecting...');
        this.shouldReconnect = false;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        this.stopHeartbeat();
        this.stopAudioCapture();
        
        if (this.ws) {
            this.ws.close(1000, 'Normal closure');
            this.ws = null;
        }
        
        this.emit('disconnected');
    }

    async gracefulShutdown() {
        console.log('\n[sox-client] Shutting down gracefully...');
        
        this.shouldReconnect = false;
        this.stopAudioCapture();
        
        if (this.ws) {
            this.ws.close(1000, 'Shutting down');
        }
        
        // Wait a bit for cleanup
        setTimeout(() => {
            process.exit(0);
        }, 2000);
    }

    // Utility methods
    getMetrics() {
        return {
            ...this.metrics,
            isConnected: this.isConnected,
            isCapturing: this.isCapturing,
            connectionAttempts: this.connectionAttempts,
            bytesTransmittedSession: this.bytesTransmitted,
            uptime: this.metrics.startTime ? Date.now() - this.metrics.startTime : 0,
            lastActivityTime: this.lastActivityTime
        };
    }

    getStatus() {
        return {
            connected: this.isConnected,
            capturing: this.isCapturing,
            device: this.audioDevice,
            backendUrl: this.backendUrl,
            connectionAttempts: this.connectionAttempts,
            bytesTransmitted: this.bytesTransmitted,
            lastActivityTime: this.lastActivityTime
        };
    }

    // Configuration methods
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.emit('configUpdated', this.config);
    }

    setAudioDevice(device) {
        const wasCapturing = this.isCapturing;
        
        if (wasCapturing) {
            this.stopAudioCapture();
        }
        
        this.audioDevice = device;
        
        if (wasCapturing && this.isConnected) {
            setTimeout(() => {
                this.startAudioCapture();
            }, 1000);
        }
        
        this.emit('deviceChanged', device);
    }
}

// Command-line interface
if (import.meta.url === `file://${process.argv[1]}`) {
    const audioDevice = process.argv[2] || "default";
    const backendUrl = process.argv[3] || "ws://localhost:3000";
    
    console.log('[sox-client] Starting SoxClient...');
    console.log(`[sox-client] Audio device: ${audioDevice}`);
    console.log(`[sox-client] Backend URL: ${backendUrl}`);
    
    const client = new SoxClient(backendUrl, audioDevice, {
        maxReconnectAttempts: 20,
        reconnectInterval: 3000,
        reconnectBackoff: 'exponential',
        enableMetrics: true
    });
    
    // Event listeners for debugging
    client.on('connected', () => {
        console.log('[sox-client] ✅ Connected to server');
    });
    
    client.on('disconnected', () => {
        console.log('[sox-client] ❌ Disconnected from server');
    });
    
    client.on('captureStarted', () => {
        console.log('[sox-client] 🎤 Audio capture started');
    });
    
    client.on('captureStopped', () => {
        console.log('[sox-client] ⏹️  Audio capture stopped');
    });
    
    client.on('error', (error) => {
        console.error('[sox-client] ❌ Error:', error);
    });
    
    client.on('message', (data) => {
        if (data.message_type === 'enriched_transcript') {
            console.log(`[sox-client] 📝 ${data.speaker_name}: ${data.transcript}`);
            if (data.analysis && data.analysis.summary) {
                console.log(`[sox-client] 💡 Summary: ${data.analysis.summary}`);
            }
        }
    });
    
    // Periodic metrics logging
    setInterval(() => {
        const metrics = client.getMetrics();
        if (metrics.bytesTransmitted > 0) {
            console.log(`[sox-client] 📊 Metrics: ${Math.round(metrics.bytesTransmitted / 1024)}KB transmitted, ${metrics.connectionCount} connections, ${metrics.audioErrors} audio errors`);
        }
    }, 30000);
    
    // Start the client
    client.connect().catch(console.error);
}
