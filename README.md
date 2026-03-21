# My Translator — Chrome Extension

Real-time speech translation as a Chrome extension. Capture tab audio, transcribe, translate, and optionally read aloud — directly in your browser.

> **Derived from [My Translator (Desktop)](https://github.com/phuc-nt/my-translator)** — the Tauri-based desktop app for macOS and Windows. This Chrome extension adapts the proven API integration patterns and audio processing pipeline from the desktop version into a browser-native experience.

---

## How It Works

```
Tab Audio (chrome.tabCapture) → PCM 16kHz → Soniox API (STT + Translation) → Side Panel UI
                                                                                ↓ (optional)
                                                                        TTS (Web Speech / Google) → 🔊
```

| Feature | Detail |
|---------|--------|
| **Audio Source** | Active tab audio via `chrome.tabCapture` |
| **STT + Translation** | Soniox API (real-time, 70+ languages) |
| **TTS** | Web Speech API (free, built-in) or Google Chirp 3 HD |
| **UI** | Chrome Side Panel — persistent, non-intrusive |
| **Latency** | ~2–3s (same as desktop) |
| **Cost** | ~$0.12/hr (Soniox API) |

---

## Relationship to Desktop Version

This extension is a **derivative** of [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator), the Tauri desktop app. Key patterns carried over:

| What | Desktop (Reference) | Chrome Extension (This) |
|------|-------------------|------------------------|
| **STT** | Soniox WebSocket — same protocol | ✅ Same client, adapted for extension |
| **Audio Capture** | Rust ScreenCaptureKit / WASAPI | `chrome.tabCapture` + Offscreen Document |
| **Audio Format** | PCM s16le, 16kHz, mono | Same — Web Audio API downsampling |
| **Session Management** | Auto-reset every 3 min | ✅ Same pattern |
| **Context Carryover** | Last 500 chars sent as domain context | ✅ Same pattern |
| **TTS** | Edge TTS (Rust proxy), Google, ElevenLabs | Web Speech API (free), Google Chirp 3 HD |
| **UI** | Tauri WebView overlay | Chrome Side Panel |

### What's NOT carried over
- ❌ Edge TTS (requires custom headers → needs server proxy, not worth it for extension)
- ❌ ElevenLabs TTS (scope reduction — can add later)
- ❌ Local MLX mode (Apple Silicon only, not applicable)
- ❌ Desktop overlay UI (replaced with browser-native Side Panel)

---

## Privacy

**Same philosophy as the desktop version — your data stays yours.**

- Audio captured from tab → sent directly to Soniox API. No relay, no middleman.
- API keys stored in `chrome.storage.local` — never transmitted elsewhere.
- No account, no telemetry, no analytics.
- All processing happens client-side except STT (Soniox) and optional TTS (Google).

---

## Tech Stack

- **Chrome Extension** — Manifest V3
- **Audio Capture** — `chrome.tabCapture` + Offscreen Document
- **Audio Processing** — Web Audio API (AudioContext, downsampling)
- **STT** — Soniox WebSocket API (direct connection)
- **TTS** — Web Speech API (built-in) + Google Cloud TTS (REST)
- **UI** — Chrome Side Panel (vanilla HTML/CSS/JS)
- **Storage** — `chrome.storage.local`

---

## License

MIT
