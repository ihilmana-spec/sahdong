-- ==========================================
-- SAHDONG DATABASE
-- Migration 0004 - Index buat auto-hapus expired
-- ==========================================
-- Tidak mengubah tabel, tidak menghapus data.
-- Cuma nambah index biar worker tiap hari tidak scan full table.

CREATE INDEX IF NOT EXISTS idx_invitations_expires_status
ON invitations(expires_at, status);
