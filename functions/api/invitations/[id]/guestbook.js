// ======================================
// SAHDONG - OWNER GUESTBOOK / RSVP
// ======================================
// GET    /api/invitations/[id]/guestbook -> pemilik lihat semua RSVP undangannya
// PUT    /api/invitations/[id]/guestbook -> pemilik ubah status (approved / rejected)
// DELETE /api/invitations/[id]/guestbook -> pemilik hapus 1 ucapan
//
// Hanya pemilik undangan yang bisa akses (login customer + user_id cocok).
// Tamu TIDAK lewat sini, tamu lewat /api/public-guestbook?slug=...

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function authenticate(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)sahdong_session=([^;]+)/);
  if (!match) return { error: "Belum login.", status: 401 };

  const tokenHash = await hashToken(match[1]);
  const now = Math.floor(Date.now() / 1000);

  const session = await env.DB.prepare(`
    SELECT users.id, users.role, users.status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  if (!session || session.status !== "active") {
    return { error: "Sesi tidak valid.", status: 401 };
  }
  if (session.role !== "customer") {
    return { error: "Akses hanya untuk pelanggan.", status: 403 };
  }
  return { user: session };
}

async function getOwnedInvitation(env, invitationId, userId) {
  return env.DB.prepare(`
    SELECT id, user_id, title, slug, status, review_status
    FROM invitations
    WHERE id = ?
      AND user_id = ?
    LIMIT 1
  `).bind(invitationId, userId).first();
}

async function ensureGuestbookColumns(env) {
  try {
    await env.DB.prepare(
      `ALTER TABLE guestbook ADD COLUMN attendance TEXT NOT NULL DEFAULT 'Hadir' CHECK (attendance IN ('Hadir','Tidak Hadir','Ragu-ragu'))`
    ).run();
  } catch {}
  try {
    await env.DB.prepare(
      `ALTER TABLE guestbook ADD COLUMN guest_count INTEGER NOT NULL DEFAULT 1 CHECK (guest_count >= 0)`
    ).run();
  } catch {}
}

// GET: semua RSVP per undangan (termasuk pending + rejected, biar pemilik bisa moderasi)
export async function onRequestGet({ request, env, params }) {
  try {
    if (!env.DB) return json({ success: false, message: "Database tidak tersedia." }, 500);

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    await ensureGuestbookColumns(env);

    const result = await env.DB.prepare(`
      SELECT id, guest_name, message, attendance, guest_count, status, created_at
      FROM guestbook
      WHERE invitation_id = ?
      ORDER BY created_at DESC
      LIMIT 200
    `).bind(invitation.id).all();

    const entries = result.results || [];

    let hadir = 0, tidakHadir = 0, ragu = 0, totalTamuHadir = 0, pending = 0;
    for (const e of entries) {
      if (e.status === "pending") pending++;
      if (e.status !== "approved") continue;
      if (e.attendance === "Hadir") {
        hadir++;
        totalTamuHadir += Number(e.guest_count || 0);
      } else if (e.attendance === "Tidak Hadir") {
        tidakHadir++;
      } else if (e.attendance === "Ragu-ragu") {
        ragu++;
      }
    }

    return json({
      success: true,
      invitation: {
        id: invitation.id,
        title: invitation.title,
        slug: invitation.slug,
        status: invitation.status
      },
      guestbook: entries,
      summary: {
        total: entries.length,
        pending,
        hadir,
        tidak_hadir: tidakHadir,
        ragu,
        total_tamu_hadir: totalTamuHadir
      }
    });
  } catch (error) {
    console.error("OWNER GUESTBOOK GET ERROR:", error);
    return json({ success: false, message: "Gagal mengambil daftar RSVP." }, 500);
  }
}

// PUT: ubah status 1 ucapan -> { id, status: "approved" | "rejected" }
export async function onRequestPut({ request, env, params }) {
  try {
    if (!env.DB) return json({ success: false, message: "Database tidak tersedia." }, 500);

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: "Format JSON tidak valid." }, 400);
    }

    const entryId = String(body.id || "");
    const status = String(body.status || "");
    if (!entryId) return json({ success: false, message: "ID ucapan wajib diisi." }, 400);
    if (!["approved", "rejected", "pending"].includes(status)) {
      return json({ success: false, message: "Status tidak valid." }, 400);
    }

    const result = await env.DB.prepare(`
      UPDATE guestbook SET status = ?
      WHERE id = ? AND invitation_id = ?
    `).bind(status, entryId, invitation.id).run();

    if (!result.meta || result.meta.changes !== 1) {
      return json({ success: false, message: "Ucapan tidak ditemukan." }, 404);
    }

    return json({ success: true, message: "Status ucapan berhasil diubah." });
  } catch (error) {
    console.error("OWNER GUESTBOOK PUT ERROR:", error);
    return json({ success: false, message: "Gagal mengubah status ucapan." }, 500);
  }
}

// DELETE: hapus 1 ucapan -> { id }
export async function onRequestDelete({ request, env, params }) {
  try {
    if (!env.DB) return json({ success: false, message: "Database tidak tersedia." }, 500);

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: "Format JSON tidak valid." }, 400);
    }

    const entryId = String(body.id || "");
    if (!entryId) return json({ success: false, message: "ID ucapan wajib diisi." }, 400);

    const result = await env.DB.prepare(`
      DELETE FROM guestbook
      WHERE id = ? AND invitation_id = ?
    `).bind(entryId, invitation.id).run();

    if (!result.meta || result.meta.changes !== 1) {
      return json({ success: false, message: "Ucapan tidak ditemukan." }, 404);
    }

    return json({ success: true, message: "Ucapan berhasil dihapus." });
  } catch (error) {
    console.error("OWNER GUESTBOOK DELETE ERROR:", error);
    return json({ success: false, message: "Gagal menghapus ucapan." }, 500);
  }
}
