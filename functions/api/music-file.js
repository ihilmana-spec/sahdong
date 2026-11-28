
// functions/api/music-file.js
// Menyajikan musik katalog dan musik unggahan pelanggan.
// Musik unggahan dapat diakses oleh:
// 1. Pemilik undangan saat preview pribadi dalam status draft.
// 2. Pengunjung undangan yang sudah diterbitkan, aktif, dan lunas.

function jsonError(message, status = 400) {
  return Response.json(
    { success: false, message },
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

// ======================================
// WAKTU WIB
// ======================================

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
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

// ======================================
// VALIDASI KEY FILE
// ======================================

function isSafeKey(key) {
  return typeof key === "string" &&
    key.length > 0 &&
    key.length <= 500 &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    /^[a-zA-Z0-9_./-]+$/.test(key) &&
    key.toLowerCase().endsWith(".mp3");
}

function getInvitationIdFromMusicKey(key) {
  const match = key.match(
    /^customer-music\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9-]{20,80})\.mp3$/
  );

  return match ? match[1] : null;
}

// ======================================
// AUTENTIKASI PELANGGAN
// ======================================

async function hashToken(token) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getSessionCookie(request) {
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const name = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (name === "sahdong_session") {
      return value;
    }
  }

  return null;
}

async function authenticateCustomer(request, env) {
  const token = getSessionCookie(request);

  if (!token) return null;

  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  const user = await env.DB.prepare(`
    SELECT users.id, users.role, users.status
    FROM sessions
    INNER JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  if (
    !user ||
    user.status !== "active" ||
    user.role !== "customer"
  ) {
    return null;
  }

  return user;
}

// ======================================
// AKSES MUSIK PREVIEW PRIBADI
// ======================================

async function isOwnedDraftMusic(env, userId, key) {
  const invitationId = getInvitationIdFromMusicKey(key);

  if (!invitationId || !userId) {
    return false;
  }

  const invitation = await env.DB.prepare(`
    SELECT invitation_data
    FROM invitations
    WHERE id = ?
      AND user_id = ?
      AND status = 'draft'
      AND review_status = 'draft'
    LIMIT 1
  `).bind(invitationId, userId).first();

  if (!invitation) return false;

  let data;

  try {
    data = JSON.parse(invitation.invitation_data || "{}");
  } catch {
    return false;
  }

  return Boolean(
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.music &&
    data.music.mode === "upload" &&
    data.music.key === key
  );
}

// ======================================
// AKSES MUSIK UNDANGAN PUBLIK
// ======================================

async function isPublishedCustomerMusic(env, key) {
  const invitationId = getInvitationIdFromMusicKey(key);

  if (!invitationId) return false;

  const invitation = await env.DB.prepare(`
    SELECT
      i.id,
      i.invitation_data,
      i.activation_date,
      i.published_at,
      i.expires_at,
      o.status AS order_status,
      p.status AS payment_status
    FROM invitations i
    INNER JOIN orders o
      ON o.invitation_id = i.id
     AND o.user_id = i.user_id
    INNER JOIN payments p
      ON p.order_id = o.id
    WHERE i.id = ?
      AND i.status = 'published'
      AND i.published_at IS NOT NULL
      AND i.activation_date IS NOT NULL
      AND i.expires_at IS NOT NULL
      AND o.status = 'paid'
      AND p.status = 'paid'
    ORDER BY p.created_at DESC
    LIMIT 1
  `).bind(invitationId).first();

  if (!invitation) return false;

  const now = getJakartaDateTime();
  const today = now.slice(0, 10);

  const activationDate = String(
    invitation.activation_date
  ).slice(0, 10);

  const expiresAt = String(
    invitation.expires_at
  ).slice(0, 19);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(activationDate) ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(expiresAt)
  ) {
    return false;
  }

  if (activationDate > today || now >= expiresAt) {
    return false;
  }

  let data;

  try {
    data = JSON.parse(invitation.invitation_data || "{}");
  } catch {
    return false;
  }

  return Boolean(
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.music &&
    data.music.mode === "upload" &&
    data.music.key === key
  );
}

// ======================================
// PEMERIKSAAN RENTANG AUDIO
// ======================================

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(
    rangeHeader.trim()
  );

  if (!match || (!match[1] && !match[2])) {
    return false;
  }

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);

    if (
      !Number.isSafeInteger(suffixLength) ||
      suffixLength <= 0
    ) {
      return false;
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return false;
  }

  end = Math.min(end, size - 1);

  return {
    offset: start,
    length: end - start + 1,
    end
  };
}

// ======================================
// MELAYANI FILE AUDIO
// ======================================

async function serveAudio(request, env) {
  if (!env.MUSIC || !env.DB) {
    return jsonError(
      "Penyimpanan musik atau database tidak tersedia.",
      500
    );
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!isSafeKey(key)) {
    return jsonError(
      "Kunci file musik tidak valid.",
      400
    );
  }

  let isCatalog = false;

  if (key.startsWith("catalog/")) {
    isCatalog = true;

  } else if (key.startsWith("customer-music/")) {

    // Coba akses sebagai pemilik preview pribadi.
    const user = await authenticateCustomer(request, env);

    let allowed = false;

    if (user) {
      allowed = await isOwnedDraftMusic(
        env,
        user.id,
        key
      );
    }

    // Jika bukan preview pemilik, periksa akses undangan publik.
    if (!allowed) {
      allowed = await isPublishedCustomerMusic(
        env,
        key
      );
    }

    if (!allowed) {
      return jsonError(
        "File musik tidak tersedia untuk undangan ini.",
        404
      );
    }

  } else {
    return jsonError(
      "Akses file musik ditolak.",
      403
    );
  }

  // Periksa keberadaan file di R2.
  const metadata = await env.MUSIC.head(key);

  if (!metadata) {
    return jsonError(
      "File musik tidak ditemukan.",
      404
    );
  }

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Cache-Control": isCatalog
      ? "public, max-age=3600"
      : "private, no-store"
  });

  // Mendukung permintaan HEAD.
  if (request.method === "HEAD") {
    headers.set(
      "Content-Length",
      String(metadata.size)
    );

    return new Response(null, {
      status: 200,
      headers
    });
  }

  // Mendukung streaming dan pemutaran audio.
  const rangeHeader = request.headers.get("Range");
  const range = parseRange(
    rangeHeader,
    metadata.size
  );

  if (range === false) {
    headers.set(
      "Content-Range",
      `bytes */${metadata.size}`
    );

    return new Response(null, {
      status: 416,
      headers
    });
  }

  let object;
  let status = 200;

  if (range) {
    object = await env.MUSIC.get(key, {
      range: {
        offset: range.offset,
        length: range.length
      }
    });

    if (!object) {
      return jsonError(
        "File musik tidak ditemukan.",
        404
      );
    }

    status = 206;

    headers.set(
      "Content-Length",
      String(range.length)
    );

    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.end}/${metadata.size}`
    );

  } else {
    object = await env.MUSIC.get(key);

    if (!object) {
      return jsonError(
        "File musik tidak ditemukan.",
        404
      );
    }

    headers.set(
      "Content-Length",
      String(metadata.size)
    );
  }

  return new Response(object.body, {
    status,
    headers
  });
}

// ======================================
// GET AUDIO
// ======================================

export async function onRequestGet({ request, env }) {
  try {
    return await serveAudio(request, env);

  } catch (error) {
    console.error(
      "SAHDONG MUSIC FILE GET ERROR:",
      error
    );

    return jsonError(
      "Terjadi kesalahan saat mengambil file musik.",
      500
    );
  }
}

// ======================================
// HEAD AUDIO
// ======================================

export async function onRequestHead({ request, env }) {
  try {
    return await serveAudio(request, env);

  } catch (error) {
    console.error(
      "SAHDONG MUSIC FILE HEAD ERROR:",
      error
    );

    return jsonError(
      "Terjadi kesalahan saat memeriksa file musik.",
      500
    );
  }
}
