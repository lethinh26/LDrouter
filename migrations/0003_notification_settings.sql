ALTER TABLE app_settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_settings ADD COLUMN notification_sound_enabled INTEGER NOT NULL DEFAULT 1;