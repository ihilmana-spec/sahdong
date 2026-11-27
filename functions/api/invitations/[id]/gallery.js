
async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
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

const PACKAGE_LIMITS = {
  Basic: 6,
  Premium: 12,
  Exclusive: 20
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

async function getOwnedInvitation(env, invitationId, userId) {
  return env.DB.prepare(`
    SELECT
      i.id,
      i.user_id,
      i.status,
      i.review_status,
      i.invitation_data,
      o.status AS order_status,
      o.package_name
    FROM invitations i
    JOIN orders o
      ON o.invitation_id = i.id
     AND o.user_id = i.user_id
    WHERE i.id = ?
      AND i.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 1
  `).bind(invitationId, userId).first();
}

function readGallery(invitation) {
  let data = {};

  try {
    data = JSON.parse(invitation.invitation_data || "{}");
  } catch {
    throw new Error("Data undangan tidak valid.");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Format data undangan tidak valid.");
  }

  if (!Array.isArray(data.gallery)) {
    data.gallery = [];
  }

  return data;
}

async function saveGallery(env, invitation, data) {
  const result = await env.DB.prepare(`
    UPDATE invitations
    SET invitation_data = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND user_id = ?
      AND status = 'draft'
      AND review_status = 'draft'
  `).bind(
    JSON.stringify(data),
    invitation.id,
    invitation.user_id
  ).run();

  if (!result.meta || result.meta.changes !== 1) {
    throw new Error("Gagal menyimpan galeri. Muat ulang halaman.");
  }
}

function validateEditable(invitation) {
  if (invitation.status !== "draft" || invitation.review_status !== "draft") {
    return "Undangan sudah diterbitkan atau sedang diproses. Galeri tidak dapat diubah.";
  }

  if (invitation.order_status !== "paid") {
    return "Pembayaran belum lunas.";
  }

  if (!PACKAGE_LIMITS[invitation.package_name]) {
    return "Paket undangan tidak valid.";
  }

  return null;
}

// GET: Mengambil daftar foto.
export async function onRequestGet({ request, env, params }) {
  try {
    if (!env.DB) return json({ success: false, message: "Database tidak tersedia." }, 500);

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    const data = readGallery(invitation);
    const limit = PACKAGE_LIMITS[invitation.package_name] || 0;

    return json({
      success: true,
      gallery: data.gallery,
      package_name: invitation.package_name,
      limit,
      remaining: Math.max(0, limit - data.gallery.length),
      editable: invitation.status === "draft" && invitation.review_status === "draft"
    });
  } catch (error) {
    console.error("GALLERY GET ERROR:", error);
    return json({ success: false, message: "Gagal mengambil galeri." }, 500);
  }
}

// POST: Mengunggah foto.
export async function onRequestPost({ request, env, params }) {
  try {
    if (!env.DB || !env.GALLERY) {
      return json({ success: false, message: "Database atau penyimpanan foto tidak tersedia." }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    const restriction = validateEditable(invitation);
    if (restriction) return json({ success: false, message: restriction }, 403);

    const data = readGallery(invitation);
    const limit = PACKAGE_LIMITS[invitation.package_name];

    if (data.gallery.length >= limit) {
      return json({ success: false, message: `Kuota galeri ${invitation.package_name} sudah penuh (${limit} foto).` }, 400);
    }

    const form = await request.formData();
    const file = form.get("photo");

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ success: false, message: "Pilih foto terlebih dahulu." }, 400);
    }

    if (!ALLOWED_TYPES[file.type]) {
      return json({ success: false, message: "Format foto harus JPG, PNG, atau WebP." }, 400);
    }

    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return json({ success: false, message: "Ukuran foto maksimal 5 MB." }, 400);
    }

    const bytes = await file.arrayBuffer();

    // Periksa signature file, bukan hanya MIME dari browser.
    const signature = new Uint8Array(bytes.slice(0, 12));
    const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const isPng = signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
    const isWebp = String.fromCharCode(...signature.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...signature.slice(8, 12)) === "WEBP";

    if (
      (file.type === "image/jpeg" && !isJpeg) ||
      (file.type === "image/png" && !isPng) ||
      (file.type === "image/webp" && !isWebp)
    ) {
      return json({ success: false, message: "Isi file tidak sesuai dengan format foto." }, 400);
    }

    const key = `invitations/${invitation.id}/${crypto.randomUUID()}.${ALLOWED_TYPES[file.type]}`;

    await env.GALLERY.put(key, bytes, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });

    const photo = {
      key,
      url: `/api/gallery-image?key=${encodeURIComponent(key)}`,
      name: String(file.name || "foto").slice(0, 120),
      type: file.type,
      size: file.size
    };

    data.gallery.push(photo);

    try {
      await saveGallery(env, invitation, data);
    } catch (error) {
      await env.GALLERY.delete(key);
      throw error;
    }

    return json({
      success: true,
      message: "Foto berhasil diunggah.",
      photo,
      gallery: data.gallery,
      limit,
      remaining: Math.max(0, limit - data.gallery.length)
    });
  } catch (error) {
    console.error("GALLERY UPLOAD ERROR:", error);
    return json({ success: false, message: error.message || "Gagal mengunggah foto." }, 500);
  }
}

// DELETE: Menghapus foto berdasarkan key.
export async function onRequestDelete({ request, env, params }) {
  try {
    if (!env.DB || !env.GALLERY) {
      return json({ success: false, message: "Database atau penyimpanan foto tidak tersedia." }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    const restriction = validateEditable(invitation);
    if (restriction) return json({ success: false, message: restriction }, 403);

    const body = await request.json();
    const key = String(body.key || "");

    const prefix = `invitations/${invitation.id}/`;

    if (!key.startsWith(prefix) || key.includes("..")) {
      return json({ success: false, message: "Foto tidak valid." }, 400);
    }

    const data = readGallery(invitation);
    const index = data.gallery.findIndex(photo => photo.key === key);

    if (index === -1) {
      return json({ success: false, message: "Foto tidak ditemukan." }, 404);
    }

    await env.GALLERY.delete(key);
    data.gallery.splice(index, 1);

    await saveGallery(env, invitation, data);

    return json({
      success: true,
      message: "Foto berhasil dihapus.",
      gallery: data.gallery,
      limit: PACKAGE_LIMITS[invitation.package_name],
      remaining: Math.max(0, PACKAGE_LIMITS[invitation.package_name] - data.gallery.length)
    });
  } catch (error) {
    console.error("GALLERY DELETE ERROR:", error);
    return json({ success: false, message: "Gagal menghapus foto." }, 500);
  }
}
