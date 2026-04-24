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
  return s.replace(/[\u0080-\uffff]/g, (c) => `&#${c.charCodeAt(0)};`);
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
  const safeReturn = (args.returnUrl ?? "").replace(/[<>"']/g, "");
  const colorOk = "#22c55e";
  const colorErr = "#ef4444";
  const closeDelay = args.ok ? 1500 : 4500;

  // All user-visible Hebrew text is run through htmlEntities() so the bytes
  // of the response are pure ASCII. This sidesteps a stubborn issue where
  // the popup was being rendered as CP-1255 mojibake despite correct
  // Content-Type + <meta charset> + UTF-8 bytes — something between the
  // Edge runtime and the browser was guessing wrong, but plain ASCII gives
  // it nothing to guess.
  const title = args.ok ? "מחובר" : "שגיאה";
  const heading = args.ok ? "מחובר ל-Google Drive" : "החיבור נכשל";
  const okBody = `<p>${htmlEntities("החשבון המחובר:")}</p>` +
    `<div class="email">${htmlEntities(args.email ?? "")}</div>\n` +
    `         <p class="hint">${htmlEntities("החלון הזה ייסגר אוטומטית.")}</p>`;
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
</style></head>
<body><div class="card">
  <div class="check">${args.ok ? "&#x2705;" : "&#x274c;"}</div>
  <h1>${htmlEntities(heading)}</h1>
  ${args.ok ? okBody : errBody}
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
