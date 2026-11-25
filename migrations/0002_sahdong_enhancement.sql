
-- ==========================================
-- SAHDONG DATABASE
-- Migration 0002 - Enhancement
-- ==========================================

-- 1. TAMBAHAN DATA UNDANGAN
ALTER TABLE invitations
ADD COLUMN activation_date TEXT;

ALTER TABLE invitations
ADD COLUMN published_at TEXT;

ALTER TABLE invitations
ADD COLUMN expires_at TEXT;

-- 2. ALUR PEMERIKSAAN ADMIN
ALTER TABLE invitations
ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft'
CHECK (
    review_status IN (
        'draft',
        'submitted',
        'revision',
        'approved',
        'rejected'
    )
);

ALTER TABLE invitations
ADD COLUMN reviewed_at TEXT;

ALTER TABLE invitations
ADD COLUMN reviewed_by TEXT;

ALTER TABLE invitations
ADD COLUMN admin_note TEXT;

-- 3. INDEX UNTUK PUBLIKASI TERJADWAL
CREATE INDEX IF NOT EXISTS idx_invitations_activation
ON invitations(activation_date);

CREATE INDEX IF NOT EXISTS idx_invitations_expiration
ON invitations(expires_at);

CREATE INDEX IF NOT EXISTS idx_invitations_review
ON invitations(review_status);

-- 4. BUKU TAMU UNDANGAN
CREATE TABLE IF NOT EXISTS guestbook (
    id TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL,
    guest_name TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'approved',
                'rejected'
            )
        ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invitation_id)
        REFERENCES invitations(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_guestbook_invitation
ON guestbook(invitation_id);

CREATE INDEX IF NOT EXISTS idx_guestbook_status
ON guestbook(status);
