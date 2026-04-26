/**
 * The HTML page the OAuth popup lands on after the callback finishes
 * (whether successfully or not). It does two things:
 *   1. postMessage()s the result back to the opener (the dashboard) so it
 *      can update its UI without a page reload.
 *   2. Auto-closes itself shortly after, with a friendly success/error
 *      summary visible in the meantime in case the user is watching.
 *
 * Kept in _shared so the callback function and any future flows can reuse
 * the exact same UX.
 */
export interface ResultArgs {
  ok: boolean;
  email?: string | null;
  message?: string | null;
  /** Where to send the user if for some reason window.close() is blocked. */
  returnUrl?: string;
}

// Render every non-ASCII char as a numeric HTML entity. Used for text that
// goes into the HTML body — once the bytes are pure ASCII the browser/viewer
// can't possibly mis-decode them, regardless of which charset it picks.
function htmlEntities(s: string): string {
  // Escape HTML metacharacters too (<, >, &, ", ') so any user-controlled
  // string (e.g. the connected email) can't break out into HTML.
  return s.replace(/[<>"'&\u0080-\uffff]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Render every non-ASCII char as \uXXXX inside a JSON literal embedded in
// <script>. JSON.stringify writes literal UTF-8 chars by default; this
// post-processes them into \u escapes so the script source is also pure
// ASCII bytes (otherwise the Hebrew strings inside the postMessage payload
// would still be at the mercy of byte-level encoding).
function jsonAsciiSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export function resultPage(args: ResultArgs): string {
  const payload = jsonAsciiSafe({
    type: "spike:google-connected",
    ok: args.ok,
    email: args.email ?? null,
    message: args.message ?? null,
  });
  const colorOk = "#22c55e";
  const colorErr = "#ef4444";
  // Time to wait before attempting auto-close. Success closes fast; error
  // lingers so the user has time to read the failure message.
  const closeDelay = args.ok ? 1200 : 4500;

  // All user-visible Hebrew text is run through htmlEntities() so the bytes
  // of the response are pure ASCII. This sidesteps a stubborn issue where
  // the popup was being rendered as CP-1255 mojibake despite correct
  // Content-Type + <meta charset> + UTF-8 bytes — something between the
  // Edge runtime and the browser was guessing wrong, but plain ASCII gives
  // it nothing to guess.
  const title = args.ok ? "מחובר" : "שגיאה";
  const heading = args.ok ? "מחובר ל-Google Drive" : "החיבור נכשל";
  const buttonLabel = args.ok ? "סגור חלון" : "סגור";
  const okBody = `<p>${htmlEntities("החשבון המחובר:")}</p>` +
    `<div class="email">${htmlEntities(args.email ?? "")}</div>\n` +
    `         <p class="hint">${
      htmlEntities("הדשבורד עודכן. אם החלון לא נסגר אוטומטית, סגור אותו ידנית.")
    }</p>`;
  const errBody = `<p>${htmlEntities(args.message ?? "שגיאה לא ידועה")}</p>\n` +
    `         <p class="hint">${htmlEntities("סגור את החלון ונסה שוב מהדשבורד.")}</p>`;

  // <meta charset> + http-equiv kept as belt-and-suspenders even though the
  // body is now ASCII. Doesn't hurt and protects future edits that forget
  // to entity-encode.
  return `<!DOCTYPE html>
<html lang="he" dir="rtl"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>SPIKE ${htmlEntities("—")} ${htmlEntities(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1729; color: #e2e8f0;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 1rem; }
  .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem;
          text-align: center; max-width: 460px;
          box-shadow: 0 10px 40px rgba(0,0,0,.3); }
  h1 { color: ${args.ok ? colorOk : colorErr}; margin: .5rem 0 1rem; font-size: 1.4rem; }
  .check { font-size: 3rem; margin-bottom: .5rem; }
  p { color: #94a3b8; line-height: 1.6; margin: .5rem 0; }
  .email { background: #0f1729; padding: .5rem .85rem; border-radius: .5rem;
           font-family: monospace; color: #e2e8f0; margin-top: .5rem; display: inline-block;
           direction: ltr; }
  .hint { font-size: .85rem; color: #64748b; margin-top: 1.5rem; }
  .close-btn { margin-top: 1.25rem; padding: .65rem 1.75rem; background: #334155;
               color: #e2e8f0; border: 0; border-radius: .5rem; font-size: .95rem;
               cursor: pointer; font-family: inherit; }
  .close-btn:hover { background: #475569; }
</style></head>
<body><div class="card">
  <div class="check">${args.ok ? "&#x2705;" : "&#x274c;"}</div>
  <h1>${htmlEntities(heading)}</h1>
  ${args.ok ? okBody : errBody}
  <button class="close-btn" id="closeBtn" type="button">${htmlEntities(buttonLabel)}</button>
</div>
<script>
  // postMessage the opener (dashboard) so it refreshes its UI immediately,
  // then schedule auto-close. We do NOT fall back to navigating to the
  // dashboard URL: that just loads the whole dashboard inside the tiny
  // popup window and looks broken. Instead the manual close button below
  // is the fallback. (Deliberately ASCII-only here so any source-view
  // tool the user opens shows clean text, not encoding mojibake.)
  (function () {
    var payload = ${payload};
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, '*');
      }
    } catch (e) {}

    var btn = document.getElementById('closeBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        try { window.close(); } catch (e) {}
      });
    }

    // Auto-close attempt. May silently no-op on browsers that block
    // window.close() after cross-origin navigations (the OAuth flow goes
    // through accounts.google.com). The manual button above is the
    // fallback in that case.
    setTimeout(function () {
      try { window.close(); } catch (e) {}
    }, ${closeDelay});
  })();
</script>
</body></html>`;
}
