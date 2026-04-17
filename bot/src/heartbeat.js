import { supabase } from './supabase.js';
import { log } from './utils/logger.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
let timer = null;

async function ping() {
  try {
    const { data: settings } = await supabase
      .from('app_settings')
      .select('id')
      .limit(1)
      .single();
    if (settings?.id) {
      await supabase
        .from('app_settings')
        .update({ bot_last_seen_at: new Date().toISOString() })
        .eq('id', settings.id);
    }
  } catch (err) {
    log.debug('Heartbeat failed:', err.message);
  }
}

export function startHeartbeat() {
  ping();
  timer = setInterval(ping, HEARTBEAT_INTERVAL_MS);
  log.info(`💓 Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}
