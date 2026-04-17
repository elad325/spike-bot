/**
 * One-time setup script: authorize the bot to access Google Drive.
 *
 * Usage:  node setup-google.js
 *
 * This script:
 *   1. Opens a browser to Google's OAuth consent page.
 *   2. Listens on http://localhost:8765/callback for the OAuth response.
 *   3. Exchanges the auth code for refresh + access tokens.
 *   4. Saves the refresh token to Supabase (app_settings table).
 *
 * After completing this once, the bot can download any file from your Drive
 * using the saved refresh token.
 */
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';
import { supabase } from './src/supabase.js';

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  console.error('   Fill them in based on the values in Google Cloud Console.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force consent to ensure we get a refresh token
});

const successHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>SPIKE - חובר בהצלחה</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1729; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #1e293b; padding: 3rem; border-radius: 1rem; text-align: center; max-width: 480px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
  h1 { color: #5b8def; margin-top: 0; }
  p { color: #94a3b8; line-height: 1.6; }
  .check { font-size: 4rem; margin-bottom: 1rem; }
</style></head>
<body><div class="card">
  <div class="check">✅</div>
  <h1>מחובר ל-Google Drive!</h1>
  <p>הבוט יכול עכשיו להוריד קבצים מהדרייב שלך.<br>אפשר לסגור את החלון הזה ולהפעיל את הבוט.</p>
</div></body></html>`;

const errorHtml = (msg) => `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><title>שגיאה</title>
<style>body{font-family:system-ui;background:#0f1729;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.card{background:#1e293b;padding:3rem;border-radius:1rem;text-align:center;max-width:480px;}
h1{color:#ef4444;}p{color:#94a3b8;}</style></head>
<body><div class="card"><h1>❌ שגיאה</h1><p>${msg}</p></div></body></html>`;

function shutdown(server, code = 0) {
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 500);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    console.error(`❌ OAuth error: ${error}`);
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml(error));
    shutdown(server, 1);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml('No code received'));
    shutdown(server, 1);
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      const msg = 'לא קיבלנו refresh_token. נסה שוב — ייתכן שכבר אישרת את האפליקציה. אפשר לבטל הרשאה בקישור: https://myaccount.google.com/permissions ולהריץ שוב.';
      console.error('❌', msg);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml(msg));
      shutdown(server, 1);
      return;
    }

    // Get the email of the connected account
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email;

    const { data: settings } = await supabase
      .from('app_settings')
      .select('id')
      .limit(1)
      .single();

    await supabase
      .from('app_settings')
      .update({
        google_refresh_token: tokens.refresh_token,
        google_access_token: tokens.access_token,
        google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        google_email: email,
      })
      .eq('id', settings.id);

    console.log('✅ Successfully connected to Google Drive');
    console.log(`   Connected account: ${email}`);
    console.log('   Refresh token saved to Supabase.');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(successHtml);
    shutdown(server, 0);
  } catch (err) {
    console.error('❌ Token exchange failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml(err.message));
    shutdown(server, 1);
  }
});

server.listen(PORT, () => {
  console.log(`\n🌐 Open this URL in your browser to authorize the bot:\n`);
  console.log(`   ${authUrl}\n`);
  console.log(`📡 Waiting for response on http://localhost:${PORT}/callback ...\n`);
});
