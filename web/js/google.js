import { CONFIG } from './config.js';
import { toast } from './ui.js';

let tokenClient = null;
let cachedToken = null;
let cachedTokenExpiry = 0;
let pickerLoaded = false;

function waitForGoogle() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2 && window.gapi) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > 10_000) {
        clearInterval(t);
        reject(new Error('Google APIs failed to load'));
      }
    }, 100);
  });
}

async function ensurePicker() {
  if (pickerLoaded) return;
  await new Promise((resolve, reject) => {
    window.gapi.load('picker', { callback: resolve, onerror: reject });
  });
  pickerLoaded = true;
}

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    throw new Error('Google Client ID not configured. See Settings → Google Drive.');
  }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    callback: () => {}, // overridden per call
  });
  return tokenClient;
}

async function requestAccessToken({ forcePrompt = false } = {}) {
  if (!forcePrompt && cachedToken && Date.now() < cachedTokenExpiry - 60_000) {
    return cachedToken;
  }
  await waitForGoogle();
  const client = ensureTokenClient();
  return new Promise((resolve, reject) => {
    client.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      cachedToken = response.access_token;
      cachedTokenExpiry = Date.now() + (response.expires_in || 3600) * 1000;
      resolve(cachedToken);
    };
    try {
      client.requestAccessToken({ prompt: forcePrompt ? 'consent' : '' });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Open Google Drive Picker; resolves with { id, name, mimeType, sizeBytes } or null if cancelled.
 */
export async function pickPdfFromDrive() {
  if (!CONFIG.GOOGLE_API_KEY || !CONFIG.GOOGLE_CLIENT_ID) {
    toast('יש להגדיר Google Client ID + API Key בהגדרות לפני שימוש ב-Picker', 'error');
    throw new Error('Google not configured');
  }

  await waitForGoogle();
  await ensurePicker();
  const accessToken = await requestAccessToken();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes('application/pdf')
      .setSelectFolderEnabled(false)
      .setIncludeFolders(true);

    const builder = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(CONFIG.GOOGLE_API_KEY)
      .setLocale('iw')
      .setTitle('בחר קובץ PDF')
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({
            id: doc.id,
            name: doc.name,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : null,
          });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      });

    if (CONFIG.GOOGLE_APP_ID) builder.setAppId(CONFIG.GOOGLE_APP_ID);

    builder.build().setVisible(true);
  });
}

export function isGoogleConfigured() {
  return Boolean(CONFIG.GOOGLE_CLIENT_ID && CONFIG.GOOGLE_API_KEY);
}
