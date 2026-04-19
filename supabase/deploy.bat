@echo off
REM ============================================================
REM Deploy SPIKE's Google OAuth Edge Functions to Supabase.
REM ============================================================
REM Prerequisites (one-time):
REM   1. Install Supabase CLI:
REM        npm install -g supabase
REM   2. Sign in:
REM        supabase login
REM   3. Link this repo to your project (run from the supabase/ folder):
REM        supabase link --project-ref llvqhovssnjhxxexndbq
REM   4. Set the Google OAuth secrets (one-time, never committed):
REM        supabase secrets set GOOGLE_CLIENT_ID=...your_client_id...
REM        supabase secrets set GOOGLE_CLIENT_SECRET=...your_client_secret...
REM   5. In Google Cloud Console, add this redirect URI to your OAuth client:
REM        https://llvqhovssnjhxxexndbq.supabase.co/functions/v1/google-oauth-callback
REM
REM Then run this script any time the function code changes.
REM ============================================================
setlocal

cd /d "%~dp0"

echo.
echo === Deploying google-oauth-init ===
call supabase functions deploy google-oauth-init --no-verify-jwt
if errorlevel 1 goto :fail

echo.
echo === Deploying google-oauth-callback ===
call supabase functions deploy google-oauth-callback --no-verify-jwt
if errorlevel 1 goto :fail

echo.
echo Done. The "Change Account" button in the dashboard should work now.
exit /b 0

:fail
echo.
echo Deploy failed. See output above.
exit /b 1
