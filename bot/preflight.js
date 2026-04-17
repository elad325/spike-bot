/**
 * Preflight check - verifies the bot is ready to start.
 *
 * Exit codes (consumed by start-bot.bat):
 *    0  - all good, bot can start
 *   10  - Supabase env vars missing in .env
 *   11  - Supabase unreachable / bad credentials
 *   12  - Google Drive not connected (no refresh_token in DB)
 *   13  - Google client_id / client_secret missing in .env
 */
import 'dotenv/config';

const CODES = {
  OK: 0,
  SUPABASE_ENV_MISSING: 10,
  SUPABASE_UNREACHABLE: 11,
  GOOGLE_NOT_CONNECTED: 12,
  GOOGLE_ENV_MISSING: 13,
};

class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isBlank(v) {
  return !v || String(v).trim() === '';
}

async function run() {
  const supaMissing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(k => isBlank(process.env[k]));
  if (supaMissing.length) {
    throw new PreflightError(CODES.SUPABASE_ENV_MISSING, `Missing in .env: ${supaMissing.join(', ')}`);
  }

  const googleMissing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter(k => isBlank(process.env[k]));
  if (googleMissing.length) {
    throw new PreflightError(CODES.GOOGLE_ENV_MISSING, `Missing in .env: ${googleMissing.join(', ')}`);
  }

  let supabase;
  try {
    ({ supabase } = await import('./src/supabase.js'));
  } catch (err) {
    throw new PreflightError(CODES.SUPABASE_ENV_MISSING, err.message);
  }

  let settings;
  try {
    const res = await supabase
      .from('app_settings')
      .select('google_refresh_token, google_email')
      .limit(1)
      .single();
    if (res.error) throw res.error;
    settings = res.data;
  } catch (err) {
    throw new PreflightError(CODES.SUPABASE_UNREACHABLE, `Supabase query failed: ${err.message || err}`);
  }

  if (isBlank(settings?.google_refresh_token)) {
    throw new PreflightError(CODES.GOOGLE_NOT_CONNECTED, 'Google Drive is not connected yet');
  }

  return settings;
}

try {
  const settings = await run();
  console.log(`[preflight] OK (Drive account: ${settings.google_email || 'unknown'})`);
  process.exitCode = CODES.OK;
} catch (err) {
  console.error(`[preflight] FAIL: ${err.message}`);
  process.exitCode = err instanceof PreflightError ? err.code : 1;
}

// Supabase's undici client keeps keep-alive sockets open which can keep
// the event loop alive past our checks. Give natural shutdown a brief
// window, then force-exit. The unref() lets a faster natural exit win.
setTimeout(() => process.exit(process.exitCode), 1500).unref();
