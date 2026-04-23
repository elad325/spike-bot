/**
 * Edge Function: google-oauth-init
 *
 * Entry point for the "change Google Drive account" flow. The dashboard
 * opens this URL in a popup; we generate an OAuth state token, set it on
 * a short-lived first-party cookie scoped to the functions path, and
 * 302-redirect the popup to Google's consent screen.
 *
 * The matching callback function reads the cookie back and validates that
 * Google's `state` parameter matches — that's our CSRF defense.
 *
 * Required Supabase secrets:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET   (only used by the callback, but kept together)
 *
 * Required Google Cloud Console authorized redirect URI:
 *   https://<project-ref>.supabase.co/functions/v1/google-oauth-callback
 */
// @ts-ignore — Deno std http import for Supabase Edge runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// State+returnUrl is small enough to live entirely in the cookie, so we
// don't need a database round-trip on either init or callback.
function encodeStateCookie(state: string, returnUrl: string): string {
  const json = JSON.stringify({ s: state, r: returnUrl });
  // base64url so it's cookie-safe without escaping
  return btoa(json).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function getCallbackUrl(): string {
  // Use the SUPABASE_URL env var (auto-injected by the Edge runtime) —
  // it's the canonical public project URL, unlike req.url/req.headers.host
  // which point at the internal edge-runtime host after the gateway
  // forwarded the request inward.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("SUPABASE_URL not injected");
  return `${supabaseUrl}/functions/v1/google-oauth-callback`;
}

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId) {
    return new Response("Missing GOOGLE_CLIENT_ID secret on the Edge Function", {
      status: 500,
    });
  }

  const url = new URL(req.url);
  const returnUrl = url.searchParams.get("return") ?? "";

  const state = crypto.randomUUID();
  const cookieValue = encodeStateCookie(state, returnUrl);
  const callbackUrl = getCallbackUrl();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  // prompt=consent forces Google to issue a fresh refresh_token even if
  // the user has authorized this client before — without it, repeat
  // connections silently leave us with no refresh token.
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("include_granted_scopes", "true");

  // SameSite=Lax allows the cookie to be sent on the top-level navigation
  // back from accounts.google.com to our callback. Path scoped to the
  // functions namespace so it doesn't leak into the rest of the project.
  const cookie = [
    `spike_oauth=${cookieValue}`,
    "Path=/functions/v1/",
    "Max-Age=600",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
});
