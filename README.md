# SPIKE - WhatsApp Bot with Admin Dashboard

WhatsApp bot that serves PDF files from Google Drive through a hierarchical menu system. Includes a web dashboard for managing menus, users, and viewing message history.

## Architecture

```
GitHub Pages (Web Dashboard) ──┐
                                ├──► Supabase (DB + Auth + Realtime)
Local PC (Bot - PM2 24/7) ─────┘            │
                                             ▼
                                       Google Drive
```

- **Web Dashboard**: Static site on GitHub Pages — manage menus, users, view history
- **Bot**: Node.js + Baileys, runs locally 24/7 via PM2, auto-starts on Windows boot
- **Database**: Supabase (PostgreSQL + Realtime + Auth)
- **Files**: PDFs stored in your Google Drive, sent directly to WhatsApp users

## See `SETUP.md` for installation instructions.

## Project Structure

- `bot/` — Node.js Baileys bot
- `web/` — Static frontend (deployed to GitHub Pages)
