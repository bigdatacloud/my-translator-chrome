# Implementation Plan — My Translator Chrome Extension

**Date**: 2026-03-21
**Derived from**: [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (Tauri desktop app)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Chrome Extension Architecture](#2-chrome-extension-architecture)
3. [Audio Capture Pipeline](#3-audio-capture-pipeline)
4. [Soniox Integration](#4-soniox-integration)
5. [TTS Integration](#5-tts-integration)
6. [UI/UX Design](#6-uiux-design)
7. [Project Structure](#7-project-structure)
8. [Implementation Phases](#8-implementation-phases)
9. [Proven Patterns from Desktop](#9-proven-patterns-from-desktop)
10. [Known Constraints & Risks](#10-known-constraints--risks)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                         │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │ Service Worker│    │ Offscreen Document│    │  Side Panel   │ │
│  │ (background) │    │ (audio capture)   │    │  (UI)         │ │
│  │              │    │                   │    │               │ │
│  │ • Extension  │    │ • getUserMedia()  │    │ • Transcript  │ │
│  │   lifecycle  │◄──►│ • AudioContext    │    │   display     │ │
│  │ • Tab capture│    │ • PCM resample    │    │ • Controls    │ │
│  │   stream ID  │    │ • Soniox WS       │    │ • Settings    │ │
│  │ • Messaging  │    │ • Audio playback  │    │ • Status      │ │
│  │   hub        │    │   (TTS)           │    │               │ │
│  └──────┬───────┘    └────────┬─────────┘    └───────┬───────┘ │
│         │                     │                       │         │
│         └─────── chrome.runtime.sendMessage ──────────┘         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                    │                          │
                    ▼                          ▼
           ┌──────────────┐           ┌──────────────┐
           │ Soniox API   │           │ Google TTS   │
           │ (WebSocket)  │           │ (REST)       │
           └──────────────┘           └──────────────┘
```

### Why This Architecture

| Component | Role | Why |
|-----------|------|-----|
| **Service Worker** | Orchestrator | MV3 mandates service worker for background. Handles `chrome.tabCapture.getMediaStreamId()` (requires user gesture from popup/action). Routes messages between offscreen doc ↔ side panel. |
| **Offscreen Document** | Audio engine | Service workers can't access DOM/Web Audio APIs. Offscreen doc provides `getUserMedia()`, `AudioContext` for resampling, and WebSocket for Soniox. Also handles TTS audio playback via Web Audio API. |
| **Side Panel** | User interface | Persistent UI that doesn't block page content. Perfect for real-time transcript display. Survives tab switches. |

---

## 2. Chrome Extension Architecture

### Manifest V3 Configuration

```json
{
  "manifest_version": 3,
  "name": "My Translator",
  "version": "0.1.0",
  "description": "Real-time speech translation for any tab",
  "permissions": [
    "tabCapture",
    "offscreen",
    "sidePanel",
    "storage",
    "activeTab"
  ],
  "action": {
    "default_title": "Start translating",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src wss://stt-rt.soniox.com https://texttospeech.googleapis.com"
  }
}
```

### Message Flow

```
User clicks extension icon
        │
        ▼
Service Worker receives chrome.action.onClicked
        │
        ├── 1. chrome.sidePanel.open()
        │
        ├── 2. chrome.tabCapture.getMediaStreamId()
        │       → returns streamId
        │
        ├── 3. chrome.offscreen.createDocument()
        │       → offscreen.html with reason: USER_MEDIA
        │
        └── 4. Send streamId to offscreen doc
                    │
                    ▼
            Offscreen Document:
            • getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } })
            • AudioContext: resample to 16kHz mono PCM
            • Connect to Soniox WebSocket
            • Send PCM frames
            • Receive transcription + translation
            • Forward results to Side Panel via messaging
                    │
                    ▼
            Side Panel:
            • Display original + translation
            • TTS toggle (Web Speech API or Google TTS via offscreen)
```

---

## 3. Audio Capture Pipeline

### Desktop Reference (Proven)
The desktop app uses Rust ScreenCaptureKit to capture system audio at 48kHz, then downsamples to 16kHz mono PCM s16le. Key learnings:
- **200ms buffer** before sending to WebSocket (reduces overhead)
- **16kHz, mono, s16le** is the required format for Soniox
- Continuous stream — no gaps between buffers

### Chrome Extension Approach

```javascript
// In offscreen document:

// 1. Get tab audio stream
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId
    }
  }
});

// 2. Create AudioContext for processing
const audioCtx = new AudioContext({ sampleRate: 16000 });
const source = audioCtx.createMediaStreamSource(stream);

// 3. Use AudioWorklet for efficient PCM extraction
// (ScriptProcessorNode is deprecated)
await audioCtx.audioWorklet.addModule('pcm-processor.js');
const pcmNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
source.connect(pcmNode);

// 4. PCM processor sends Float32 samples via port
// Convert to Int16 (s16le) and buffer 200ms before sending
```

### AudioWorklet Processor (pcm-processor.js)

```javascript
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._bufferSize = 3200; // 200ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0]?.[0]; // mono channel
    if (!input) return true;

    // Accumulate samples
    const newBuffer = new Float32Array(this._buffer.length + input.length);
    newBuffer.set(this._buffer);
    newBuffer.set(input, this._buffer.length);
    this._buffer = newBuffer;

    // Flush when buffer is full (200ms)
    while (this._buffer.length >= this._bufferSize) {
      const chunk = this._buffer.slice(0, this._bufferSize);
      this._buffer = this._buffer.slice(this._bufferSize);

      // Convert Float32 [-1, 1] → Int16 [-32768, 32767]
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
```

### Preserving Tab Audio
When `chrome.tabCapture` captures a tab's audio, the audio is muted for the user by default. To preserve it:

```javascript
// In offscreen document — play back the captured audio
const audioElement = new Audio();
audioElement.srcObject = stream;
audioElement.play();
// Or: connect source to audioCtx.destination (but watch for echo with TTS)
```

> **Decision**: Use `audio.srcObject = stream` approach for passthrough. Simpler and avoids AudioContext routing conflicts with TTS playback.

---

## 4. Soniox Integration

### Direct Port from Desktop
The Soniox WebSocket client from the desktop app (`soniox.js`) is **almost directly reusable**. It uses standard `WebSocket` API with no Tauri-specific code.

### What to Keep (from desktop `soniox.js`)
- ✅ WebSocket connection to `wss://stt-rt.soniox.com/transcribe-websocket`
- ✅ Config message format (api_key, model, audio_format, language_hints, translation)
- ✅ Session auto-reset every 3 minutes (make-before-break)
- ✅ Context carryover (last 500 chars of translations as domain context)
- ✅ Auto-reconnect (max 3 attempts, exponential backoff)
- ✅ Graceful disconnect (send empty ArrayBuffer)
- ✅ Token parsing logic (original, translation, provisional, speaker diarization)
- ✅ Error code handling (401, 402, 408, 429, 4001, 4002, 4003, 4029)
- ✅ Custom context (domain + translation_terms)

### What to Change
- ❌ Remove Tauri-specific `window.__TAURI__` references (none in soniox.js — clean)
- 🔄 Move from ES module `export` to extension-compatible module (or keep ES modules with module service worker)
- 🔄 Soniox client runs in **offscreen document** (has WebSocket access)
- 🔄 Results forwarded to side panel via `chrome.runtime.sendMessage()`

### Key Protocol Constants (proven values)
```javascript
const SONIOX_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SESSION_DURATION_MS = 3 * 60 * 1000;  // 3 min auto-reset
const CONTEXT_HISTORY_CHARS = 500;            // carryover context
const MAX_RECONNECT = 3;
const RECONNECT_DELAY_MS = 2000;
const AUDIO_BUFFER_MS = 200;                  // batch audio
```

---

## 5. TTS Integration

### Provider Selection

| Provider | Desktop | Chrome Extension | Reason |
|----------|---------|-----------------|--------|
| **Web Speech API** | ❌ Not used | ✅ **Primary (free)** | Built into browser, zero setup, decent quality |
| **Google Chirp 3 HD** | ✅ Used | ✅ **Premium option** | REST API, direct call from extension, near-human quality |
| **Edge TTS** | ✅ Primary (via Rust proxy) | ❌ **Dropped** | Requires custom WebSocket headers → impossible from browser JS without server proxy |
| **ElevenLabs** | ✅ Used | ❌ **Dropped (v1)** | Scope reduction. Can add later if demand exists |

### Web Speech API (Primary — Free)

```javascript
// Simple, built-in, no API key needed
function speak(text, lang = 'vi-VN') {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 1.0;
  speechSynthesis.speak(utterance);
}
```

**Pros**: Zero cost, zero setup, works offline
**Cons**: Voice quality varies by OS/browser, limited voice selection

> **Note**: `speechSynthesis` requires a DOM context → runs in **side panel** (has full DOM) or **offscreen document**.

### Google Chirp 3 HD (Premium)

Direct port from desktop `google-tts.js` — uses standard `fetch()` REST API. No changes needed except:
- Audio playback via Web Audio API (in offscreen document)
- Or via `<audio>` element (in side panel)

```javascript
// Same as desktop — proven pattern
const response = await fetch(
  `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: 'MP3', speakingRate },
    }),
  }
);
const data = await response.json();
// data.audioContent = base64 MP3
```

### TTS Audio Playback Architecture

TTS playback happens in the **offscreen document** (has AudioContext) or **side panel** (has DOM for `<audio>` elements).

**Decision**: Use **side panel** for TTS playback.
- Web Speech API needs DOM → side panel has it
- Google TTS returns base64 MP3 → `<audio>` element or AudioContext in side panel
- Keeps offscreen document focused on capture only
- Avoids echo: capture stream (offscreen) is isolated from playback (side panel)

---

## 6. UI/UX Design

### Design Philosophy

The Chrome extension UI should feel like a **native browser feature**, not a ported desktop app.

**Principles**:
1. **Invisible until needed** — one click to start, transcript appears in side panel
2. **Non-intrusive** — side panel doesn't cover page content
3. **Scannable** — translation text is the hero, everything else fades
4. **Fast** — minimal DOM, no animations that block rendering
5. **Clean** — monochrome palette, system font, no decoration noise

### UI Surface: Chrome Side Panel

**Why Side Panel over Popup/Content Script/New Tab**:

| Option | Pros | Cons |
|--------|------|------|
| **Side Panel** ✅ | Persistent, doesn't cover page, survives tab switch, native feel | 400px max width |
| Popup | Simple | Closes when clicking elsewhere — unusable for real-time |
| Content Script | Overlay on page | Z-index fights, CSP issues, DOM pollution |
| New Tab | Full space | Loses context of what you're watching |

### Layout

```
┌──────────────────────────────────┐
│ My Translator            ⚙️  ✕  │ ← Header (minimal)
├──────────────────────────────────┤
│ ● Connected · 02:31             │ ← Status bar (dot + timer)
├──────────────────────────────────┤
│                                  │
│  Speaker 1:                      │
│  Translated text appears here    │
│  flowing naturally as a          │
│  continuous paragraph...         │
│                                  │
│  Speaker 2:                      │
│  Another speaker's translation   │
│  continues flowing...            │
│                                  │
│  ░░░ provisional text... ░░░     │ ← Dimmed, in-progress
│                                  │
├──────────────────────────────────┤
│ 🔊 TTS    A-  A+     📋 Copy   │ ← Action bar (bottom)
└──────────────────────────────────┘
```

### Settings View (inline, replaces transcript)

```
┌──────────────────────────────────┐
│ ← Settings                      │
├──────────────────────────────────┤
│                                  │
│ Soniox API Key                   │
│ ┌────────────────────── 👁 ┐    │
│ │ ••••••••••••••••••••     │    │
│ └──────────────────────────┘    │
│                                  │
│ Source Language                   │
│ ┌──────────────────────────┐    │
│ │ Auto-detect           ▼  │    │
│ └──────────────────────────┘    │
│                                  │
│ Target Language                  │
│ ┌──────────────────────────┐    │
│ │ Vietnamese            ▼  │    │
│ └──────────────────────────┘    │
│                                  │
│ ── TTS ──                        │
│ Provider: ○ Browser  ○ Google    │
│ Speed: [────●────] 1.0x          │
│                                  │
│ ── Advanced ──                   │
│ Custom context: [............]   │
│ Translation terms:               │
│   source → target    [+ Add]     │
│                                  │
│         [ Save Settings ]        │
└──────────────────────────────────┘
```

### Color Palette

```css
:root {
  --bg-primary: #1a1a1a;
  --bg-secondary: #242424;
  --bg-elevated: #2a2a2a;
  --text-primary: #e8e8e8;
  --text-secondary: #888888;
  --text-provisional: #555555;
  --accent: #4a9eff;
  --accent-dim: #2a5a9a;
  --success: #4caf50;
  --error: #e74c3c;
  --border: #333333;
}
```

### Typography
- **Font**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
- **Base size**: 15px (transcript), 13px (UI chrome)
- **No external font loading** — fastest possible render

### State Machine

```
IDLE → CONNECTING → CAPTURING → ERROR
  ↑                    │          │
  └────────────────────┘──────────┘
        (stop/disconnect)
```

| State | Icon Color | Status Text | Actions Available |
|-------|-----------|-------------|-------------------|
| IDLE | ⚪ gray | Ready | Start |
| CONNECTING | 🟡 yellow | Connecting... | Cancel |
| CAPTURING | 🟢 green | Connected · 00:00 | Stop, TTS, Copy, Clear |
| ERROR | 🔴 red | Error message | Retry, Settings |

---

## 7. Project Structure

```
my-translator-chrome/
├── README.md
├── docs/
│   └── implementation_plan.md    ← this file
├── src/
│   ├── manifest.json             ← Manifest V3
│   ├── background.js             ← Service worker (orchestrator)
│   ├── offscreen.html            ← Minimal HTML for offscreen doc
│   ├── offscreen.js              ← Audio capture + Soniox WS
│   ├── pcm-processor.js          ← AudioWorklet for PCM extraction
│   ├── soniox.js                 ← Soniox WebSocket client (ported from desktop)
│   ├── sidepanel.html            ← Side panel UI
│   ├── sidepanel.js              ← Side panel logic
│   ├── sidepanel.css             ← Side panel styles
│   ├── google-tts.js             ← Google Chirp 3 HD (ported from desktop)
│   ├── settings.js               ← Settings management (chrome.storage)
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── .gitignore
└── LICENSE
```

**No build step required** — vanilla JS, loaded directly by Chrome. This keeps the project simple, fast to iterate, and easy to debug.

---

## 8. Implementation Phases

### Phase 1: Foundation (MVP Audio → Transcript)
**Goal**: Click extension → capture tab audio → show Soniox transcript in side panel

- [ ] Create `manifest.json` with required permissions
- [ ] Implement `background.js` — handle action click, get stream ID, create offscreen doc, open side panel
- [ ] Implement `offscreen.js` — receive stream ID, getUserMedia, AudioContext + AudioWorklet for 16kHz PCM
- [ ] Port `soniox.js` from desktop (minimal changes)
- [ ] Wire offscreen → soniox → side panel message flow
- [ ] Basic `sidepanel.html/js/css` — display transcript text
- [ ] Tab audio passthrough (user still hears audio)

**Milestone**: User captures tab audio and sees real-time transcript

### Phase 2: Settings & Configuration
**Goal**: User can configure API key, languages, and persist settings

- [ ] Implement `settings.js` using `chrome.storage.local`
- [ ] Settings view in side panel (inline, replaces transcript)
- [ ] API key input with show/hide toggle
- [ ] Source/target language selectors
- [ ] Custom context (domain + translation terms)
- [ ] Onboarding: first-run detection → auto-open settings

**Milestone**: Full configuration experience

### Phase 3: TTS
**Goal**: Read translations aloud

- [ ] Web Speech API integration (side panel)
- [ ] Port `google-tts.js` from desktop
- [ ] TTS toggle button with provider selection
- [ ] Audio queue management (prevent overlap)
- [ ] Speed control

**Milestone**: TTS works with both providers

### Phase 4: Polish & Edge Cases
**Goal**: Production-ready quality

- [ ] Error handling for all failure modes (no API key, network error, tab closed, permission denied)
- [ ] Session timer display (elapsed time)
- [ ] Font size controls (A- / A+)
- [ ] Copy transcript to clipboard
- [ ] Smart scroll (auto-scroll when at bottom, stay put when scrolled up)
- [ ] Graceful cleanup when tab closes or navigates
- [ ] Extension icon badge (recording indicator)
- [ ] Keyboard shortcut for start/stop

### Phase 5: Packaging & Distribution
**Goal**: Publish to Chrome Web Store

- [ ] Create production icons (16, 48, 128)
- [ ] Write Chrome Web Store listing (description, screenshots)
- [ ] Privacy policy page
- [ ] Package as .zip for Chrome Web Store
- [ ] Submit for review

---

## 9. Proven Patterns from Desktop

These patterns have been **validated through 9 development phases** of the desktop app and should be replicated:

### 9.1 Soniox Session Management
**Problem**: Soniox connections degrade after ~3 minutes.
**Solution**: Auto-reset with make-before-break pattern.
```
Every 3 min:
1. Open NEW WebSocket connection
2. Wait for new WS to confirm open
3. Send config to new WS (with carryover context)
4. Close OLD WebSocket gracefully (send empty ArrayBuffer)
5. Switch to new WS
→ Zero audio gap during reset
```

### 9.2 Context Carryover
**Problem**: After session reset, Soniox loses context → translation quality drops.
**Solution**: Keep rolling buffer of last 500 chars of translations, send as `context.domain` with new session.

### 9.3 Audio Buffering
**Problem**: Sending every audio frame individually → excessive WebSocket overhead.
**Solution**: Buffer 200ms of PCM data before sending as one binary frame.
- At 16kHz, 200ms = 3200 samples = 6400 bytes per frame
- Good balance between latency and efficiency

### 9.4 Stale Original Cleanup
**Problem**: Some "original" segments never receive translations (Soniox quirk).
**Solution**:
- Remove originals older than 10 seconds
- Keep max 3 pending originals
- Prevents UI from showing stale untranslated text

### 9.5 Smart Scroll
**Problem**: Auto-scroll yanks user back to bottom when they're reading old content.
**Solution**: Only auto-scroll if user is within 100px of the bottom.
```javascript
const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
if (isNearBottom) el.scrollTop = el.scrollHeight;
```

### 9.6 Segment Trimming
**Problem**: Transcript grows indefinitely → memory + DOM performance issues.
**Solution**: Cap at ~1200 chars total. Drop oldest segments when exceeded.

### 9.7 Audio Player Queue
**Problem**: TTS requests can pile up faster than playback.
**Solution**: Queue-based AudioPlayer with max queue size (10 buffers). Drop oldest when exceeded.

### 9.8 Graceful WebSocket Disconnect
**Problem**: Abrupt close → Soniox may not finalize last transcript.
**Solution**: Send empty ArrayBuffer before closing WebSocket.

---

## 10. Known Constraints & Risks

### Chrome Extension Specific

| Constraint | Impact | Mitigation |
|-----------|--------|------------|
| **tabCapture requires user gesture** | Can't auto-start capture | User must click extension icon to begin |
| **Offscreen document limit: 1 per extension** | Can't have separate docs for capture + TTS | All audio processing in single offscreen doc |
| **Service worker can sleep** | May lose state | Offscreen document handles all persistent work. Service worker is just orchestrator. |
| **Side panel width ~400px** | Limited horizontal space | Single-column layout, no dual-panel view |
| **CSP in extension pages** | No inline scripts | All JS in separate files |
| **Tab audio capture mutes tab by default** | User can't hear audio | Passthrough via `<audio>` element or AudioContext destination |

### Edge TTS Limitation

Edge TTS requires:
1. Custom `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold` header
2. `Sec-MS-GEC` DRM token (anti-abuse)
3. Custom User-Agent + cookies

Browser WebSocket API **cannot set custom headers**. Desktop solves this with Rust proxy.
Chrome extension could technically use a background fetch + WebSocket proxy pattern, but:
- Complexity not worth it for a free TTS fallback
- **Web Speech API** covers the free tier adequately
- If users want premium, **Google Chirp 3 HD** is available

**Decision**: Drop Edge TTS. Use Web Speech API (free) + Google TTS (premium).

### Performance Considerations

1. **AudioWorklet vs ScriptProcessorNode**: Must use AudioWorklet — ScriptProcessorNode runs on main thread and is deprecated
2. **Message passing overhead**: Offscreen → Side Panel messaging is async. For real-time transcript, this adds ~1-2ms latency — negligible
3. **Memory**: Transcript trimming (1200 chars) keeps DOM small. No memory leaks from accumulated nodes
4. **Wake locks**: Consider using Web Locks API to prevent service worker from sleeping during capture

---

## Appendix: Desktop Code Reference

When implementing, reference these files from `phuc-nt/my-translator`:

| Desktop File | What to Reference | For Phase |
|-------------|-------------------|-----------|
| `src/js/soniox.js` | WebSocket protocol, session reset, context carryover, token parsing | Phase 1 |
| `src/js/audio-player.js` | Queue-based audio playback with Web Audio API | Phase 3 |
| `src/js/google-tts.js` | Google Chirp 3 HD REST API integration, voice map | Phase 3 |
| `src/js/ui.js` | Segment management, smart scroll, stale original cleanup | Phase 1, 4 |
| `src/js/settings.js` | Settings structure and persistence pattern | Phase 2 |
| `src-tauri/src/commands/edge_tts.rs` | ❌ NOT applicable — Rust-specific, can't use in browser | — |
