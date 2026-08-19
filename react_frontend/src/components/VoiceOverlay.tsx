import { useState, useRef, useEffect, useCallback } from 'react';
import { WS_BASE_URL } from '../config';

declare global {
    interface Window {
        SpeechRecognition: any;
        webkitSpeechRecognition: any;
    }
}

const TTS_SAMPLE_RATE = 24000;

export default function VoiceOverlay() {
    const [isRecording, setIsRecording] = useState(false);
    const [transcript, setTranscript] = useState<string[]>([]);
    const [isOpen, setIsOpen] = useState(false);

    const socketRef = useRef<WebSocket | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const workletNodeRef = useRef<AudioWorkletNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const recognitionRef = useRef<any>(null);
    const isRecordingRef = useRef(false);

    // PCM audio playback queue — we manually decode raw linear16 since decodeAudioData can't
    const pcmChunks = useRef<Int16Array[]>([]);
    const isPlaying = useRef(false);
    const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

    const playNextPCM = useCallback(() => {
        if (pcmChunks.current.length === 0) {
            isPlaying.current = false;
            return;
        }
        isPlaying.current = true;

        const ctx = audioContextRef.current;
        if (!ctx) return;

        // Merge all queued chunks into one buffer for gapless playback
        const totalSamples = pcmChunks.current.reduce((sum, c) => sum + c.length, 0);
        const merged = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of pcmChunks.current) {
            for (let i = 0; i < chunk.length; i++) {
                merged[offset++] = chunk[i] / 32768; // int16 -> float32
            }
        }
        pcmChunks.current = [];

        const audioBuffer = ctx.createBuffer(1, totalSamples, TTS_SAMPLE_RATE);
        audioBuffer.getChannelData(0).set(merged);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        currentSourceRef.current = source;
        source.onended = () => {
            currentSourceRef.current = null;
            playNextPCM();
        };
        source.start(0);
    }, []);

    // Barge-in: stop current playback and clear queue when user speaks
    const interruptPlayback = useCallback(() => {
        pcmChunks.current = [];
        if (currentSourceRef.current) {
            try { currentSourceRef.current.stop(); } catch (_) {}
            currentSourceRef.current = null;
        }
        isPlaying.current = false;
    }, []);

    const stopRecording = useCallback(() => {
        setIsRecording(false);
        isRecordingRef.current = false;

        // Disconnect AudioWorklet
        if (workletNodeRef.current) {
            workletNodeRef.current.disconnect();
            workletNodeRef.current = null;
        }
        // Stop microphone tracks
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        // Close WebSocket
        if (socketRef.current) {
            socketRef.current.close();
            socketRef.current = null;
        }

        // Restart wake word listener
        setTimeout(() => {
            try {
                if (recognitionRef.current) recognitionRef.current.start();
            } catch (_) {}
        }, 500);
    }, []);

    // Wake Word Listener
    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
            if (isRecordingRef.current) return;

            let interimTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                interimTranscript += event.results[i][0].transcript;
            }

            const text = interimTranscript.toLowerCase();
            if (text.includes('hey jade') || text.includes('hey, jade')) {
                recognition.stop();
                setIsOpen(true);
                setTimeout(() => startRecording(), 100);
            }
        };

        recognition.onend = () => {
            if (!isRecordingRef.current && recognitionRef.current) {
                try { recognitionRef.current.start(); } catch (_) {}
            }
        };

        recognitionRef.current = recognition;
        try { recognition.start(); } catch (_) {}

        return () => {
            if (recognitionRef.current) recognitionRef.current.stop();
        };
    }, []);

    const startRecording = async () => {
        try {
            if (recognitionRef.current) {
                try { recognitionRef.current.stop(); } catch (_) {}
            }

            // 1. Get microphone at 16kHz mono for Deepgram
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });
            streamRef.current = stream;

            // 2. Initialize AudioContext at 16kHz for capture
            if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
                    sampleRate: TTS_SAMPLE_RATE, // Use TTS rate for playback; worklet resamples capture
                });
            }
            if (audioContextRef.current.state === 'suspended') {
                await audioContextRef.current.resume();
            }

            // 3. Load and connect the PCM AudioWorklet
            await audioContextRef.current.audioWorklet.addModule('/pcm-processor.js');
            const source = audioContextRef.current.createMediaStreamSource(stream);
            const workletNode = new AudioWorkletNode(audioContextRef.current, 'pcm-processor');
            workletNodeRef.current = workletNode;

            source.connect(workletNode);
            // Worklet doesn't produce output audio — just captures
            workletNode.connect(audioContextRef.current.destination);

            // 4. Open WebSocket to FastAPI
            const ws = new WebSocket(`${WS_BASE_URL}/ws/voice`);
            ws.binaryType = "arraybuffer";
            socketRef.current = ws;

            ws.onopen = () => {
                setIsRecording(true);
                isRecordingRef.current = true;
                setTranscript([]);
            };

            // Forward PCM chunks from worklet to WebSocket
            workletNode.port.onmessage = (event) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(event.data);
                }
            };

            ws.onmessage = (event) => {
                if (typeof event.data === "string") {
                    const msg = JSON.parse(event.data);

                    if (msg.type === "close") {
                        stopRecording();
                        setIsOpen(false);
                        return;
                    }

                    if (msg.type === "user_text") {
                        // User was heard — barge-in: interrupt any ongoing playback
                        interruptPlayback();
                    }

                    if (msg.type === "text") {
                        setTranscript(prev => [...prev, msg.content]);
                    }

                    if (msg.type === "audio_complete") {
                        // Flush remaining PCM to playback
                        if (pcmChunks.current.length > 0 && !isPlaying.current) {
                            playNextPCM();
                        }
                    }
                } else {
                    // Binary: raw linear16 PCM at 24kHz from Deepgram TTS
                    const int16 = new Int16Array(event.data);
                    pcmChunks.current.push(int16);

                    // Start playback once we have ~100ms of audio buffered
                    if (!isPlaying.current && pcmChunks.current.reduce((s, c) => s + c.length, 0) >= TTS_SAMPLE_RATE * 0.1) {
                        playNextPCM();
                    }
                }
            };

            ws.onerror = (err) => {
                console.error("WebSocket error:", err);
                stopRecording();
            };

            ws.onclose = () => {
                if (isRecordingRef.current) stopRecording();
            };

        } catch (err) {
            console.error("Error starting voice session:", err);
            stopRecording();
        }
    };

    const handleToggle = () => {
        if (isRecording) {
            stopRecording();
            setIsOpen(false);
        } else {
            setIsOpen(true);
            startRecording();
        }
    };

    return (
        <div className="fixed bottom-6 right-6 md:bottom-10 md:right-10 z-[9999] flex flex-col items-end gap-5">

            {/* Transcript Panel */}
            {isOpen && (
                <div
                    className="bg-surface-dim/80 backdrop-blur-xl border border-[rgba(212,175,55,0.15)] rounded-2xl w-[350px] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.4)] origin-bottom-right"
                    style={{ animation: 'slideUpFade 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}
                >
                    <div className="inline-flex items-center gap-xs px-md py-xxs border gold-border rounded-full bg-surface-dim/50 backdrop-blur-md mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                        {isRecording && <span className="w-1.5 h-1.5 rounded-full bg-error mr-2"></span>}
                        <span className="font-label-caps text-label-caps tracking-widest text-primary uppercase">
                            {isRecording ? "Live Transcript" : "Disconnected"}
                        </span>
                    </div>

                    <div className="max-h-[250px] overflow-y-auto pr-3 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent">
                        <p className="font-body-md text-on-surface m-0 min-h-[50px] leading-relaxed">
                            {transcript.length === 0 && isRecording && (
                                <span className="text-on-surface-variant italic">
                                    I'm listening...
                                </span>
                            )}
                            {transcript.map((text, idx) => (
                                <span
                                    key={idx}
                                    className="mr-1.5 inline-block"
                                    style={{ animation: 'fadeInText 0.5s ease forwards', opacity: 0 }}
                                >
                                    {text}
                                </span>
                            ))}
                        </p>
                    </div>
                </div>
            )}

            {/* Floating Action Button */}
            <button
                onClick={handleToggle}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 border-none cursor-pointer transform hover:-translate-y-1 hover:scale-105 shadow-2xl ${isRecording
                    ? 'bg-[#cc3333] shadow-[0_0_30px_rgba(204,51,51,0.5)]'
                    : 'bg-primary-container shadow-[0_10px_25px_rgba(212,175,55,0.4)]'
                    }`}
            >
                {isRecording ? (
                    <div className="w-5 h-5 bg-white rounded-sm" style={{ animation: 'pulseSquare 1.5s infinite' }} />
                ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 14C13.6569 14 15 12.6569 15 11V5C15 3.34315 13.6569 2 12 2C10.3431 2 9 3.34315 9 5V11C9 12.6569 10.3431 14 12 14Z" fill="#050505" />
                        <path d="M19 10V11C19 14.866 15.866 18 12 18C8.13401 18 5 14.866 5 11V10" stroke="#050505" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M12 18V22" stroke="#050505" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                )}
            </button>

            <style>
                {`
                @keyframes fadeInText {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes slideUpFade {
                    from { opacity: 0; transform: translateY(20px) scale(0.95); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes pulseSquare {
                    0% { transform: scale(0.95); }
                    50% { transform: scale(1.1); }
                    100% { transform: scale(0.95); }
                }
                .scrollbar-thin::-webkit-scrollbar { width: 4px; }
                .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
                .scrollbar-thin::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
                `}
            </style>
        </div>
    );
}
