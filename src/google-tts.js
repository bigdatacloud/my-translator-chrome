/**
 * Google Cloud TTS (Chirp 3 HD) — ported from desktop
 * 
 * Direct REST API call, no backend needed.
 * Returns base64 MP3 audio for playback.
 * 
 * Reference: phuc-nt/my-translator/src/js/google-tts.js
 */

const GOOGLE_TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Voice map: target language → default Chirp 3 HD voice
const VOICE_MAP = {
  'vi': { code: 'vi-VN', name: 'vi-VN-Chirp3-HD-Aoede' },
  'en': { code: 'en-US', name: 'en-US-Chirp3-HD-Kore' },
  'ja': { code: 'ja-JP', name: 'ja-JP-Chirp3-HD-Aoede' },
  'ko': { code: 'ko-KR', name: 'ko-KR-Chirp3-HD-Aoede' },
  'zh': { code: 'zh-CN', name: 'cmn-CN-Chirp3-HD-Aoede' },
  'fr': { code: 'fr-FR', name: 'fr-FR-Chirp3-HD-Aoede' },
  'de': { code: 'de-DE', name: 'de-DE-Chirp3-HD-Aoede' },
  'es': { code: 'es-ES', name: 'es-ES-Chirp3-HD-Aoede' },
};

export class GoogleTTS {
  constructor() {
    this.apiKey = '';
    this.voice = 'vi-VN-Chirp3-HD-Aoede';
    this.languageCode = 'vi-VN';
    this.speakingRate = 1.0;
    this._queue = [];
    this._isSpeaking = false;

    this.onAudioReady = null;  // (base64Audio) => {}
    this.onError = null;       // (error) => {}
  }

  configure({ apiKey, voice, languageCode, speakingRate }) {
    if (apiKey) this.apiKey = apiKey;
    if (voice) this.voice = voice;
    if (languageCode) this.languageCode = languageCode;
    if (speakingRate !== undefined) this.speakingRate = speakingRate;
  }

  setTargetLanguage(lang) {
    const mapping = VOICE_MAP[lang];
    if (mapping) {
      this.languageCode = mapping.code;
      this.voice = mapping.name;
    }
  }

  speak(text) {
    if (!text?.trim()) return;
    this._queue.push(text.trim());
    if (!this._isSpeaking) {
      this._processQueue();
    }
  }

  async _processQueue() {
    if (this._queue.length === 0) {
      this._isSpeaking = false;
      return;
    }

    this._isSpeaking = true;
    const text = this._queue.shift();

    try {
      const response = await fetch(`${GOOGLE_TTS_ENDPOINT}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: this.languageCode,
            name: this.voice,
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: this.speakingRate,
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.audioContent) {
        this.onAudioReady?.(data.audioContent);
      }
    } catch (err) {
      console.error('[Google TTS] Error:', err);
      this.onError?.(`Google TTS: ${err.message}`);
    }

    this._processQueue();
  }

  stop() {
    this._queue = [];
    this._isSpeaking = false;
  }
}

export { VOICE_MAP as GOOGLE_VOICE_MAP };
