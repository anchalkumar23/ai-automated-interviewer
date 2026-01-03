import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Monitor, MonitorOff, Play, Square, Download } from 'lucide-react';

interface Question {
  id: string;
  text: string;
  timestamp: number;
}

interface EvaluationScore {
  technical_depth: number;
  clarity: number;
  originality: number;
  understanding: number;
  overall: number;
}

interface SessionState {
  isRecording: boolean;
  isScreenSharing: boolean;
  currentQuestion: Question | null;
  questions: Question[];
  evaluation: EvaluationScore | null;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  sessionId: string | null;
}

function App() {
  const [sessionState, setSessionState] = useState<SessionState>({
    isRecording: false,
    isScreenSharing: false,
    currentQuestion: null,
    questions: [],
    evaluation: null,
    connectionStatus: 'disconnected',
    sessionId: null
  });

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setSessionState(prev => ({ ...prev, connectionStatus: 'connecting' }));
    wsRef.current = new WebSocket('ws://localhost:8000/ws');

    wsRef.current.onopen = () => {
      setSessionState(prev => ({ ...prev, connectionStatus: 'connected' }));
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    wsRef.current.onclose = () => {
      setSessionState(prev => ({ ...prev, connectionStatus: 'disconnected' }));
      
      if (sessionState.isRecording || sessionState.isScreenSharing) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, 3000);
      }
    };

    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'session_id') {
        setSessionState(prev => ({ ...prev, sessionId: data.session_id }));
      } else if (data.type === 'question') {
        const newQuestion: Question = {
          id: Date.now().toString(),
          text: data.question,
          timestamp: Date.now()
        };
        setSessionState(prev => ({
          ...prev,
          currentQuestion: newQuestion,
          questions: [...prev.questions, newQuestion]
        }));
        
        if (data.speak && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(data.question);
          utterance.rate = 0.9;
          utterance.pitch = 1;
          utterance.volume = 1;
          window.speechSynthesis.speak(utterance);
        }
      } else if (data.type === 'evaluation') {
        setSessionState(prev => ({
          ...prev,
          evaluation: data.scores
        }));
      }
    };
  }, [sessionState.isRecording, sessionState.isScreenSharing]);

  const startScreenCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      
      screenStreamRef.current = stream;
      setSessionState(prev => ({ ...prev, isScreenSharing: true }));
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const video = document.createElement('video');
      
      video.srcObject = stream;
      video.play();
      
      canvasRef.current = canvas;
      
      frameIntervalRef.current = setInterval(() => {
        if (ctx && wsRef.current?.readyState === WebSocket.OPEN) {
          canvas.width = 640;
          canvas.height = 480;
          ctx.drawImage(video, 0, 0, 640, 480);
          
          canvas.toBlob((blob) => {
            if (blob && wsRef.current?.readyState === WebSocket.OPEN) {
              const reader = new FileReader();
              reader.onload = () => {
                wsRef.current?.send(JSON.stringify({
                  type: 'frame',
                  data: reader.result
                }));
              };
              reader.readAsDataURL(blob);
            }
          }, 'image/jpeg', 0.3);
        }
      }, 2000);
      
    } catch (error) {
      console.error('Error starting screen capture:', error);
    }
  };

  const stopScreenCapture = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    setSessionState(prev => ({ ...prev, isScreenSharing: false }));
  };

  const startAudioRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      let audioChunks: Float32Array[] = [];
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioChunks.push(new Float32Array(inputData));
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      const audioInterval = setInterval(() => {
        if (audioChunks.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
          const audioData = new Float32Array(totalLength);
          let offset = 0;
          for (const chunk of audioChunks) {
            audioData.set(chunk, offset);
            offset += chunk.length;
          }
          
          const wavBlob = encodeWAV(audioData, 16000);
          const reader = new FileReader();
          reader.onload = () => {
            wsRef.current?.send(JSON.stringify({
              type: 'audio',
              data: reader.result
            }));
          };
          reader.readAsDataURL(wavBlob);
          
          audioChunks = [];
        }
      }, 3000);
      
      setSessionState(prev => ({ ...prev, isRecording: true }));
      
    } catch (error) {
      console.error('Error starting audio recording:', error);
    }
  };

  const encodeWAV = (samples: Float32Array, sampleRate: number): Blob => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
  };

  const stopAudioRecording = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }
    setSessionState(prev => ({ ...prev, isRecording: false }));
  };

  const startSession = async () => {
    connectWebSocket();
    await startScreenCapture();
    await startAudioRecording();
  };

  const stopSession = () => {
    stopScreenCapture();
    stopAudioRecording();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  const downloadReport = async () => {
    if (!sessionState.sessionId) return;
    
    try {
      const response = await fetch(`http://localhost:8000/report/${sessionState.sessionId}`);
      const data = await response.json();
      
      if (data.error) {
        alert('Error generating report: ' + data.error);
        return;
      }
      
      const blob = new Blob([data.report], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'interview_report.md';
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading report:', error);
      alert('Failed to download report');
    }
  };

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  const isSessionActive = sessionState.isRecording && sessionState.isScreenSharing;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            AI Automated Interviewer
          </h1>
          <p className="text-lg text-gray-600">
            Present your project and get real-time feedback
          </p>
        </header>

        <div className="max-w-4xl mx-auto">
          <div className="mb-6 text-center">
            <div className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-medium ${
              sessionState.connectionStatus === 'connected' 
                ? 'bg-green-100 text-green-800' 
                : sessionState.connectionStatus === 'connecting'
                ? 'bg-yellow-100 text-yellow-800'
                : 'bg-red-100 text-red-800'
            }`}>
              <div className={`w-2 h-2 rounded-full mr-2 ${
                sessionState.connectionStatus === 'connected' 
                  ? 'bg-green-500' 
                  : sessionState.connectionStatus === 'connecting'
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`} />
              {sessionState.connectionStatus === 'connected' ? 'Connected' : 
               sessionState.connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-lg p-6 mb-8">
            <div className="flex justify-center space-x-4">
              {!isSessionActive ? (
                <button
                  onClick={startSession}
                  disabled={sessionState.connectionStatus === 'connecting'}
                  className="flex items-center px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  <Play className="w-5 h-5 mr-2" />
                  Start Interview Session
                </button>
              ) : (
                <button
                  onClick={stopSession}
                  className="flex items-center px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium"
                >
                  <Square className="w-5 h-5 mr-2" />
                  Stop Session
                </button>
              )}
              
              {sessionState.questions.length > 0 && (
                <button
                  onClick={downloadReport}
                  className="flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  <Download className="w-5 h-5 mr-2" />
                  Download Report
                </button>
              )}
            </div>

            <div className="flex justify-center space-x-6 mt-4">
              <div className="flex items-center text-sm">
                {sessionState.isScreenSharing ? (
                  <Monitor className="w-4 h-4 text-green-600 mr-1" />
                ) : (
                  <MonitorOff className="w-4 h-4 text-gray-400 mr-1" />
                )}
                Screen Sharing
              </div>
              <div className="flex items-center text-sm">
                {sessionState.isRecording ? (
                  <Mic className="w-4 h-4 text-green-600 mr-1" />
                ) : (
                  <MicOff className="w-4 h-4 text-gray-400 mr-1" />
                )}
                Audio Recording
              </div>
            </div>
          </div>

          {sessionState.currentQuestion && (
            <div className="bg-blue-50 border-l-4 border-blue-400 p-6 mb-8 rounded-r-lg">
              <h3 className="text-lg font-semibold text-blue-900 mb-2">
                Current Question
              </h3>
              <p className="text-blue-800 text-lg">
                {sessionState.currentQuestion.text}
              </p>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-8">
            <div className="bg-white rounded-xl shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-4 text-gray-900">
                Interview Questions
              </h3>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {sessionState.questions.length === 0 ? (
                  <p className="text-gray-500 italic">
                    Questions will appear here during the interview...
                  </p>
                ) : (
                  sessionState.questions.map((question, index) => (
                    <div key={question.id} className="border-l-4 border-gray-300 pl-4">
                      <span className="text-sm text-gray-500">Q{index + 1}</span>
                      <p className="text-gray-800">{question.text}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-4 text-gray-900">
                Live Evaluation
              </h3>
              {sessionState.evaluation ? (
                <div className="space-y-4">
                  <div className="space-y-3">
                    {Object.entries(sessionState.evaluation).map(([key, value]) => (
                      <div key={key}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="capitalize font-medium">
                            {key.replace('_', ' ')}
                          </span>
                          <span className="text-gray-600">{value}/10</span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${
                              key === 'overall' ? 'bg-purple-600' : 'bg-blue-600'
                            }`}
                            style={{ width: `${(value / 10) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 italic">
                  Evaluation scores will appear here as you present...
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;