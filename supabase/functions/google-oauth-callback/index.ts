/**
 * Edge Function: google-oauth-callback
 *
 * Google redirects the user's browser here after they consent. We:
 *   1. Validate the OAuth state against the cookie set by google-oauth-init
 *      (CSRF defense).
 *   2. Exchange the authorization code for refresh + access tokens.
 *   3. Look up the connected user's email (so we can show "Connected as
 *      foo@bar.com" in the dashboard).
 *   4. Persist all of it to app_settings using the service role key.
 *   5. Return an HTML page that postMessages the result back to the
 *      dashboard popup-opener and self-closes.
 *
 * Required Supabase secrets:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-provided by the
 * Edge runtime — we do not set them ourselves.)
 */
// @ts-ignore — Deno std http import
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore — esm.sh CDN import for Supabase JS client
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { resultPage } from "../_shared/result-page.ts";

interface CookieState {
  s: string; // state
  r: string; // returnUrl
}

function decodeStateCookie(value: string): CookieState | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const obj = JSON.parse(json);
    if (typeof obj?.s === "string") return obj;
    return null;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Always invalidate the state cookie after callback regardless of
      // outcome, so a stale cookie can't be reused.
      "Set-Cookie": "spike_oauth=; Path=/functions/v1/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store",
    },
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function exchangeCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return await resp.json();
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return typeof data?.email === "string" ? data.email : null;
}

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // Validate cookie state first — even if Google sends ?error=, we still
  // want to read the cookie so the user is returned to the right place.
  const cookieRaw = readCookie(req, "spike_oauth");
  const cookieState = cookieRaw ? decodeStateCookie(cookieRaw) : null;
  const returnUrl = cookieState?.r ?? "";

  if (errorParam) {
    return html(
      resultPage({
        ok: false,
        message: `Google דחה את ההרשאה: ${errorParam}`,
        returnUrl,
      }),
      400,
    );
  }

  if (!cookieState) {
    return html(
      resultPage({
        ok: false,
        message: "חסר/פג תוקף state cookie. נסה שוב מהדשבורד.",
        returnUrl,
      }),
      400,
    );
  }

  if (!code || !stateParam || stateParam !== cookieState.s) {
    return html(
      resultPage({
        ok: false,
        message: "בקשה לא תקפה (state mismatch).",
        returnUrl,
      }),
      400,
    );
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return html(
      resultPage({
        ok: false,
        message: "חסר GOOGLE_CLIENT_ID/SECRET ב-Supabase secrets",
        returnUrl,
      }),
      500,
    );
  }

  const redirectUri = `${url.origin}/functions/v1/google-oauth-callback`;

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });
  } catch (err) {
    return html(
      resultPage({
        ok: false,
        message: `שגיאה בהחלפת קוד: ${(err as Error).message}`,
        returnUrl,
      }),
      500,
    );
  }

  if (tokens.error || !tokens.access_token) {
    return html(
      resultPage({
        ok: false,
        message:
          tokens.error_description ??
          tokens.error ??
          "לא קיבלנו access_token מגוגל",
        returnUrl,
      }),
      400,
    );
  }

  if (!tokens.refresh_token) {
    return html(
      resultPage({
        ok: false,
        message:
          "גוגל לא החזיר refresh_token. בטל הרשאה קיימת ב-https://myaccount.google.com/permissions ונסה שוב.",
        returnUrl,
      }),
      400,
    );
  }

  // Look up the connected account's email (best-effort — if it fails we
  // still save the tokens; the dashboard just won't display the address).
  const email = await fetchEmail(tokens.access_token);

  // Persist with the service role so RLS doesn't get in our way.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: settings, error: selErr } = await supabase
    .from("app_settings")
    .select("id")
    .limit(1)
    .single();

  if (selErr || !settings) {
    return html(
      resultPage({
        ok: false,
        message: `app_settings לא נמצאה: ${selErr?.message ?? "אין שורה"}`,
        returnUrl,
      }),
      500,
    );
  }

  const expiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: updErr } = await supabase
    .from("app_settings")
    .update({
      google_refresh_token: tokens.refresh_token,
      google_access_token: tokens.access_token,
      google_token_expiry: expiry,
      google_email: email,
    })
    .eq("id", settings.id);

  if (updErr) {
    return html(
      resultPage({
        ok: false,
        message: `שמירה ל-Supabase נכשלה: ${updErr.message}`,
        returnUrl,
      }),
      500,
    );
  }

  return html(resultPage({ ok: true, email, returnUrl }));
});
