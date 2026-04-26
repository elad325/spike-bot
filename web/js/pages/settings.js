import { CONFIG } from '../config.js';
import { getSettings, updateSettings } from '../api.js';
import { toast, escapeHtml, formatRelative, setBtnLoading, confirmDialog } from '../ui.js';

/**
 * Open Google OAuth in a popup that targets the Supabase Edge Function.
 * The function-side callback page postMessages back to us with
 * { type:'spike:google-connected', ok, email, message }, then closes.
 *
 * Falls back to detecting popup.closed in case the message never arrives
 * (e.g. user closed the window mid-flow) so the promise can't hang.
 */
function startOAuthPopup() {
  return new Promise((resolve) => {
    const returnUrl = window.location.href;
    const initUrl =
      `${CONFIG.SUPABASE_URL}/functions/v1/google-oauth-init` +
      `?return=${encodeURIComponent(returnUrl)}`;
    const popup = window.open(
      initUrl,
      'spike-google-oauth',
      'width=520,height=680,menubar=no,toolbar=no'
    );

    if (!popup) {
      resolve({
        ok: false,
        message: 'הדפדפן חסם את החלון הקופץ. אפשר להתיר ונסה שוב.',
      });
      return;
    }

    let settled = false;
    const onMessage = (e) => {
      const data = e.data;
      if (!data || data.type !== 'spike:google-connected') return;
      // Only trust messages from our own Supabase Edge Function origin.
      try {
        const origin = new URL(CONFIG.SUPABASE_URL).origin;
        if (e.origin !== origin) return;
      } catch {
        return;
      }
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      try { popup.close(); } catch {}
      resolve({
        ok: !!data.ok,
        email: data.email || null,
        message: data.message || null,
      });
    };
    window.addEventListener('message', onMessage);

    const closedTimer = setInterval(() => {
      if (popup.closed && !settled) {
        settled = true;
        window.removeEventListener('message', onMessage);
        clearInterval(closedTimer);
        resolve({ ok: false, cancelled: true, message: 'הפעולה בוטלה' });
      }
    }, 600);
  });
}

export async function renderSettingsPage(container) {
  const settings = await getSettings();
  const driveConnected = Boolean(settings.google_refresh_token);
  const googleConfigured = Boolean(CONFIG.GOOGLE_CLIENT_ID && CONFIG.GOOGLE_API_KEY);

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">הגדרות</h1>
          <p class="page-subtitle">קונפיגורציה כללית של הבוט</p>
        </div>
      </div>

      <!-- Google Drive -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header">
          <div>
            <div class="card-title">🗂️ Google Drive</div>
            <div style="font-size:.85rem;color:var(--text-muted);margin-top:.25rem">
              חשבון הדרייב שממנו הבוט שולח קבצים
            </div>
          </div>
          ${driveConnected
            ? '<span class="tag tag-success">מחובר ✓</span>'
            : '<span class="tag tag-danger">לא מחובר</span>'}
        </div>

        <div id="drive-account-block">
          ${driveConnected
            ? `<div style="padding:.85rem 1rem;background:var(--bg-hover);border-radius:var(--radius);font-size:.9rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
                <div>
                  <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:.15rem">חשבון מחובר</div>
                  <div><strong id="drive-email">${escapeHtml(settings.google_email || '-')}</strong></div>
                </div>
                <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                  <button class="btn btn-ghost" id="change-drive-btn" type="button">
                    🔄 החלף חשבון
                  </button>
                  <button class="btn btn-danger" id="disconnect-drive-btn" type="button">
                    🔌 נתק
                  </button>
                </div>
              </div>`
            : `<div style="padding:.85rem 1rem;background:var(--warning-soft);color:var(--warning);border-radius:var(--radius);font-size:.9rem;line-height:1.6;margin-bottom:.75rem">
                <strong>נדרשת פעולה:</strong> כדי שהבוט יוכל לשלוח קבצים, יש לחבר חשבון Google Drive.
              </div>
              <button class="btn btn-primary" id="change-drive-btn" type="button">
                🔗 חבר חשבון Google Drive
              </button>`}
        </div>
      </div>

      <!-- Google Picker config -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header">
          <div>
            <div class="card-title">🔑 Google Cloud (לבחירת קבצים)</div>
            <div style="font-size:.85rem;color:var(--text-muted);margin-top:.25rem">
              נדרש כדי לפתוח את ה-Google Drive Picker בעת הוספת קבצים לתפריטים
            </div>
          </div>
          <span class="tag ${googleConfigured ? 'tag-success' : 'tag-warning'}">
            ${googleConfigured ? 'מוגדר' : 'לא מוגדר'}
          </span>
        </div>
        ${googleConfigured
          ? `<p style="color:var(--text-muted);font-size:.9rem">המפתחות מוגדרים. אפשר להוסיף קבצים מהדרייב מתוך עריכת התפריטים.</p>`
          : `<div style="padding:.85rem 1rem;background:var(--warning-soft);color:var(--warning);border-radius:var(--radius);font-size:.9rem;line-height:1.7">
              צריך לערוך את הקובץ <code>web/js/config.js</code> ולמלא את:
              <ul style="margin:.5rem 1.5rem 0">
                <li><code>GOOGLE_CLIENT_ID</code></li>
                <li><code>GOOGLE_API_KEY</code></li>
              </ul>
              ראה את ה-SETUP.md לפרטים מלאים.
            </div>`}
      </div>

      <!-- Bot Status -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header">
          <div class="card-title">🤖 סטטוס הבוט</div>
        </div>
        <div class="stats-grid" style="margin:0">
          <div class="stat-card">
            <div class="label">סימן חיים אחרון</div>
            <div class="value" style="font-size:1.1rem">${settings.bot_last_seen_at ? formatRelative(settings.bot_last_seen_at) : 'אף פעם'}</div>
          </div>
          <div class="stat-card">
            <div class="label">שם הבוט</div>
            <div class="value" style="font-size:1.1rem">${escapeHtml(settings.bot_name)}</div>
          </div>
        </div>
      </div>

      <!-- Bot messages -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header">
          <div class="card-title">💬 הודעות הבוט</div>
        </div>
        <form id="messages-form" style="display:flex;flex-direction:column;gap:1rem">
          <label>
            <span>הודעת ברוכים הבאים (משתמש מאושר)</span>
            <textarea name="welcome_message" rows="2">${escapeHtml(settings.welcome_message || '')}</textarea>
          </label>
          <label>
            <span>הודעה למשתמש שממתין לאישור</span>
            <textarea name="pending_message" rows="2">${escapeHtml(settings.pending_message || '')}</textarea>
          </label>
          <label>
            <span>זמן חוסר פעילות עד שליחת תפריט ראשי (בדקות)</span>
            <input type="number" name="inactivity_timeout_minutes" min="1" max="1440" value="${settings.inactivity_timeout_minutes}" />
          </label>
          <div>
            <button type="submit" class="btn btn-primary" id="save-messages">שמור</button>
          </div>
        </form>
      </div>

      <!-- About -->
      <div class="card" style="margin-bottom:1rem">
        <div class="card-header">
          <div class="card-title">ℹ️ אודות</div>
        </div>
        <div style="font-size:.9rem;color:var(--text-muted);line-height:1.7">
          <strong>SPIKE Bot</strong> - בוט וואטסאפ עם תפריטים ניתנים להגדרה.<br>
          הבוט רץ באמצעות <code>Baileys</code> במכונה המקומית שלך עם <code>PM2</code>, ושומר נתונים ב-Supabase.<br>
          <br>
          <strong>קישורים שימושיים:</strong>
          <ul style="margin-top:.5rem">
            <li><a href="https://supabase.com/dashboard/project/llvqhovssnjhxxexndbq" target="_blank" style="color:var(--primary)">Supabase Dashboard</a></li>
            <li><a href="https://console.cloud.google.com/" target="_blank" style="color:var(--primary)">Google Cloud Console</a></li>
          </ul>
        </div>
      </div>
    </div>
  `;

  // ----- Bot messages form -----
  const form = container.querySelector('#messages-form');
  const saveBtn = container.querySelector('#save-messages');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBtnLoading(saveBtn, true);
    try {
      const data = new FormData(form);
      const patch = {
        welcome_message: data.get('welcome_message'),
        pending_message: data.get('pending_message'),
        inactivity_timeout_minutes: parseInt(data.get('inactivity_timeout_minutes'), 10) || 60,
      };
      await updateSettings(patch);
      toast('ההגדרות נשמרו', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBtnLoading(saveBtn, false);
    }
  });

  // ----- Change Google Drive account -----
  const changeBtn = container.querySelector('#change-drive-btn');
  if (changeBtn) {
    changeBtn.addEventListener('click', async () => {
      setBtnLoading(changeBtn, true);
      const result = await startOAuthPopup();
      setBtnLoading(changeBtn, false);

      if (result.cancelled) return; // silent — user closed the popup
      if (!result.ok) {
        toast(result.message || 'החיבור נכשל', 'error', 5000);
        return;
      }

      toast(`חובר בהצלחה: ${result.email}`, 'success');
      // The bot reads google_refresh_token straight from app_settings on
      // every Drive call, so the new account takes effect on the next file
      // request without restarting the bot. We just need to refresh the UI.
      await renderSettingsPage(container);
    });
  }

  // ----- Disconnect Google Drive account -----
  // Clears the OAuth tokens from app_settings. The bot reads these on every
  // Drive call, so once cleared the next file request returns the friendly
  // "Google Drive not connected" error to the WhatsApp user. We do NOT call
  // Google's revoke endpoint from here — doing so would require sending the
  // refresh token to a separate Edge Function. Instead we tell the user
  // they can revoke at myaccount.google.com if they want full revocation.
  const disconnectBtn = container.querySelector('#disconnect-drive-btn');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'ניתוק Google Drive',
        message:
          `לנתק את חשבון "${settings.google_email || ''}"? ` +
          `הבוט יפסיק לשלוח קבצים עד שתחבר חשבון מחדש. ` +
          `(ההרשאה אצל Google עצמה נשארת — אם תרצה לבטל לגמרי, ` +
          `הסר את האפליקציה ב-myaccount.google.com/permissions.)`,
        danger: true,
        confirmText: 'נתק',
      });
      if (!ok) return;

      setBtnLoading(disconnectBtn, true);
      try {
        await updateSettings({
          google_refresh_token: null,
          google_access_token: null,
          google_token_expiry: null,
          google_email: null,
        });
        toast('החשבון נותק', 'success');
        await renderSettingsPage(container);
      } catch (err) {
        toast(err.message || 'הניתוק נכשל', 'error');
        setBtnLoading(disconnectBtn, false);
      }
    });
  }
}
