
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AppStatus, ScriptContent } from './types';
import { encode, decode, decodeAudioData } from './utils/audioUtils';

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [script, setScript] = useState<ScriptContent | null>(null);
  const [isMicOn, setIsMicOn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [inputMode, setInputMode] = useState<'upload' | 'paste'>('upload');
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isMicOnRef = useRef(false);

  useEffect(() => {
    isMicOnRef.current = isMicOn;
  }, [isMicOn]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      const type = file.type.startsWith('image/') ? 'image' : 'text';
      
      setScript({ 
        type: type as any, 
        data: base64, 
        name: file.name,
        // If it's a text file, we try to get a preview for the instruction
        textContent: type === 'text' ? atob(base64).substring(0, 10000) : undefined
      });
      setStatus(AppStatus.FILE_UPLOADED);
    };

    if (file.type.startsWith('image/')) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  const handlePasteSubmit = () => {
    if (!pastedText.trim()) return;
    setScript({
      type: 'raw_text',
      textContent: pastedText,
      name: 'Pasted Rules'
    });
    setStatus(AppStatus.FILE_UPLOADED);
  };

  const connectToGemini = useCallback(async () => {
    if (!script) return;
    
    setStatus(AppStatus.CONNECTING);
    setErrorMsg(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const contextSnippet = script.textContent ? `\nGAME RULES/SCRIPT CONTEXT:\n${script.textContent}` : '';

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `You are an expert AI Game Host (Jubensha Master). 
          
          PHASE 1: ANALYSIS
          Analyze the provided game rules or script. Identify the GENRE (e.g., Horror, Fantasy, Comedy, Mystery).
          
          PHASE 2: PERSONA ADAPTATION
          - If the genre is dark/serious (like D&D or Cthulhu), use a mysterious, deep, and authoritative tone.
          - If the genre is light/casual (like Monopoly or Party Games), be energetic, cheerful, and welcoming.
          - If the genre is a formal murder mystery, be sharp, observant, and slightly dramatic.
          
          PHASE 3: INTERACTION RULES
          - Language: Even if the rules are in another language (Chinese, Japanese, etc.), you MUST interact with players in ENGLISH by default. 
          - Logic: Use the provided context to answer questions, settle rule disputes, and describe outcomes.
          - Style: Maintain your adapted persona at all times.
          
          [GAME INFO: ${script.name}] ${contextSnippet}`,
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini session opened");
            setStatus(AppStatus.READY);
            
            // If it's an image, send it once as context
            if (script.type === 'image' && script.data) {
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: { data: script.data!, mimeType: 'image/jpeg' }
                });
              });
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            
            if (base64Audio) {
              setStatus(AppStatus.SPEAKING);
              const ctx = outputAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setStatus(isMicOnRef.current ? AppStatus.LISTENING : AppStatus.READY);
                }
              };
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error("Gemini Error:", e);
            setErrorMsg("Connection error occurred. Check your API key or network.");
            setStatus(AppStatus.ERROR);
          },
          onclose: () => {
            console.log("Gemini session closed");
            setStatus(AppStatus.IDLE);
            sessionRef.current = null;
          }
        }
      });

      sessionRef.current = await sessionPromise;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (isMicOnRef.current) {
          const inputData = e.inputBuffer.getChannelData(0);
          const l = inputData.length;
          const int16 = new Int16Array(l);
          for (let i = 0; i < l; i++) {
            int16[i] = inputData[i] * 32768;
          }
          
          sessionPromise.then((session) => {
            session.sendRealtimeInput({
              media: {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000'
              }
            });
          });
        }
      };

      source.connect(processor);
      processor.connect(inputAudioContextRef.current.destination);
      scriptProcessorRef.current = processor;

    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to connect to AI Host. Please check microphone permissions.");
      setStatus(AppStatus.ERROR);
    }
  }, [script]);

  useEffect(() => {
    if (isMicOn && (status === AppStatus.READY || status === AppStatus.FILE_UPLOADED)) {
      if (!sessionRef.current) {
        connectToGemini();
      } else {
        setStatus(AppStatus.LISTENING);
      }
    } else if (!isMicOn && status === AppStatus.LISTENING) {
      setStatus(AppStatus.READY);
    }
  }, [isMicOn, status, connectToGemini]);

  const toggleMic = () => {
    if (status === AppStatus.IDLE || status === AppStatus.ERROR) return;
    setIsMicOn(prev => !prev);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-slate-950 text-slate-100 selection:bg-red-900/50">
      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-5xl font-cinzel font-bold text-red-700 tracking-widest drop-shadow-[0_2px_15px_rgba(185,28,28,0.6)]">
          AI JUBENSHA HOST
        </h1>
        <p className="mt-2 text-slate-400 font-light italic tracking-tight">The silent observer, the master of shadows.</p>
      </div>

      <div className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-8">
        
        {/* Left Panel: Script & Rules Input */}
        <div className="glass-panel rounded-2xl p-6 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-cinzel font-semibold flex items-center gap-2">
              <span className="w-2 h-6 bg-red-700"></span>
              Rules & Scenarios
            </h2>
            <div className="flex bg-slate-900/50 rounded-lg p-1 text-[10px] uppercase font-bold tracking-wider">
              <button 
                onClick={() => setInputMode('upload')}
                className={`px-3 py-1 rounded-md transition-all ${inputMode === 'upload' ? 'bg-red-800 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >Upload</button>
              <button 
                onClick={() => setInputMode('paste')}
                className={`px-3 py-1 rounded-md transition-all ${inputMode === 'paste' ? 'bg-red-800 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >Paste</button>
            </div>
          </div>
          
          <div className="flex-1 border-2 border-dashed border-slate-700 rounded-xl flex flex-col items-center justify-center p-4 transition-colors hover:border-red-800/50 overflow-hidden">
            {script ? (
              <div className="text-center w-full">
                <div className="bg-red-900/20 p-4 rounded-full mb-4 inline-block">
                  <svg className="w-12 h-12 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="font-semibold text-slate-200 truncate px-4">{script.name}</p>
                <div className="mt-2 text-[10px] text-slate-500 max-h-32 overflow-hidden italic line-clamp-4 px-8">
                  {script.textContent || "Content ready for the Master..."}
                </div>
                <button 
                  onClick={() => { 
                    setScript(null); 
                    setStatus(AppStatus.IDLE);
                    setIsMicOn(false);
                    if (sessionRef.current) sessionRef.current.close();
                  }}
                  className="mt-6 px-4 py-2 rounded-lg border border-red-900/30 text-xs text-red-500 hover:bg-red-900/10 transition-colors"
                >
                  Reset Game Data
                </button>
              </div>
            ) : (
              <>
                {inputMode === 'upload' ? (
                  <>
                    <input 
                      type="file" 
                      id="script-upload" 
                      className="hidden" 
                      accept="image/*,application/pdf,text/plain"
                      onChange={handleFileUpload}
                    />
                    <label htmlFor="script-upload" className="cursor-pointer text-center group w-full py-12">
                      <div className="bg-slate-800 p-4 rounded-full mb-4 group-hover:bg-red-900/30 transition-colors inline-block">
                        <svg className="w-10 h-10 text-slate-400 group-hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="12 4v16m8-8H4" />
                        </svg>
                      </div>
                      <p className="text-slate-300 group-hover:text-white font-medium">Upload Rules File</p>
                      <p className="text-xs text-slate-500 mt-1">Images or PDFs supported</p>
                    </label>
                  </>
                ) : (
                  <div className="w-full flex flex-col h-full">
                    <textarea 
                      className="flex-1 w-full bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-sm font-light text-slate-300 focus:outline-none focus:border-red-700 transition-colors resize-none mb-4 placeholder:text-slate-600"
                      placeholder="Paste game rules or scenario text here..."
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                    />
                    <button 
                      onClick={handlePasteSubmit}
                      className="w-full py-3 bg-red-900/20 border border-red-700/50 rounded-lg text-sm font-bold text-red-500 hover:bg-red-900/30 transition-all uppercase tracking-widest"
                    >
                      Initialize with Text
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Host Interaction */}
        <div className="glass-panel rounded-2xl p-6 flex flex-col items-center justify-between min-h-[480px]">
          <h2 className="text-xl font-cinzel font-semibold mb-4 self-start flex items-center gap-2 w-full">
            <span className="w-2 h-6 bg-red-700"></span>
            Host's Presence
          </h2>

          <div className="flex-1 flex flex-col items-center justify-center w-full">
            <div className={`relative w-56 h-56 rounded-full flex items-center justify-center transition-all duration-700 ${
              status === AppStatus.SPEAKING ? 'bg-red-600/10 scale-105 shadow-[0_0_80px_rgba(220,38,38,0.2)]' :
              status === AppStatus.LISTENING ? 'bg-emerald-600/5' : 'bg-slate-900/40'
            }`}>
               {/* Ambient Rings */}
               {status === AppStatus.SPEAKING && (
                 <>
                  <div className="absolute inset-0 rounded-full border border-red-500 animate-[ping_3s_linear_infinite] opacity-10"></div>
                  <div className="absolute inset-4 rounded-full border border-red-600 animate-[ping_2s_linear_infinite] opacity-20"></div>
                 </>
               )}
               {status === AppStatus.LISTENING && (
                 <div className="absolute inset-0 rounded-full border border-emerald-500 animate-pulse opacity-10"></div>
               )}
               
               <div className={`w-36 h-36 rounded-full border-[3px] flex items-center justify-center transition-all duration-500 ${
                 status === AppStatus.SPEAKING ? 'border-red-600 shadow-[inset_0_0_30px_rgba(220,38,38,0.3)]' : 
                 status === AppStatus.LISTENING ? 'border-emerald-600 shadow-[inset_0_0_20px_rgba(16,185,129,0.2)]' : 'border-slate-800'
               }`}>
                 <div className="flex flex-col items-center gap-2">
                    <svg className={`w-14 h-14 transition-all duration-500 ${
                      status === AppStatus.SPEAKING ? 'text-red-500 scale-110' : 
                      status === AppStatus.LISTENING ? 'text-emerald-500 scale-95' : 'text-slate-700'
                    }`} fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                    </svg>
                    {status === AppStatus.SPEAKING && (
                      <div className="flex gap-1">
                        <div className="w-1 h-3 bg-red-500 animate-[bounce_0.6s_infinite]"></div>
                        <div className="w-1 h-4 bg-red-500 animate-[bounce_0.8s_infinite_0.1s]"></div>
                        <div className="w-1 h-3 bg-red-500 animate-[bounce_0.6s_infinite_0.2s]"></div>
                      </div>
                    )}
                 </div>
               </div>
            </div>

            <div className="mt-10 text-center">
              <p className={`text-xs font-black tracking-[0.3em] uppercase mb-2 ${
                 status === AppStatus.ERROR ? 'text-red-500' : 
                 status === AppStatus.SPEAKING ? 'text-red-600' :
                 status === AppStatus.LISTENING ? 'text-emerald-500' : 'text-slate-500'
              }`}>
                {status.replace('_', ' ')}
              </p>
              <div className="text-[11px] text-slate-500 h-6 max-w-xs mx-auto font-light leading-relaxed">
                {status === AppStatus.LISTENING ? 'The Host is listening to your discussion...' : 
                 status === AppStatus.SPEAKING ? 'The Master is revealing the fate...' : 
                 status === AppStatus.READY ? 'Awaiting your voice. Turn on mic to summon.' : 
                 status === AppStatus.IDLE ? 'Upload game rules to begin the session.' : ''}
              </div>
            </div>
          </div>

          <div className="w-full mt-10 flex flex-col gap-4">
             {errorMsg && (
               <div className="p-3 bg-red-900/30 border border-red-700/30 rounded-lg text-[10px] text-red-200 text-center italic">
                 {errorMsg}
               </div>
             )}

             <button
                disabled={status === AppStatus.IDLE || status === AppStatus.CONNECTING}
                onClick={toggleMic}
                className={`w-full py-5 rounded-xl font-cinzel font-bold text-base transition-all transform active:scale-[0.98] flex items-center justify-center gap-4 group ${
                  isMicOn 
                  ? 'bg-red-800 hover:bg-red-700 text-white shadow-[0_10px_30px_rgba(153,27,27,0.4)] border-t border-red-600/50' 
                  : 'bg-slate-900/80 border border-slate-800 hover:border-slate-700 text-slate-500 disabled:opacity-30'
                }`}
             >
                <div className={`w-2.5 h-2.5 rounded-full ${isMicOn ? 'bg-red-200 animate-pulse' : 'bg-slate-700'}`}></div>
                {isMicOn ? 'VOICE LINK ACTIVE' : 'SUMMON THE MASTER'}
             </button>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="mt-12 text-slate-700 text-[9px] flex gap-5 uppercase tracking-[0.4em] font-medium opacity-50">
        <span>Gemini 2.5 Pro Multimodal</span>
        <span>•</span>
        <span>English Primary Interaction</span>
        <span>•</span>
        <span>Dynamic Persona</span>
      </div>
    </div>
  );
};

export default App;
