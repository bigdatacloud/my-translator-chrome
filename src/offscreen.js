/**
 * Offscreen Document — Audio Capture + Soniox Engine
 * 
 * This runs in an invisible DOM context, providing:
 * 1. getUserMedia() for tab audio capture
 * 2. AudioContext + AudioWorklet for PCM conversion (16kHz mono s16le)
 * 3. Soniox WebSocket client for STT + translation
 * 4. Tab audio passthrough (so user still hears the tab)
 * 
 * Communicates with Service Worker + Side Panel via chrome.runtime messaging.
 */

import { SonioxClient } from './soniox.js';

let audioContext = null;
let mediaStream = null;
let sonioxClient = null;
let audioPassthrough = null; // <audio> element for tab audio passthrough
let isCapturing = false;

// ─── Message Handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'start-capture':
      startCapture(message.streamId, message.tabId);
      break;

    case 'stop-capture':
      stopCapture();
      break;

    case 'update-config':
      if (sonioxClient && sonioxClient.isConnected) {
        // Reconnect with new config
        const config = message.config;
        sonioxClient.disconnect();
        sonioxClient.connect(config);
      }
      break;
  }
});

// ─── Start Capture ────────────────────────────────────────────
async function startCapture(streamId, tabId) {
  if (isCapturing) {
    console.log('[Offscreen] Already capturing, stopping first...');
    stopCapture();
  }

  try {
    console.log('[Offscreen] Starting capture, streamId:', streamId);

    // 1. Get tab audio stream
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // 2. Passthrough: let user still hear the tab audio
    audioPassthrough = new Audio();
    audioPassthrough.srcObject = mediaStream;
    audioPassthrough.play().catch(e => console.warn('[Offscreen] Passthrough play failed:', e));

    // 3. Create AudioContext at 16kHz (Soniox requirement)
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // 4. Load AudioWorklet for PCM extraction
    await audioContext.audioWorklet.addModule('pcm-processor.js');
    const pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    // 5. Connect: source → PCM processor
    source.connect(pcmNode);
    // Don't connect pcmNode to destination — we don't want to play processed audio

    // 6. Handle PCM data from AudioWorklet
    pcmNode.port.onmessage = (event) => {
      if (event.data.type === 'pcm-data' && sonioxClient?.isConnected) {
        sonioxClient.sendAudio(event.data.buffer);
      }
    };

    // 7. Load settings and connect Soniox
    const settings = await loadSettings();
    setupSoniox(settings);

    isCapturing = true;
    sendMessage({ type: 'capture-started' });
    sendMessage({ type: 'capture-state-changed', isCapturing: true });

    console.log('[Offscreen] Capture started successfully');

  } catch (err) {
    console.error('[Offscreen] Capture error:', err);
    sendMessage({ type: 'capture-error', message: err.message });
    stopCapture();
  }
}

// ─── Stop Capture ─────────────────────────────────────────────
function stopCapture() {
  console.log('[Offscreen] Stopping capture...');

  // Disconnect Soniox
  if (sonioxClient) {
    sonioxClient.disconnect();
    sonioxClient = null;
  }

  // Stop audio passthrough
  if (audioPassthrough) {
    audioPassthrough.pause();
    audioPassthrough.srcObject = null;
    audioPassthrough = null;
  }

  // Close AudioContext
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  // Stop all media tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  isCapturing = false;
  sendMessage({ type: 'capture-stopped' });
  sendMessage({ type: 'capture-state-changed', isCapturing: false });
}

// ─── Soniox Setup ─────────────────────────────────────────────
function setupSoniox(settings) {
  sonioxClient = new SonioxClient();

  // Wire callbacks → forward to side panel via messaging
  sonioxClient.onOriginal = (text, speaker) => {
    sendMessage({ type: 'soniox-original', text, speaker });
  };

  sonioxClient.onTranslation = (text) => {
    sendMessage({ type: 'soniox-translation', text });
  };

  sonioxClient.onProvisional = (text, speaker) => {
    sendMessage({ type: 'soniox-provisional', text, speaker });
  };

  sonioxClient.onStatusChange = (status) => {
    sendMessage({ type: 'soniox-status', status });
  };

  sonioxClient.onError = (error) => {
    sendMessage({ type: 'soniox-error', error });
  };

  // Build config from settings
  const config = {
    apiKey: settings.soniox_api_key || '',
    sourceLanguage: settings.source_language || 'auto',
    targetLanguage: settings.target_language || 'vi',
    customContext: settings.custom_context || null,
  };

  sonioxClient.connect(config);
}

// ─── Settings ─────────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      resolve(result.settings || getDefaultSettings());
    });
  });
}

function getDefaultSettings() {
  return {
    soniox_api_key: '',
    source_language: 'auto',
    target_language: 'vi',
    font_size: 15,
    tts_provider: 'browser',
    tts_enabled: false,
    google_tts_api_key: '',
    google_tts_voice: 'vi-VN-Chirp3-HD-Aoede',
    google_tts_speed: 1.0,
    custom_context: null,
  };
}

// ─── Messaging Helper ─────────────────────────────────────────
function sendMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No receivers — side panel might not be open
  });
}

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && sonioxClient && isCapturing) {
    const newSettings = changes.settings.newValue;
    const config = {
      apiKey: newSettings.soniox_api_key || '',
      sourceLanguage: newSettings.source_language || 'auto',
      targetLanguage: newSettings.target_language || 'vi',
      customContext: newSettings.custom_context || null,
    };
    // Reconnect with new config
    sonioxClient.disconnect();
    sonioxClient.connect(config);
  }
});
