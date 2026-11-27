// functions/api/music-file.js
// Menyajikan audio katalog dan audio unggahan pelanggan dari R2 MUSIC.
// Audio unggahan hanya dapat diakses jika masih dipakai oleh undangan
// yang sudah diterbitkan, aktif, dan pembayarannya lunas.

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

async function isPublishedCustomerMusic(env, key) {
  // Bentuk key wajib: customer-music/{invitationId}/{uuid}.mp3
  const match = key.match(/^customer-music\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9-]{20,80})\.mp3$/);
  if (!match) return false;

  const invitationId = match[1];
  const invitation = await env.DB.prepare(`
    SELECT
      i.id,
      i.invitation_data,
      i.activation_date,
      i.published_at,
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
  const activationDate = String(invitation.activation_date).slice(0, 10);
  const expiresAt = String(invitation.expires_at).slice(0, 19);

  if (activationDate > today || now >= expiresAt) return false;

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

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
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
  return { offset: start, length: end - start + 1, end };
}

async function serveAudio(request, env) {
  if (!env.MUSIC || !env.DB) {
    return jsonError("Penyimpanan musik atau database tidak tersedia.", 500);
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!isSafeKey(key)) {
    return jsonError("Kunci file musik tidak valid.", 400);
  }

  let isCatalog = false;
  let isCustomerUpload = false;

  if (key.startsWith("catalog/")) {
    isCatalog = true;
  } else if (key.startsWith("customer-music/")) {
    isCustomerUpload = true;
    const allowed = await isPublishedCustomerMusic(env, key);
    if (!allowed) {
      return jsonError("File musik tidak tersedia untuk undangan ini.", 404);
    }
  } else {
    return jsonError("Akses file musik ditolak.", 403);
  }

  const metadata = await env.MUSIC.head(key);
  if (!metadata) return jsonError("File musik tidak ditemukan.", 404);

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Cache-Control": isCatalog ? "public, max-age=3600" : "private, no-store"
  });

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(metadata.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get("Range");
  const range = parseRange(rangeHeader, metadata.size);

  if (range === false) {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }

  let object;
  let status = 200;

  if (range) {
    object = await env.MUSIC.get(key, {
      range: { offset: range.offset, length: range.length }
    });
    if (!object) return jsonError("File musik tidak ditemukan.", 404);

    status = 206;
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.offset}-${range.end}/${metadata.size}`);
  } else {
    object = await env.MUSIC.get(key);
    if (!object) return jsonError("File musik tidak ditemukan.", 404);
    headers.set("Content-Length", String(metadata.size));
  }

  return new Response(object.body, { status, headers });
}

export async function onRequestGet({ request, env }) {
  try {
    return await serveAudio(request, env);
  } catch (error) {
    console.error("SAHDONG MUSIC FILE GET ERROR:", error);
    return jsonError("Terjadi kesalahan saat mengambil file musik.", 500);
  }
}

export async function onRequestHead({ request, env }) {
  try {
    return await serveAudio(request, env);
  } catch (error) {
    console.error("SAHDONG MUSIC FILE HEAD ERROR:", error);
    return jsonError("Terjadi kesalahan saat memeriksa file musik.", 500);
  }
}
