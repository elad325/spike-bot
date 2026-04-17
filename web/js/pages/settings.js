import { CONFIG } from '../config.js';
import { getSettings, updateSettings } from '../api.js';
import { toast, escapeHtml, formatRelative, setBtnLoading } from '../ui.js';

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
        ${driveConnected
          ? `<div style="padding:.85rem 1rem;background:var(--bg-hover);border-radius:var(--radius);font-size:.9rem">
              <div><strong>חשבון:</strong> ${escapeHtml(settings.google_email || '-')}</div>
            </div>`
          : `<div style="padding:.85rem 1rem;background:var(--warning-soft);color:var(--warning);border-radius:var(--radius);font-size:.9rem;line-height:1.6">
              <strong>נדרשת פעולה:</strong> כדי להפעיל את הבוט, יש לחבר חשבון Google Drive.<br>
              הפעל בטרמינל את הפקודה <code>npm run setup-google</code> בתיקיית <code>bot/</code>.
            </div>`}
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
}
