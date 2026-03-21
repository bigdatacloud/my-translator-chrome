/**
 * Side Panel — main UI controller
 * 
 * Handles:
 * - Transcript display (segments, provisional text, smart scroll)
 * - Settings view (API key, languages, TTS, custom context)
 * - TTS playback (Web Speech API + Google Chirp 3 HD)
 * - User actions (copy, clear, font size, keyboard shortcuts)
 * 
 * Receives real-time data from offscreen document via chrome.runtime messaging.
 */

import { settingsManager } from './settings.js';
import { GoogleTTS } from './google-tts.js';

// ─── State ────────────────────────────────────────────────────
let segments = [];
let provisionalText = '';
let provisionalSpeaker = null;
let currentSpeaker = null;
let isCapturing = false;
let ttsEnabled = false;
let captureStartTime = null;
let timerInterval = null;
let fontSize = 15;
let toastTimeout = null;

const MAX_CHARS = 1200;
const STALE_MS = 10000;
const MAX_PENDING = 3;

// ─── TTS ──────────────────────────────────────────────────────
const googleTTS = new GoogleTTS();

googleTTS.onAudioReady = (base64Audio) => {
  playBase64Audio(base64Audio);
};

googleTTS.onError = (error) => {
  showToast(error, 'error');
};

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await settingsManager.load();
  const settings = settingsManager.get();
  fontSize = settings.font_size || 15;
  applyFontSize();

  // Check if already capturing
  chrome.runtime.sendMessage({ type: 'get-state' }, (response) => {
    if (response?.isCapturing) {
      isCapturing = true;
      setStatus('connected');
      showListening();
      startTimer();
    }
  });

  // First run — auto-open settings
  if (settingsManager.isFirstRun()) {
    showView('settings');
    populateSettingsForm();
  }

  bindEvents();
  bindMessageListener();
});

// ─── Event Binding ────────────────────────────────────────────
function bindEvents() {
  // Settings
  document.getElementById('btn-settings').addEventListener('click', () => {
    showView('settings');
    populateSettingsForm();
  });

  document.getElementById('btn-back').addEventListener('click', () => {
    showView('main');
  });

  // Actions
  document.getElementById('btn-tts').addEventListener('click', toggleTTS);
  document.getElementById('btn-font-up').addEventListener('click', () => adjustFontSize(2));
  document.getElementById('btn-font-down').addEventListener('click', () => adjustFontSize(-2));

  document.getElementById('btn-copy').addEventListener('click', async () => {
    const text = getPlainText();
    if (text) {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard', 'success');
    } else {
      showToast('Nothing to copy', 'info');
    }
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    segments = [];
    provisionalText = '';
    provisionalSpeaker = null;
    currentSpeaker = null;
    renderTranscript();
    showPlaceholder();
  });

  // Settings form
  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    const input = document.getElementById('input-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
    const input = document.getElementById('input-google-tts-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('select-tts-provider').addEventListener('change', (e) => {
    updateTTSProviderUI(e.target.value);
  });

  document.getElementById('range-font-size').addEventListener('input', (e) => {
    document.getElementById('font-size-value').textContent = `${e.target.value}px`;
  });

  document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
    document.getElementById('google-speed-value').textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
  });

  document.getElementById('range-browser-speed')?.addEventListener('input', (e) => {
    document.getElementById('browser-speed-value').textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
  });

  document.getElementById('btn-add-term').addEventListener('click', () => {
    addTermRow('', '');
  });

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if ((e.metaKey || e.ctrlKey) && e.key === 't') {
      e.preventDefault();
      toggleTTS();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      showView('main');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      showView('settings');
      populateSettingsForm();
    }
  });
}

// ─── Message Listener ─────────────────────────────────────────
function bindMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'soniox-original':
        addOriginal(message.text, message.speaker);
        break;

      case 'soniox-translation':
        addTranslation(message.text);
        speakIfEnabled(message.text);
        break;

      case 'soniox-provisional':
        setProvisional(message.text, message.speaker);
        break;

      case 'soniox-status':
        setStatus(message.status);
        break;

      case 'soniox-error':
        showToast(message.error, 'error');
        break;

      case 'capture-started':
        isCapturing = true;
        showListening();
        startTimer();
        break;

      case 'capture-stopped':
        isCapturing = false;
        setStatus('idle');
        stopTimer();
        if (message.reason === 'tab-closed') {
          showToast('Tab was closed', 'info');
        }
        break;

      case 'capture-error':
        showToast(message.message, 'error');
        setStatus('error');
        break;

      case 'error':
        showToast(message.message, 'error');
        break;
    }
  });
}

// ─── Transcript Management (ported patterns from desktop) ─────
function addOriginal(text, speaker) {
  removeListeningIndicator();
  segments.push({
    original: text,
    translation: null,
    status: 'original',
    speaker: speaker || null,
    createdAt: Date.now(),
  });
  if (speaker) currentSpeaker = speaker;
  cleanupStaleOriginals();
  renderTranscript();
}

function addTranslation(text) {
  const seg = segments.find(s => s.status === 'original');
  if (seg) {
    seg.translation = text;
    seg.status = 'translated';
  } else {
    segments.push({
      original: '',
      translation: text,
      status: 'translated',
      speaker: null,
    });
  }
  renderTranscript();
}

function setProvisional(text, speaker) {
  removeListeningIndicator();
  provisionalText = text || '';
  provisionalSpeaker = speaker || null;
  renderTranscript();
}

function cleanupStaleOriginals() {
  const now = Date.now();
  segments = segments.filter(seg => {
    if (seg.status === 'original' && (now - seg.createdAt) > STALE_MS) return false;
    return true;
  });
  let pending = segments.filter(s => s.status === 'original');
  while (pending.length > MAX_PENDING) {
    const oldest = pending.shift();
    const idx = segments.indexOf(oldest);
    if (idx !== -1) segments.splice(idx, 1);
  }
}

function trimSegments() {
  let totalLen = 0;
  for (const seg of segments) {
    totalLen += (seg.translation || seg.original || '').length;
  }
  while (totalLen > MAX_CHARS && segments.length > 2) {
    const removed = segments.shift();
    totalLen -= (removed.translation || removed.original || '').length;
  }
}

// ─── Rendering ────────────────────────────────────────────────
function renderTranscript() {
  trimSegments();
  const contentEl = document.getElementById('transcript-content');
  let html = '';
  let lastSpeaker = null;

  for (const seg of segments) {
    if (seg.speaker && seg.speaker !== lastSpeaker) {
      html += `<span class="speaker-label">Speaker ${esc(String(seg.speaker))}:</span> `;
      lastSpeaker = seg.speaker;
    }

    if (seg.status === 'translated' && seg.translation) {
      html += `<div class="seg-block"><div class="seg-translated">${esc(seg.translation)}</div></div>`;
    }
  }

  if (provisionalText) {
    if (provisionalSpeaker && provisionalSpeaker !== lastSpeaker) {
      html += `<span class="speaker-label">Speaker ${esc(String(provisionalSpeaker))}:</span> `;
    }
    html += `<div class="seg-block"><div class="seg-provisional">${esc(provisionalText)}</div></div>`;
  }

  if (html) {
    contentEl.innerHTML = html;
    smartScroll(document.getElementById('transcript-container'));
  }
}

function showPlaceholder() {
  document.getElementById('transcript-content').innerHTML = `
    <div class="transcript-placeholder">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
      <p>Click the extension icon to start translating</p>
      <p class="hint">Captures audio from the active tab</p>
    </div>
  `;
}

function showListening() {
  removeListeningIndicator();
  const contentEl = document.getElementById('transcript-content');
  const placeholder = contentEl.querySelector('.transcript-placeholder');
  if (placeholder) placeholder.remove();

  const indicator = document.createElement('div');
  indicator.className = 'listening-indicator';
  indicator.innerHTML = `
    <div class="listening-waves">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <p>Listening...</p>
  `;
  contentEl.appendChild(indicator);
}

function removeListeningIndicator() {
  document.querySelectorAll('.listening-indicator').forEach(el => el.remove());
}

function smartScroll(el) {
  if (!el) return;
  const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getPlainText() {
  let lines = [];
  for (const seg of segments) {
    if (seg.original) lines.push(seg.original);
    if (seg.translation) lines.push(seg.translation);
    if (seg.original || seg.translation) lines.push('');
  }
  return lines.join('\n').trim();
}

// ─── Status ───────────────────────────────────────────────────
function setStatus(status) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  dot.className = `status-dot ${status}`;

  const labels = {
    idle: 'Ready',
    connecting: 'Connecting...',
    connected: 'Connected',
    error: 'Error',
    disconnected: 'Disconnected',
  };
  text.textContent = labels[status] || status;
}

// ─── Timer ────────────────────────────────────────────────────
function startTimer() {
  captureStartTime = Date.now();
  stopTimer();
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  document.getElementById('status-timer').textContent = '';
}

function updateTimer() {
  if (!captureStartTime) return;
  const elapsed = Math.floor((Date.now() - captureStartTime) / 1000);
  const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const sec = String(elapsed % 60).padStart(2, '0');
  document.getElementById('status-timer').textContent = `${min}:${sec}`;
}

// ─── Font Size ────────────────────────────────────────────────
function adjustFontSize(delta) {
  fontSize = Math.max(12, Math.min(48, fontSize + delta));
  applyFontSize();
  // Persist
  const settings = settingsManager.get();
  settings.font_size = fontSize;
  settingsManager.save(settings);
}

function applyFontSize() {
  document.getElementById('transcript-content').style.setProperty('--transcript-font-size', `${fontSize}px`);
}

// ─── TTS ──────────────────────────────────────────────────────
function toggleTTS() {
  const settings = settingsManager.get();

  if (settings.tts_provider === 'google' && !settings.google_tts_api_key) {
    showToast('Add Google TTS API key in Settings', 'error');
    showView('settings');
    populateSettingsForm();
    return;
  }

  ttsEnabled = !ttsEnabled;
  updateTTSButton();

  if (ttsEnabled) {
    if (settings.tts_provider === 'google') {
      googleTTS.configure({
        apiKey: settings.google_tts_api_key,
        voice: settings.google_tts_voice,
        languageCode: settings.google_tts_voice?.replace(/-Chirp3.*/, '') || 'vi-VN',
        speakingRate: settings.google_tts_speed || 1.0,
      });
    }
    const label = settings.tts_provider === 'google' ? 'Google Chirp 3 HD' : 'Browser TTS';
    showToast(`TTS ON 🔊 (${label})`, 'success');
  } else {
    speechSynthesis.cancel();
    googleTTS.stop();
    showToast('TTS OFF 🔇', 'success');
  }
}

function speakIfEnabled(text) {
  if (!ttsEnabled || !text?.trim()) return;

  const settings = settingsManager.get();

  if (settings.tts_provider === 'google') {
    googleTTS.speak(text);
  } else {
    // Web Speech API
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.target_language === 'vi' ? 'vi-VN' :
                     settings.target_language === 'en' ? 'en-US' :
                     settings.target_language === 'ja' ? 'ja-JP' :
                     settings.target_language === 'ko' ? 'ko-KR' :
                     settings.target_language === 'zh' ? 'zh-CN' :
                     settings.target_language || 'vi-VN';
    utterance.rate = settings.browser_tts_rate || 1.0;
    if (settings.browser_tts_voice) {
      const voices = speechSynthesis.getVoices();
      const voice = voices.find(v => v.name === settings.browser_tts_voice);
      if (voice) utterance.voice = voice;
    }
    speechSynthesis.speak(utterance);
  }
}

function updateTTSButton() {
  const btn = document.getElementById('btn-tts');
  btn.classList.toggle('active', ttsEnabled);
  document.getElementById('icon-tts-off').style.display = ttsEnabled ? 'none' : 'block';
  document.getElementById('icon-tts-on').style.display = ttsEnabled ? 'block' : 'none';
}

function playBase64Audio(base64Audio) {
  const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
  audio.play().catch(e => console.warn('[TTS] Playback failed:', e));
}

// ─── Views ────────────────────────────────────────────────────
function showView(view) {
  document.getElementById('main-view').classList.toggle('active', view === 'main');
  document.getElementById('settings-view').classList.toggle('active', view === 'settings');
}

// ─── Settings Form ────────────────────────────────────────────
function populateSettingsForm() {
  const s = settingsManager.get();

  document.getElementById('input-api-key').value = s.soniox_api_key || '';
  document.getElementById('select-source-lang').value = s.source_language || 'auto';
  document.getElementById('select-target-lang').value = s.target_language || 'vi';
  document.getElementById('range-font-size').value = s.font_size || 15;
  document.getElementById('font-size-value').textContent = `${s.font_size || 15}px`;

  // TTS
  const provider = s.tts_provider || 'browser';
  document.getElementById('select-tts-provider').value = provider;
  updateTTSProviderUI(provider);

  document.getElementById('input-google-tts-key').value = s.google_tts_api_key || '';
  document.getElementById('select-google-voice').value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';

  const googleSpeed = s.google_tts_speed || 1.0;
  document.getElementById('range-google-speed').value = googleSpeed;
  document.getElementById('google-speed-value').textContent = `${googleSpeed.toFixed(1)}x`;

  const browserSpeed = s.browser_tts_rate || 1.0;
  document.getElementById('range-browser-speed').value = browserSpeed;
  document.getElementById('browser-speed-value').textContent = `${browserSpeed.toFixed(1)}x`;

  // Custom context
  document.getElementById('input-context-domain').value = s.custom_context?.domain || '';

  // Translation terms
  const termsList = document.getElementById('translation-terms-list');
  termsList.innerHTML = '';
  const terms = s.custom_context?.translation_terms || [];
  terms.forEach(t => addTermRow(t.source, t.target));
}

async function saveSettings() {
  const settings = {
    soniox_api_key: document.getElementById('input-api-key').value.trim(),
    source_language: document.getElementById('select-source-lang').value,
    target_language: document.getElementById('select-target-lang').value,
    font_size: parseInt(document.getElementById('range-font-size').value),
    tts_provider: document.getElementById('select-tts-provider').value,
    google_tts_api_key: document.getElementById('input-google-tts-key').value.trim(),
    google_tts_voice: document.getElementById('select-google-voice').value,
    google_tts_speed: parseFloat(document.getElementById('range-google-speed').value),
    browser_tts_rate: parseFloat(document.getElementById('range-browser-speed').value),
    tts_enabled: false,
    custom_context: null,
  };

  // Custom context
  const domain = document.getElementById('input-context-domain').value.trim();
  const translationTerms = [];
  document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
    const source = row.querySelector('.term-source')?.value.trim();
    const target = row.querySelector('.term-target')?.value.trim();
    if (source && target) translationTerms.push({ source, target });
  });

  if (domain || translationTerms.length > 0) {
    settings.custom_context = {
      domain: domain || null,
      translation_terms: translationTerms,
    };
  }

  try {
    await settingsManager.save(settings);
    fontSize = settings.font_size;
    applyFontSize();
    showToast('Settings saved', 'success');
    showView('main');
  } catch (err) {
    showToast(`Failed to save: ${err}`, 'error');
  }
}

function updateTTSProviderUI(provider) {
  const googleSettings = document.getElementById('tts-google-settings');
  const browserSettings = document.getElementById('tts-browser-settings');
  if (googleSettings) googleSettings.style.display = provider === 'google' ? '' : 'none';
  if (browserSettings) browserSettings.style.display = provider === 'browser' ? '' : 'none';

  const hint = document.getElementById('tts-provider-hint');
  if (hint) {
    hint.textContent = provider === 'google'
      ? 'Near-human quality — requires Google Cloud API key (1M chars/month free)'
      : 'Free, uses your browser\'s built-in voices';
  }
}

function addTermRow(source = '', target = '') {
  const list = document.getElementById('translation-terms-list');
  const row = document.createElement('div');
  row.className = 'term-row';
  row.innerHTML =
    `<input type="text" class="term-source" value="${esc(source)}" placeholder="Source">` +
    `<input type="text" class="term-target" value="${esc(target)}" placeholder="Target">` +
    `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
  row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

// ─── Toast ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}
