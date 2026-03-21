/**
 * Background Service Worker — orchestrator
 * 
 * Responsibilities:
 * - Handle extension icon click (user gesture required for tabCapture)
 * - Get tab audio stream ID via chrome.tabCapture
 * - Create/manage offscreen document for audio processing
 * - Route messages between offscreen document and side panel
 */

let isCapturing = false;
let offscreenCreated = false;

// ─── Extension Icon Click ──────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Open side panel
    await chrome.sidePanel.open({ tabId: tab.id });

    if (isCapturing) {
      // Stop capture
      await sendToOffscreen({ type: 'stop-capture' });
      isCapturing = false;
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    // Get stream ID for tab audio capture (requires user gesture — this is it)
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    // Create offscreen document if not exists
    await ensureOffscreenDocument();

    // Send stream ID to offscreen document to start capture
    await sendToOffscreen({
      type: 'start-capture',
      streamId: streamId,
      tabId: tab.id,
    });

    isCapturing = true;
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

  } catch (err) {
    console.error('[BG] Error starting capture:', err);
    broadcast({ type: 'error', message: `Failed to start: ${err.message}` });
  }
});

// ─── Offscreen Document Management ────────────────────────────
async function ensureOffscreenDocument() {
  if (offscreenCreated) {
    // Verify it still exists
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) return;
    offscreenCreated = false;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio and process via Web Audio API for real-time transcription',
  });
  offscreenCreated = true;
  console.log('[BG] Offscreen document created');
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage(message);
}

// ─── Message Router ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Route messages from offscreen to side panel and vice versa
  switch (message.type) {
    // From offscreen → forward to all (side panel will pick up)
    case 'soniox-original':
    case 'soniox-translation':
    case 'soniox-provisional':
    case 'soniox-status':
    case 'soniox-error':
    case 'capture-started':
    case 'capture-stopped':
    case 'capture-error':
      broadcast(message);
      break;

    // From side panel → forward to offscreen
    case 'start-capture':
    case 'stop-capture':
    case 'update-config':
      chrome.runtime.sendMessage(message);
      break;

    // Side panel requests current state
    case 'get-state':
      sendResponse({ isCapturing });
      return true;

    case 'capture-state-changed':
      isCapturing = message.isCapturing;
      if (!isCapturing) {
        chrome.action.setBadgeText({ text: '' });
      } else {
        chrome.action.setBadgeText({ text: 'REC' });
        chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
      }
      break;
  }
});

/**
 * Broadcast a message to all extension contexts (side panel, popup, etc.)
 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No receivers — that's fine (side panel might not be open)
  });
}

// ─── Cleanup ──────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  // If the captured tab was closed, stop capture
  if (isCapturing) {
    sendToOffscreen({ type: 'stop-capture' }).catch(() => {});
    isCapturing = false;
    chrome.action.setBadgeText({ text: '' });
    broadcast({ type: 'capture-stopped', reason: 'tab-closed' });
  }
});
