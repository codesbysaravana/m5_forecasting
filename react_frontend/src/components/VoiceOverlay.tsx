import { useState, useRef, useEffect, useCallback } from 'react';
import { WS_BASE_URL } from '../config';

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function VoiceOverlay() {
    const [isRecording, setIsRecording] = useState(false);
    const [transcript, setTranscript] = useState<string[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    
    const socketRef = useRef<WebSocket | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const recognitionRef = useRef<any>(null);
    
    // Audio Queue for sequential sentence playback
    const audioQueue = useRef<AudioBuffer[]>([]);
    const isPlaying = useRef(false);

    const playNextAudio = () => {
        if (audioQueue.current.length === 0) {
            isPlaying.current = false;
            return;
        }
        isPlaying.current = true;
        const buffer = audioQueue.current.shift()!;
        
        if (audioContextRef.current) {
            const source = audioContextRef.current.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContextRef.current.destination);
            source.onended = () => {
                playNextAudio();
            };
            source.start(0);
        }
    };

    const stopRecording = useCallback(() => {
        setIsRecording(false);
        setIsOpen(false);
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.stop();
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (socketRef.current) {
            socketRef.current.close();
        }
        
        // Restart wake word listener after a slight delay
        setTimeout(() => {
            try {
                if (recognitionRef.current) {
                    recognitionRef.current.start();
                }
            } catch (e) {
                // Ignore if already started
            }
        }, 1000);
    }, []);

    // Set up Wake Word Listener
    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';
            
            recognition.onresult = (event: any) => {
                // If we are already connected to backend, ignore local transcript
                setIsRecording(prev => {
                    if (prev) return prev;
                    
                    let interimTranscript = '';
                    for (let i = event.resultIndex; i < event.results.length; ++i) {
                        interimTranscript += event.results[i][0].transcript;
                    }
                    
                    const text = interimTranscript.toLowerCase();
                    if (text.includes('hey jade') || text.includes('hey, jade')) {
                        console.log("🌟 WAKE WORD DETECTED!");
                        recognition.stop(); // Stop local listening
                        setIsOpen(true);
                        // Using a timeout allows state to settle before grabbing mic
                        setTimeout(() => startRecording(), 100);
                    }
                    return prev;
                });
            };
            
            recognition.onend = () => {
                // Auto-restart unless we are actively recording to the backend
                setIsRecording(prev => {
                    if (!prev && recognitionRef.current) {
                        try {
                            recognitionRef.current.start();
                        } catch(e) {}
                    }
                    return prev;
                });
            };
            
            recognitionRef.current = recognition;
            
            try {
                recognition.start();
            } catch(e) {}
        }
        
        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, []); 

    const startRecording = async () => {
        try {
            // Stop local recognition if it's running
            if (recognitionRef.current) {
                try { recognitionRef.current.stop(); } catch (e) {}
            }

            // 1. Get Microphone
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Initialize AudioContext immediately on user click to avoid auto-play restrictions
            if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            if (audioContextRef.current.state === 'suspended') {
                await audioContextRef.current.resume();
            }

            // 2. Open WebSocket to FastAPI
            socketRef.current = new WebSocket(`${WS_BASE_URL}/ws/voice`);
            socketRef.current.binaryType = "arraybuffer";
            
            socketRef.current.onopen = () => {
                console.log("WebSocket connected!");
                setIsRecording(true);
                setTranscript([]); // Clear old transcript on fresh start
            };

            socketRef.current.onmessage = async (event) => {
                if (typeof event.data === "string") {
                    const msg = JSON.parse(event.data);
                    
                    // Graceful close command from backend
                    if (msg.type === "close") {
                        console.log("Backend requested graceful disconnect.");
                        stopRecording();
                        return;
                    }
                    
                    if (msg.type === "text") {
                        setTranscript((prev) => [...prev, msg.content]);
                    }
                    
                    if (msg.type === "user_text") {
                        setTranscript((prev) => [...prev, `\n\n👤 You: ${msg.content}\n\n🤖 Jade: `]);
                    }
                } else {
                    // It's binary audio data (TTS from Deepgram Aura!)
                    if (audioContextRef.current) {
                        try {
                            const buffer = await audioContextRef.current.decodeAudioData(event.data);
                            audioQueue.current.push(buffer);
                            if (!isPlaying.current) {
                                playNextAudio();
                            }
                        } catch (err) {
                            console.error("Error decoding audio data:", err);
                        }
                    }
                }
            };

            // 3. Record audio and send via WebSocket
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            
            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0 && socketRef.current?.readyState === WebSocket.OPEN) {
                    socketRef.current.send(event.data);
                }
            };
            
            // Send audio chunks every 250ms for low latency
            mediaRecorderRef.current.start(250);
            
        } catch (err) {
            console.error("Error accessing mic or socket:", err);
            alert("Could not start recording. Check console for errors.");
            stopRecording();
        }
    };

    const handleToggle = () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
            setIsOpen(true);
        }
    };

    return (
        <div className="fixed bottom-6 right-6 md:bottom-10 md:right-10 z-[9999] flex flex-col items-end gap-5">
            
            {/* Transcript Pop-up Panel */}
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
                                    className="inline-block whitespace-pre-wrap"
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
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 border-none cursor-pointer transform hover:-translate-y-1 hover:scale-105 shadow-2xl ${
                    isRecording 
                        ? 'bg-[#cc3333] shadow-[0_0_30px_rgba(204,51,51,0.5)]' 
                        : 'bg-primary-container shadow-[0_10px_25px_rgba(212,175,55,0.4)]'
                }`}
            >
                {/* Icon inside the button (Microphone) */}
                {isRecording ? (
                    <div className="w-5 h-5 bg-white rounded-sm" style={{ animation: 'pulseSquare 1.5s infinite' }} />
                ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 14C13.6569 14 15 12.6569 15 11V5C15 3.34315 13.6569 2 12 2C10.3431 2 9 3.34315 9 5V11C9 12.6569 10.3431 14 12 14Z" fill="#050505"/>
                        <path d="M19 10V11C19 14.866 15.866 18 12 18C8.13401 18 5 14.866 5 11V10" stroke="#050505" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M12 18V22" stroke="#050505" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
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
                /* Custom Scrollbar for transcript */
                .scrollbar-thin::-webkit-scrollbar {
                    width: 4px;
                }
                .scrollbar-thin::-webkit-scrollbar-track {
                    background: transparent;
                }
                .scrollbar-thin::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                }
                `}
            </style>
        </div>
    );
}
