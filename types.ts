
export enum AppStatus {
  IDLE = 'IDLE',
  FILE_UPLOADED = 'FILE_UPLOADED',
  CONNECTING = 'CONNECTING',
  READY = 'READY',
  LISTENING = 'LISTENING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR'
}

export interface ScriptContent {
  type: 'text' | 'image' | 'raw_text';
  data?: string; // base64 for images/files
  textContent?: string; // string for pasted text
  name: string;
}
