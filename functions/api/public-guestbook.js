// ======================================
// SAHDONG - PUBLIC GUESTBOOK / RSVP (TAMU)
// ======================================
// GET  /api/public-guestbook?slug=... -> lihat ucapan yang sudah approved
// POST /api/public-guestbook?slug=... -> tamu kirim RSVP + ucapan
//
// Cek undangan SAMA PERSIS kayak public-invitation.js:
// published + published_at + activation_date + expires_at tidak NULL
// + order paid + payment paid + sudah aktivasi + belum kedaluwarsa (WIB)

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getJakartaDateTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

// Jaga-jaga kalau migrasi 0003 belum ke-apply di DB lama:
// coba tambah kolom, kalau sudah ada diabaikan.
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

// Ambil undangan yang boleh dibuka tamu. Return null + response error kalau tidak lolos.
async function getPublicInvitation(env, slug) {
  const invitation = await env.DB.prepare(`
    SELECT
      i.id,
      i.slug,
      i.activation_date,
      i.expires_at,
      i.status AS invitation_status,
      o.status AS order_status,
      p.status AS payment_status
    FROM invitations i
    INNER JOIN orders o
      ON o.invitation_id = i.id
     AND o.user_id = i.user_id
    INNER JOIN payments p
      ON p.order_id = o.id
    WHERE i.slug = ?
      AND i.status = 'published'
      AND i.published_at IS NOT NULL
      AND i.activation_date IS NOT NULL
      AND i.expires_at IS NOT NULL
      AND o.status = 'paid'
      AND p.status = 'paid'
    ORDER BY p.created_at DESC
    LIMIT 1
  `).bind(slug).first();

  if (!invitation) {
    return {
      error: jsonResponse({
        success: false,
        message: "Undangan tidak ditemukan, belum diterbitkan, atau pembayaran belum lunas."
      }, 404)
    };
  }

  const today = getJakartaDateTime().slice(0, 10);
  const activationDate = String(invitation.activation_date).slice(0, 10);
  if (activationDate > today) {
    return {
      error: jsonResponse({
        success: false,
        message: "Undangan belum memasuki tanggal aktivasi.",
        activation_date: activationDate
      }, 403)
    };
  }

  const now = getJakartaDateTime();
  const expiresAt = String(invitation.expires_at).slice(0, 19);
  if (now >= expiresAt) {
    return {
      error: jsonResponse({
        success: false,
        message: "Masa aktif undangan telah berakhir.",
        expires_at: invitation.expires_at
      }, 403)
    };
  }

  return { invitation };
}

// GET: lihat ucapan
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, message: "Database tidak tersedia." }, 500);
    }

    const url = new URL(request.url);
    const slug = (url.searchParams.get("slug") || "").trim();
    if (!slug || slug.length > 200) {
      return jsonResponse({ success: false, message: "Slug tidak valid." }, 400);
    }

    const { invitation, error } = await getPublicInvitation(env, slug);
    if (error) return error;

    await ensureGuestbookColumns(env);

    const result = await env.DB.prepare(`
      SELECT guest_name, message, attendance, guest_count, created_at
      FROM guestbook
      WHERE invitation_id = ?
        AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(invitation.id).all();

    const entries = result.results || [];

    // Ringkasan RSVP buat template
    let hadir = 0, tidakHadir = 0, ragu = 0, totalTamuHadir = 0;
    for (const e of entries) {
      if (e.attendance === "Hadir") {
        hadir++;
        totalTamuHadir += Number(e.guest_count || 0);
      } else if (e.attendance === "Tidak Hadir") {
        tidakHadir++;
      } else if (e.attendance === "Ragu-ragu") {
        ragu++;
      }
    }

    return jsonResponse({
      success: true,
      guestbook: entries,
      summary: {
        total: entries.length,
        hadir,
        tidak_hadir: tidakHadir,
        ragu,
        total_tamu_hadir: totalTamuHadir
      }
    });
  } catch (error) {
    console.error("PUBLIC GUESTBOOK GET ERROR:", error);
    return jsonResponse({ success: false, message: "Terjadi kesalahan saat memuat ucapan." }, 500);
  }
}

// POST: kirim RSVP + ucapan
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return jsonResponse({ success: false, message: "Database tidak tersedia." }, 500);
    }

    const url = new URL(request.url);
    const slug = (url.searchParams.get("slug") || "").trim();
    if (!slug || slug.length > 200) {
      return jsonResponse({ success: false, message: "Slug tidak valid." }, 400);
    }

    const { invitation, error } = await getPublicInvitation(env, slug);
    if (error) return error;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, message: "Format JSON tidak valid." }, 400);
    }

    const guestName = String(body.guest_name || body.name || "").trim();
    const message = String(body.message || "").trim();
    const attendance = String(body.attendance || "Hadir").trim();
    let guestCount = Number(body.guest_count ?? body.count ?? 1);

    if (!guestName || guestName.length > 100) {
      return jsonResponse({ success: false, message: "Nama wajib diisi, maksimal 100 karakter." }, 400);
    }
    if (!["Hadir", "Tidak Hadir", "Ragu-ragu"].includes(attendance)) {
      return jsonResponse({ success: false, message: "Konfirmasi kehadiran tidak valid." }, 400);
    }
    if (message.length > 500) {
      return jsonResponse({ success: false, message: "Ucapan maksimal 500 karakter." }, 400);
    }

    // Aturan jumlah tamu
    if (attendance === "Hadir") {
      if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 10) {
        return jsonResponse({ success: false, message: "Jumlah tamu untuk yang hadir minimal 1, maksimal 10." }, 400);
      }
    } else {
      // Tidak Hadir / Ragu-ragu -> jumlah 0
      guestCount = 0;
    }

    // Anti spam sederhana: nama + pesan yang sama dalam 60 detik terakhir ditolak
    const recent = await env.DB.prepare(`
      SELECT id FROM guestbook
      WHERE invitation_id = ?
        AND guest_name = ?
        AND message = ?
        AND created_at >= datetime('now', '-60 seconds')
      LIMIT 1
    `).bind(invitation.id, guestName, message).first();

    if (recent) {
      return jsonResponse({ success: false, message: "Ucapan yang sama baru saja dikirim. Tunggu sebentar ya." }, 429);
    }

    await ensureGuestbookColumns(env);

    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO guestbook (id, invitation_id, guest_name, message, attendance, guest_count, status)
      VALUES (?, ?, ?, ?, ?, ?, 'approved')
    `).bind(id, invitation.id, guestName, message, attendance, guestCount).run();

    return jsonResponse({
      success: true,
      message: "Terima kasih, konfirmasi dan ucapan berhasil dikirim.",
      entry: {
        guest_name: guestName,
        message,
        attendance,
        guest_count: guestCount,
        created_at: getJakartaDateTime()
      }
    }, 201);
  } catch (error) {
    console.error("PUBLIC GUESTBOOK POST ERROR:", error);
    return jsonResponse({ success: false, message: "Terjadi kesalahan saat mengirim ucapan." }, 500);
  }
}
