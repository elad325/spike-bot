/**
 * SPIKE Dashboard - Configuration
 *
 * To customize for your deployment, copy this file to `config.local.js`
 * and override values there. config.local.js is gitignored.
 */
export const CONFIG = {
  // Supabase project
  SUPABASE_URL: 'https://llvqhovssnjhxxexndbq.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdnFob3Zzc25qaHh4ZXhuZGJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MDIzNzYsImV4cCI6MjA5MTk3ODM3Nn0.qXkNQfdxWRewmaDChlxGBLFWyhJ5OoRjxNGp3RBQUXU',

  // Google OAuth (fill in after creating Google Cloud project)
  GOOGLE_CLIENT_ID: '942116654792-vr9a421cj2aev4152truhcuhp5bs8uh0.apps.googleusercontent.com',
  GOOGLE_API_KEY: 'AIzaSyDYiVdVogh6JvtUGx79947jLuSZvVNc4Xw',
  GOOGLE_APP_ID: '942116654792', // (optional) project number from Google Cloud Console

  // Bot heartbeat freshness threshold (in seconds)
  BOT_ONLINE_THRESHOLD_SECONDS: 120,
};

// Allow runtime override via window.SPIKE_CONFIG (set by config.local.js if present)
if (typeof window !== 'undefined' && window.SPIKE_CONFIG) {
  Object.assign(CONFIG, window.SPIKE_CONFIG);
}
