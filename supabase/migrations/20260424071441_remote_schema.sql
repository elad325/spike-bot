-- =============================================================================
-- Baseline schema for SPIKE bot.
--
-- This file captures the current production state on 2026-04-24.
-- Until now the schema lived only inside the hosted Supabase project; this is
-- the first checked-in version. Future schema changes go in NEW migration
-- files alongside this one — never edit this file in place.
--
-- Re-applying on a fresh database recreates: enums, tables, indexes, RLS
-- policies, the updated_at trigger function, and per-table updated_at
-- triggers. Supabase-managed extensions (pg_graphql, pg_cron, pgsodium,
-- supabase_vault, pg_stat_statements, plpgsql) are intentionally not touched
-- here — Supabase provisions them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions actually used by our schema
-- ---------------------------------------------------------------------------
-- gen_random_uuid() lives in pgcrypto.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'menu_item_type') THEN
    CREATE TYPE public.menu_item_type AS ENUM ('submenu', 'file');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_direction') THEN
    CREATE TYPE public.message_direction AS ENUM ('incoming', 'outgoing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE public.user_role AS ENUM ('user', 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE public.user_status AS ENUM ('pending', 'approved', 'denied');
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Shared trigger function: bump updated_at on every UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Tables
-- Order matters: menus must exist before menu_items / whatsapp_users (FKs);
-- whatsapp_users must exist before messages (FK).
-- ---------------------------------------------------------------------------

-- Menus (tree of menus; exactly one is the root, enforced by partial unique idx).
CREATE TABLE IF NOT EXISTS public.menus (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    is_root    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Items inside a menu — either a submenu link (target_menu_id) or a file
-- (drive_file_id). chk_item_type ensures exactly one is set.
CREATE TABLE IF NOT EXISTS public.menu_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_id            uuid NOT NULL REFERENCES public.menus(id) ON DELETE CASCADE,
    label              text NOT NULL,
    type               public.menu_item_type NOT NULL,
    target_menu_id     uuid REFERENCES public.menus(id) ON DELETE SET NULL,
    drive_file_id      text,
    drive_file_name    text,
    drive_file_missing boolean NOT NULL DEFAULT false,
    display_order      integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_item_type CHECK (
        ((type = 'submenu'::public.menu_item_type) AND (target_menu_id IS NOT NULL) AND (drive_file_id IS NULL))
        OR
        ((type = 'file'::public.menu_item_type)    AND (drive_file_id IS NOT NULL)  AND (target_menu_id IS NULL))
    )
);

-- WhatsApp users known to the bot (auto-created on first message).
-- jid is nullable because legacy rows pre-date Baileys 7's LID exposure.
-- pending_action holds transient admin/user wizard state (see column comment).
CREATE TABLE IF NOT EXISTS public.whatsapp_users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number      text NOT NULL UNIQUE,
    whatsapp_name     text,
    role              public.user_role   NOT NULL DEFAULT 'user',
    status            public.user_status NOT NULL DEFAULT 'pending',
    last_message_at   timestamptz,
    last_menu_sent_at timestamptz,
    current_menu_id   uuid REFERENCES public.menus(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    jid               text,
    pending_action    jsonb
);

COMMENT ON COLUMN public.whatsapp_users.pending_action IS
  'Transient admin/user state. Shape: {"scope":"admin_menu","step":"...","data":{...}}. NULL = no pending action.';

-- Inbound + outbound message log. user_id is nullable so we can log messages
-- from people who don't yet have a row in whatsapp_users.
CREATE TABLE IF NOT EXISTS public.messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid REFERENCES public.whatsapp_users(id) ON DELETE SET NULL,
    phone_number   text NOT NULL,
    whatsapp_name  text,
    direction      public.message_direction NOT NULL,
    message_type   text NOT NULL DEFAULT 'text',
    body           text,
    media_metadata jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Single-row global config table (id is uuid for consistency).
CREATE TABLE IF NOT EXISTS public.app_settings (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    google_refresh_token       text,
    google_access_token        text,
    google_token_expiry        timestamptz,
    google_email               text,
    bot_name                   text NOT NULL DEFAULT 'SPIKE',
    inactivity_timeout_minutes integer NOT NULL DEFAULT 60,
    welcome_message            text NOT NULL DEFAULT 'ברוכים הבאים! 👋',
    pending_message            text NOT NULL DEFAULT 'הבקשה שלך הועברה למנהל לאישור. נחזור אליך בהקדם 🙏',
    denied_message             text NOT NULL DEFAULT 'אין לך הרשאה להשתמש בבוט.',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    bot_last_seen_at           timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes (non-PK, non-UNIQUE-constraint)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_menu_items_menu_id
    ON public.menu_items USING btree (menu_id, display_order);

CREATE INDEX IF NOT EXISTS idx_menu_items_target
    ON public.menu_items USING btree (target_menu_id);

-- Enforce: at most one root menu.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menus_only_one_root
    ON public.menus USING btree (is_root)
    WHERE (is_root = true);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON public.messages USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_phone
    ON public.messages USING btree (phone_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_user_id
    ON public.messages USING btree (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_users_last_message
    ON public.whatsapp_users USING btree (last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_users_phone
    ON public.whatsapp_users USING btree (phone_number);

CREATE INDEX IF NOT EXISTS idx_whatsapp_users_role
    ON public.whatsapp_users USING btree (role);

CREATE INDEX IF NOT EXISTS idx_whatsapp_users_status
    ON public.whatsapp_users USING btree (status);

-- ---------------------------------------------------------------------------
-- updated_at triggers (one per table that has the column)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_menus_updated_at          ON public.menus;
DROP TRIGGER IF EXISTS trg_menu_items_updated_at     ON public.menu_items;
DROP TRIGGER IF EXISTS trg_whatsapp_users_updated_at ON public.whatsapp_users;
DROP TRIGGER IF EXISTS trg_app_settings_updated_at   ON public.app_settings;

CREATE TRIGGER trg_menus_updated_at
    BEFORE UPDATE ON public.menus
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_menu_items_updated_at
    BEFORE UPDATE ON public.menu_items
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_whatsapp_users_updated_at
    BEFORE UPDATE ON public.whatsapp_users
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_app_settings_updated_at
    BEFORE UPDATE ON public.app_settings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS — enable on every table.
-- The bot itself uses the service_role key which bypasses RLS entirely.
-- The dashboard runs as `authenticated` (Google SSO) and is allowed full
-- access to everything; finer-grained per-row rules can be layered later.
-- ---------------------------------------------------------------------------
ALTER TABLE public.menus          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all_menus          ON public.menus;
DROP POLICY IF EXISTS admin_all_menu_items     ON public.menu_items;
DROP POLICY IF EXISTS admin_all_whatsapp_users ON public.whatsapp_users;
DROP POLICY IF EXISTS admin_all_messages       ON public.messages;
DROP POLICY IF EXISTS admin_all_app_settings   ON public.app_settings;

CREATE POLICY admin_all_menus
    ON public.menus
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY admin_all_menu_items
    ON public.menu_items
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY admin_all_whatsapp_users
    ON public.whatsapp_users
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY admin_all_messages
    ON public.messages
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY admin_all_app_settings
    ON public.app_settings
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
