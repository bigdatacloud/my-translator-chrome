/**
 * Settings Manager — chrome.storage.local based
 * 
 * Manages all extension settings with defaults.
 * Settings stored as single JSON object in chrome.storage.local.
 */

const DEFAULT_SETTINGS = {
  soniox_api_key: '',
  source_language: 'auto',
  target_language: 'vi',
  font_size: 15,
  show_original: false,
  tts_enabled: false,
  tts_provider: 'browser',        // 'browser' | 'google'
  google_tts_api_key: '',
  google_tts_voice: 'vi-VN-Chirp3-HD-Aoede',
  google_tts_speed: 1.0,
  browser_tts_voice: '',          // system default
  browser_tts_rate: 1.0,
  custom_context: null,           // { domain: string, translation_terms: [{source, target}] }
};

export class SettingsManager {
  constructor() {
    this._settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  async load() {
    return new Promise((resolve) => {
      chrome.storage.local.get('settings', (result) => {
        if (result.settings) {
          this._settings = { ...DEFAULT_SETTINGS, ...result.settings };
        }
        resolve(this._settings);
      });
    });
  }

  async save(settings) {
    this._settings = { ...DEFAULT_SETTINGS, ...settings };
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ settings: this._settings }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          this._notifyListeners(this._settings);
          resolve(this._settings);
        }
      });
    });
  }

  get() {
    return { ...this._settings };
  }

  onChange(listener) {
    this._listeners.push(listener);
  }

  _notifyListeners(settings) {
    for (const listener of this._listeners) {
      listener(settings);
    }
  }

  /**
   * Check if first run (no API key configured)
   */
  isFirstRun() {
    return !this._settings.soniox_api_key;
  }
}

export const settingsManager = new SettingsManager();
