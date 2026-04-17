# SPIKE - מדריך התקנה מלא

מדריך זה מנחה אותך שלב-אחר-שלב להתקנה ולהפעלה של בוט SPIKE.

---

## 📋 דרישות מקדימות

לפני שמתחילים, ודא שיש לך:

- ✅ **Node.js 18+** מותקן ([להורדה](https://nodejs.org))
- ✅ **חשבון Google** עם הקבצים שתרצה שהבוט ישלח (PDF בדרייב)
- ✅ **חשבון WhatsApp ייעודי** לבוט (מומלץ - לא חשבון פרטי שלך)
- ✅ **חשבון GitHub** (להעלאת הממשק ל-GitHub Pages)
- ✅ **סופאבייס** - הפרויקט כבר נוצר בתהליך ההקמה (`spike-whatsapp-bot`)

---

## 🚀 התקנה - 7 שלבים

### שלב 1: התחבר ל-Supabase ויצור משתמש מנהל

הממשק משתמש ב-Supabase Auth. צריך ליצור פעם אחת את חשבון המנהל.

1. היכנס ל-[Supabase Dashboard](https://supabase.com/dashboard/project/llvqhovssnjhxxexndbq)
2. בתפריט השמאלי, לחץ **Authentication → Users**
3. לחץ **Add user → Create new user**
4. הכנס את האימייל שלך + סיסמה חזקה
5. ✅ סמן **"Auto Confirm User"** (כדי שלא תצטרך לאמת אימייל)
6. לחץ **Create user**

📝 **רשום את האימייל והסיסמה** - זה מה שתשתמש להתחברות לממשק.

---

### שלב 2: השג את ה-Service Role Key

הבוט (שרץ אצלך מקומית) צריך את ה-Service Role Key כדי לכתוב לדאטאבייס.

1. ב-Supabase Dashboard → **Project Settings** (סמל הגלגל) → **API**
2. גלול ל-**Project API keys**
3. במקטע "**service_role secret**" - לחץ על **Reveal** ואז **Copy**

⚠️ **שמור את המפתח הזה בסוד!** הוא נותן גישה מלאה לדאטאבייס.

---

### שלב 3: צור פרויקט ב-Google Cloud

זה החלק הארוך ביותר אבל חד-פעמי. אתה צריך:
- **OAuth Client ID** (ל-Picker בממשק וגישה לדרייב מהבוט)
- **OAuth Client Secret** (לבוט בלבד)
- **API Key** (ל-Picker)

#### 3.1 צור פרויקט

1. היכנס ל-[Google Cloud Console](https://console.cloud.google.com/)
2. למעלה לחץ על שם הפרויקט (או "Select a project") → **NEW PROJECT**
3. שם: `SPIKE Bot` → **CREATE**
4. ודא שהפרויקט החדש נבחר בחלק העליון

#### 3.2 הפעל את ה-API של Drive ו-Picker

1. בתפריט הצד: **APIs & Services → Library**
2. חפש **"Google Drive API"** → לחץ → **ENABLE**
3. חזור לחיפוש, חפש **"Google Picker API"** → לחץ → **ENABLE**

#### 3.3 הגדר OAuth Consent Screen

1. **APIs & Services → OAuth consent screen**
2. בחר **External** → **CREATE**
3. מלא:
   - App name: `SPIKE Bot`
   - User support email: האימייל שלך
   - Developer contact: האימייל שלך
4. **SAVE AND CONTINUE**
5. בעמוד **Scopes** - לחץ **ADD OR REMOVE SCOPES**
6. סמן: `.../auth/drive.readonly` → **UPDATE**
7. **SAVE AND CONTINUE**
8. בעמוד **Test users** - לחץ **+ ADD USERS** והוסף את **האימייל של ה-Google שלך** (זה שיש בו את הקבצים)
9. **SAVE AND CONTINUE**

> 💡 כל עוד האפליקציה ב-"Testing", רק משתמשי Test יכולים להתחבר. זה בסדר כי אתה היחיד שצריך גישה.

#### 3.4 צור OAuth Client ID

1. **APIs & Services → Credentials**
2. **+ CREATE CREDENTIALS → OAuth client ID**
3. Application type: **Web application**
4. Name: `SPIKE Web + Bot`
5. **Authorized JavaScript origins** - הוסף:
   - `https://YOUR_GITHUB_USERNAME.github.io` (החלף ב-username שלך)
   - `http://localhost:5500` (לבדיקות מקומיות)
6. **Authorized redirect URIs** - הוסף:
   - `http://localhost:8765/callback` (חובה - בשביל סקריפט החיבור של הבוט)
7. **CREATE**
8. 📋 **העתק את ה-Client ID וה-Client Secret** למקום בטוח

#### 3.5 צור API Key

1. **+ CREATE CREDENTIALS → API key**
2. תוצג חלונית עם המפתח - **העתק אותו**
3. (אופציונלי אבל מומלץ) לחץ **EDIT API KEY** → תחת **Application restrictions** בחר **HTTP referrers** → הוסף את ה-URL של GitHub Pages שלך

---

### שלב 4: הגדר את הבוט (מקומי)

1. פתח טרמינל בתיקיית הפרויקט (`botlinklicensing`)
2. עבור לתיקיית הבוט:
   ```bash
   cd bot
   ```
3. התקן תלויות:
   ```bash
   npm install
   ```
4. צור קובץ `.env` (העתק מ-`.env.example`):
   ```bash
   cp .env.example .env
   ```
5. ערוך את `.env` ומלא:
   ```env
   SUPABASE_URL=https://llvqhovssnjhxxexndbq.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<מהשלב 2>
   GOOGLE_CLIENT_ID=<מהשלב 3.4>
   GOOGLE_CLIENT_SECRET=<מהשלב 3.4>
   ```

---

### שלב 5: חבר את הבוט ל-Google Drive (חד-פעמי)

הרץ את סקריפט החיבור:

```bash
npm run setup-google
```

הסקריפט יציג URL. **פתח אותו בדפדפן**, היכנס לחשבון Google שלך (זה שיש בו את הקבצים), ואשר את ההרשאות.

לאחר ההצלחה, הסקריפט שומר את ה-Refresh Token בסופאבייס. הבוט יוכל מכאן והלאה להוריד קבצים מהדרייב.

---

### שלב 6: הגדר את הממשק (GitHub Pages)

1. ערוך את הקובץ `web/js/config.js`:
   ```js
   GOOGLE_CLIENT_ID: '<מהשלב 3.4>',
   GOOGLE_API_KEY: '<מהשלב 3.5>',
   ```

2. צור ריפו חדש ב-GitHub (פרטי או ציבורי):
   - היכנס ל-[github.com/new](https://github.com/new)
   - שם: `spike-bot` (או מה שתבחר)
   - **CREATE REPOSITORY**

3. בטרמינל בתיקיית הפרויקט:
   ```bash
   git init
   git add .
   git commit -m "Initial SPIKE setup"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/spike-bot.git
   git push -u origin main
   ```

4. הפעל GitHub Pages:
   - בריפו → **Settings → Pages**
   - **Source**: Deploy from a branch
   - **Branch**: `main` / `/web` folder
   - **SAVE**

5. תוך כמה דקות הממשק יהיה זמין ב:
   ```
   https://YOUR_USERNAME.github.io/spike-bot/
   ```

6. ⚠️ **חזור ל-Google Cloud → OAuth Client ID** והוסף את ה-URL הזה ל-**Authorized JavaScript origins**.

---

### שלב 7: הפעל את הבוט אוטומטית (PM2 + Windows)

הפעל את הבוט פעם אחת ידנית כדי לעשות QR scan:

```bash
cd bot
npm start
```

יוצג QR בטרמינל. **בטלפון** → WhatsApp → ⋮ Menu → **Linked Devices** → **Link a Device** → סרוק את ה-QR.

לאחר שהבוט מחובר וכותב `✅ Connected to WhatsApp!`, הפסק אותו (Ctrl+C).

עכשיו, התקן את הבוט כשירות שעולה אוטומטית עם המחשב:

1. פתח **PowerShell כמנהל** (Run as Administrator)
2. הפעל:
   ```powershell
   cd "C:\Users\elads\OneDrive\שולחן העבודה\botlinklicensing\bot"
   .\install-windows-service.ps1
   ```

🎉 הבוט עכשיו רץ ברקע 24/7 ויעלה אוטומטית בכל אתחול של המחשב.

---

## ✅ בדיקה ראשונית

1. **היכנס לממשק** - URL של GitHub Pages, התחבר עם האימייל והסיסמה משלב 1
2. **הגדרות** - וודא ש-Google Drive מסומן כ"מחובר"
3. **תפריטים** - צור תפריט ראשון:
   - לחץ "תפריט חדש" → סמן "תפריט ראשי"
   - שם: "תפריט ראשי"
   - הוסף לו פריטים (תת-תפריטים או קבצים)
4. **שלח הודעה לבוט** מהטלפון שלך:
   - הבוט יזהה אותך כמשתמש חדש
   - תקבל הודעה "הבקשה הועברה לאישור"
5. **חזור לממשק → משתמשים** - תראה את עצמך בטאב "ממתינים"
   - לחץ **👑 הפוך למנהל** - עכשיו אתה מנהל
6. **שלח שוב הודעה לבוט** - תקבל את התפריט הראשי 🎊

---

## 🔧 פקודות שימושיות

### בקרת הבוט (PM2)
```bash
pm2 status             # סטטוס
pm2 logs spike-bot     # צפייה בלוגים בזמן אמת
pm2 restart spike-bot  # הפעל מחדש
pm2 stop spike-bot     # עצור
pm2 start spike-bot    # הפעל
```

### עדכון הקוד
```bash
git pull                          # משוך שינויים
cd bot && npm install             # אם יש תלויות חדשות
pm2 restart spike-bot             # הפעל מחדש
```

### מחיקת הסשן של WhatsApp (חיבור מחדש עם QR)
```bash
pm2 stop spike-bot
rm -rf bot/auth
pm2 start spike-bot
pm2 logs spike-bot   # סרוק את ה-QR שיוצג
```

---

## 🐛 פתרון בעיות

| בעיה | פתרון |
|------|-------|
| הבוט לא מתחבר ל-WhatsApp | מחק את `bot/auth/` והפעל מחדש - תקבל QR חדש |
| "Google Drive not connected" | הרץ שוב `npm run setup-google` |
| Picker לא נפתח בממשק | ודא שהוספת את ה-GitHub Pages URL ל-Authorized JavaScript origins ב-Google Cloud |
| הממשק לא טוען | בדוק את הקונסולה (F12) - ודא ש-`config.js` מלא נכון |
| הודעות לא מגיעות | `pm2 logs spike-bot` - חפש שגיאות |
| Refresh token לא נשלח | במסך OAuth של Google - בטל הרשאה דרך https://myaccount.google.com/permissions והרץ שוב |

---

## 📁 מבנה הפרויקט

```
botlinklicensing/
├── bot/                       # קוד הבוט (Node.js + Baileys)
│   ├── src/
│   │   ├── index.js           # נקודת כניסה
│   │   ├── whatsapp.js        # חיבור ל-WhatsApp
│   │   ├── supabase.js        # לקוח Supabase
│   │   ├── googleDrive.js     # הורדת קבצים מהדרייב
│   │   ├── heartbeat.js       # סימן חיים לממשק
│   │   └── handlers/
│   │       ├── messageHandler.js   # ניתוב הודעות נכנסות
│   │       ├── menuHandler.js      # שליחת תפריטים וקבצים
│   │       ├── notifyAdmins.js     # התראות למנהלים
│   │       └── adminActions.js     # אישור/דחייה/קידום
│   ├── auth/                  # סשן WhatsApp (לא ב-git)
│   ├── .env                   # סודות (לא ב-git)
│   ├── ecosystem.config.cjs   # קונפיג PM2
│   ├── setup-google.js        # OAuth ראשוני
│   └── install-windows-service.ps1  # התקנה כשירות
└── web/                       # ממשק (סטטי - GitHub Pages)
    ├── index.html
    ├── css/style.css
    └── js/
        ├── main.js            # נקודת כניסה
        ├── config.js          # הגדרות
        ├── api.js             # קריאות לסופאבייס
        ├── ui.js              # רכיבי UI
        ├── router.js          # ראוטר
        ├── google.js          # Drive Picker
        └── pages/             # דפי הממשק
```

---

## 🔒 הערות אבטחה

- **`.env`** וכן **`bot/auth/`** **אסור** לעלות לגיט - הם ב-`.gitignore`.
- ה-Service Role Key נשאר רק במכונה שלך.
- ה-Anon Key (בממשק) חשוף בקוד - וזה בסדר, ה-RLS חוסם גישה למי שלא מחובר.
- כל אחד עם הסיסמה שלך לממשק - יכול לעשות הכל. **בחר סיסמה חזקה.**
- אם הקוד פתוח (פאבליק), השאר את `config.js` ללא Google Client ID/Key (מלא בלוקאל ב-`config.local.js`) או הגדר HTTP Referrer restrictions ב-Google Cloud.
