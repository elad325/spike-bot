-- =============================================================================
-- Telegram support: add a parallel channel alongside the existing WhatsApp bot.
--
-- Design: Telegram users live in their own table (telegram_users) that mirrors
-- the structure of whatsapp_users. Both can be cross-linked through bot_links
-- so that a single human (e.g. an admin) is recognised on both platforms and
-- approval/role changes propagate.
--
-- The existing whatsapp_users table is unchanged; everything Telegram-specific
-- is additive so the migration is safe to apply on a live system.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Telegram users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Telegram numeric user id (stable across renames/handle changes)
    telegram_user_id  bigint NOT NULL UNIQUE,
    -- chat_id is what we send to. For 1:1 chats it equals telegram_user_id;
    -- kept separately because future group support uses a different id here.
    chat_id           bigint NOT NULL,
    username          text,
    first_name        text,
    last_name         text,
    role              public.user_role   NOT NULL DEFAULT 'user',
    status            public.user_status NOT NULL DEFAULT 'pending',
    last_message_at   timestamptz,
    last_menu_sent_at timestamptz,
    current_menu_id   uuid REFERENCES public.menus(id) ON DELETE SET NULL,
    -- Same wizard-state shape as whatsapp_users.pending_action.
    pending_action    jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.telegram_users.pending_action IS
  'Transient admin/user state. Same shape as whatsapp_users.pending_action.';

CREATE INDEX IF NOT EXISTS idx_telegram_users_status
    ON public.telegram_users (status);
CREATE INDEX IF NOT EXISTS idx_telegram_users_role
    ON public.telegram_users (role);
CREATE INDEX IF NOT EXISTS idx_telegram_users_last_message
    ON public.telegram_users (last_message_at DESC);

DROP TRIGGER IF EXISTS trg_telegram_users_updated_at ON public.telegram_users;
CREATE TRIGGER trg_telegram_users_updated_at
    BEFORE UPDATE ON public.telegram_users
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.telegram_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all_telegram_users ON public.telegram_users;
CREATE POLICY admin_all_telegram_users
    ON public.telegram_users
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Cross-platform identity linking
--
-- A row here means "this WhatsApp user and this Telegram user are the same
-- human". Linking is symmetric, so we enforce uniqueness on each side: a
-- given WhatsApp user can be linked to at most one Telegram user, and vice
-- versa. (That's the sane default for an admin who owns both accounts. If
-- we ever need many-to-many, drop the unique constraints — nothing else
-- depends on the cardinality.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_links (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_user_id  uuid NOT NULL UNIQUE
                          REFERENCES public.whatsapp_users(id) ON DELETE CASCADE,
    telegram_user_id  uuid NOT NULL UNIQUE
                          REFERENCES public.telegram_users(id) ON DELETE CASCADE,
    created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all_bot_links ON public.bot_links;
CREATE POLICY admin_all_bot_links
    ON public.bot_links
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- One-shot link tokens
--
-- Issued by one platform, redeemed on the other inside a short window.
-- Holds enough state (source platform + source user id) to perform the link
-- without any DB-level "who issued this" lookup beyond the token itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_link_tokens (
    token              text PRIMARY KEY,
    source_platform    text NOT NULL CHECK (source_platform IN ('whatsapp', 'telegram')),
    source_user_id     uuid NOT NULL,                -- whatsapp_users.id or telegram_users.id
    expires_at         timestamptz NOT NULL,
    consumed_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_link_tokens_expires
    ON public.bot_link_tokens (expires_at);

ALTER TABLE public.bot_link_tokens ENABLE ROW LEVEL SECURITY;
-- Service role only — dashboard never touches these directly.
DROP POLICY IF EXISTS admin_all_bot_link_tokens ON public.bot_link_tokens;
CREATE POLICY admin_all_bot_link_tokens
    ON public.bot_link_tokens
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Telegram media cache
--
-- Telegram returns a `file_id` after the first upload of any document. That
-- id can be reused forever to send the same content without re-uploading,
-- so we cache it keyed by the original Drive file id. When the dashboard
-- replaces a Drive file (drive_file_id changes), the cache row simply isn't
-- found on the next send and we upload again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_file_cache (
    drive_file_id    text PRIMARY KEY,
    telegram_file_id text NOT NULL,
    file_name        text,
    cached_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.telegram_file_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all_telegram_file_cache ON public.telegram_file_cache;
CREATE POLICY admin_all_telegram_file_cache
    ON public.telegram_file_cache
    AS PERMISSIVE FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Messages: extend to log Telegram traffic alongside WhatsApp.
--
-- We keep the existing `phone_number` column non-nullable for WhatsApp rows
-- (preserves all existing data and queries) and add a parallel
-- `telegram_user_id`. New Telegram rows set platform='telegram' and leave
-- phone_number as a synthetic placeholder ('telegram:<id>') so the legacy
-- NOT NULL constraint and the dashboard's existing queries keep working
-- without a wider rewrite.
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'whatsapp'
        CHECK (platform IN ('whatsapp', 'telegram'));

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS telegram_user_id bigint;

CREATE INDEX IF NOT EXISTS idx_messages_platform
    ON public.messages (platform, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_telegram_user
    ON public.messages (telegram_user_id, created_at DESC)
    WHERE telegram_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Trigger: mirror status/role changes across linked accounts.
--
-- When a WhatsApp user's status or role changes, find their linked Telegram
-- counterpart (if any) and apply the same change there — and vice versa.
--
-- This lives at the DB layer so every writer (bot, dashboard, ad-hoc SQL)
-- gets propagation for free without each having to remember to do it.
--
-- Loop avoidance: pg_trigger_depth() lets us detect we're already running
-- inside a triggered update (mirror coming back the other way), and bail
-- without doing the mirror a second time. We additionally compare current
-- vs target values so a no-op update doesn't fire pointlessly.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mirror_user_status_role()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    counterpart_table text;
    counterpart_id    uuid;
    counterpart_role  public.user_role;
    counterpart_stat  public.user_status;
BEGIN
    -- Only fire on actual status/role changes.
    IF (NEW.status IS NOT DISTINCT FROM OLD.status)
       AND (NEW.role IS NOT DISTINCT FROM OLD.role) THEN
        RETURN NEW;
    END IF;

    -- Don't recurse: if we're already inside a mirror update, the other
    -- side has already been touched (or is being touched right now).
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    -- Find the counterpart via bot_links.
    IF TG_TABLE_NAME = 'whatsapp_users' THEN
        counterpart_table := 'telegram_users';
        SELECT bl.telegram_user_id INTO counterpart_id
            FROM public.bot_links bl
            WHERE bl.whatsapp_user_id = NEW.id;
    ELSE
        counterpart_table := 'whatsapp_users';
        SELECT bl.whatsapp_user_id INTO counterpart_id
            FROM public.bot_links bl
            WHERE bl.telegram_user_id = NEW.id;
    END IF;

    IF counterpart_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Pull the counterpart's current values so we can skip if they already
    -- match (otherwise we'd dispatch a no-op UPDATE every time).
    EXECUTE format(
        'SELECT role, status FROM public.%I WHERE id = $1',
        counterpart_table
    )
    INTO counterpart_role, counterpart_stat
    USING counterpart_id;

    IF counterpart_role IS NOT DISTINCT FROM NEW.role
       AND counterpart_stat IS NOT DISTINCT FROM NEW.status THEN
        RETURN NEW;
    END IF;

    EXECUTE format(
        'UPDATE public.%I SET role = $1, status = $2 WHERE id = $3',
        counterpart_table
    )
    USING NEW.role, NEW.status, counterpart_id;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_whatsapp_users_mirror ON public.whatsapp_users;
CREATE TRIGGER trg_whatsapp_users_mirror
    AFTER UPDATE OF status, role ON public.whatsapp_users
    FOR EACH ROW EXECUTE FUNCTION public.mirror_user_status_role();

DROP TRIGGER IF EXISTS trg_telegram_users_mirror ON public.telegram_users;
CREATE TRIGGER trg_telegram_users_mirror
    AFTER UPDATE OF status, role ON public.telegram_users
    FOR EACH ROW EXECUTE FUNCTION public.mirror_user_status_role();
