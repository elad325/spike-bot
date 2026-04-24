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

export function resultPage(args: ResultArgs): string {
  const payload = JSON.stringify({
    type: "spike:google-connected",
    ok: args.ok,
    email: args.email ?? null,
    message: args.message ?? null,
  });
  const safeReturn = (args.returnUrl ?? "").replace(/[<>"']/g, "");
  const colorOk = "#22c55e";
  const colorErr = "#ef4444";
  const closeDelay = args.ok ? 1500 : 4500;

  // Belt-and-suspenders charset declaration: <meta charset> covers the
  // modern path; <meta http-equiv> covers older parsers / view-source
  // fallbacks that helped Hebrew pages render as CP-1255 in the popup.
  return `<!DOCTYPE html>
<html lang="he" dir="rtl"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>SPIKE — ${args.ok ? "מחובר" : "שגיאה"}</title>
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
</style></head>
<body><div class="card">
  <div class="check">${args.ok ? "✅" : "❌"}</div>
  <h1>${args.ok ? "מחובר ל-Google Drive" : "החיבור נכשל"}</h1>
  ${
    args.ok
      ? `<p>החשבון המחובר:</p><div class="email">${args.email ?? ""}</div>
         <p class="hint">החלון הזה ייסגר אוטומטית.</p>`
      : `<p>${args.message ?? "שגיאה לא ידועה"}</p>
         <p class="hint">סגור את החלון ונסה שוב מהדשבורד.</p>`
  }
</div>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, '*');
      }
    } catch (e) {}
    setTimeout(function () {
      ${
        safeReturn
          ? `try { window.location.href = ${JSON.stringify(safeReturn)}; } catch (e) {}`
          : ""
      }
      try { window.close(); } catch (e) {}
    }, ${closeDelay});
  })();
</script>
</body></html>`;
}
