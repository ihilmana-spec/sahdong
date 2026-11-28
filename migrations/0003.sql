-- ==========================================
-- SAHDONG DATABASE
-- Migration 0003 - RSVP di Guestbook
-- ==========================================
-- Tujuan: RSVP (kehadiran + jumlah tamu) gabung jadi satu
-- dengan guestbook yang sudah ada di 0002.
-- Tidak bikin tabel baru, tidak menghapus data lama.

-- 1. KOLOM KEHADIRAN
-- Hadir / Tidak Hadir / Ragu-ragu
-- Data lama otomatis keisi 'Hadir' karena DEFAULT.
ALTER TABLE guestbook
ADD COLUMN attendance TEXT NOT NULL DEFAULT 'Hadir'
CHECK (
    attendance IN (
        'Hadir',
        'Tidak Hadir',
        'Ragu-ragu'
    )
);

-- 2. KOLOM JUMLAH TAMU
-- Kalau Hadir, minimal 1. Kalau Tidak Hadir, 0.
-- Data lama otomatis keisi 1 karena DEFAULT.
ALTER TABLE guestbook
ADD COLUMN guest_count INTEGER NOT NULL DEFAULT 1
CHECK (guest_count >= 0);

-- 3. INDEX BUAT API TAMU + PEMILIK
-- Tamu: ambil ucapan per undangan yang sudah approved
-- Pemilik: ambil semua RSVP per undangan
CREATE INDEX IF NOT EXISTS idx_guestbook_invitation_status
ON guestbook(invitation_id, status);

CREATE INDEX IF NOT EXISTS idx_guestbook_invitation_created
ON guestbook(invitation_id, created_at);
