// functions/api/invitations/[id]/music.js
// API pengaturan musik undangan SAHDONG.
// GET    : mengambil katalog musik dan pilihan musik undangan.
// POST   : memilih lagu katalog, mengunggah MP3 sendiri, atau tanpa musik.
// DELETE : menghapus unggahan musik milik undangan dan mengatur tanpa musik.

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

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CATALOG_PREFIX = "catalog/";
const CUSTOMER_PREFIX = "customer-music/";

async function getOwnedInvitation(env, invitationId, userId) {
  return env.DB.prepare(`
    SELECT
      i.id,
      i.user_id,
      i.status,
      i.review_status,
      i.invitation_data,
      o.status AS order_status,
      p.status AS payment_status
    FROM invitations i
    JOIN orders o
      ON o.invitation_id = i.id
     AND o.user_id = i.user_id
    LEFT JOIN payments p
      ON p.order_id = o.id
    WHERE i.id = ?
      AND i.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 1
  `).bind(invitationId, userId).first();
}

function validateEditable(invitation) {
  if (invitation.status !== "draft" || invitation.review_status !== "draft") {
    return "Undangan sudah diterbitkan atau sedang diproses. Musik tidak dapat diubah.";
  }

  if (
    invitation.order_status !== "paid" ||
    invitation.payment_status !== "paid"
  ) {
    return "Pembayaran belum terkonfirmasi lunas.";
  }

  return null;
}

function readInvitationData(invitation) {
  let data;

  try {
    data = JSON.parse(invitation.invitation_data || "{}");
  } catch {
    throw new Error("Data undangan tidak valid.");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Format data undangan tidak valid.");
  }

  return data;
}

async function saveInvitationData(env, invitation, data) {
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
    throw new Error("Gagal menyimpan musik. Muat ulang halaman.");
  }
}

function isMp3(bytes) {
  if (bytes.length < 3) return false;

  // MP3 dapat diawali tag ID3.
  const hasId3 =
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33;

  if (hasId3) return true;

  // Atau diawali MPEG audio frame sync.
  return bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0;
}

async function getCatalog(env) {
  const result = await env.MUSIC.list({
    prefix: CATALOG_PREFIX,
    limit: 100
  });

  return result.objects
    .filter(object => object.key.toLowerCase().endsWith(".mp3"))
    .map(object => ({
      key: object.key,
      title: object.customMetadata?.title ||
        object.key.slice(CATALOG_PREFIX.length).replace(/\.mp3$/i, ""),
      artist: object.customMetadata?.artist || "",
      size: object.size
    }));
}

// GET: katalog musik dan pilihan musik yang tersimpan.
export async function onRequestGet({ request, env, params }) {
  try {
    if (!env.DB || !env.MUSIC) {
      return json({
        success: false,
        message: "Database atau penyimpanan musik tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) {
      return json({ success: false, message: "Undangan tidak ditemukan." }, 404);
    }

    const data = readInvitationData(invitation);
    const catalog = await getCatalog(env);

    return json({
      success: true,
      music: data.music || { mode: "none" },
      catalog,
      editable: invitation.status === "draft" &&
        invitation.review_status === "draft" &&
        invitation.order_status === "paid"
    });
  } catch (error) {
    console.error("MUSIC GET ERROR:", error);
    return json({
      success: false,
      message: error.message || "Gagal mengambil pengaturan musik."
    }, 500);
  }
}

// POST: JSON untuk katalog/tanpa musik; multipart untuk unggahan MP3.
export async function onRequestPost({ request, env, params }) {
  let uploadedKey = null;

  try {
    if (!env.DB || !env.MUSIC) {
      return json({
        success: false,
        message: "Database atau penyimpanan musik tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) {
      return json({ success: false, message: "Undangan tidak ditemukan." }, 404);
    }

    const restriction = validateEditable(invitation);
    if (restriction) {
      return json({ success: false, message: restriction }, 403);
    }

    const data = readInvitationData(invitation);
    const previousMusic = data.music || { mode: "none" };
    const contentType = request.headers.get("Content-Type") || "";

    let nextMusic;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("music");

      if (!file || typeof file.arrayBuffer !== "function") {
        return json({ success: false, message: "Pilih file MP3 terlebih dahulu." }, 400);
      }

      if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
        return json({ success: false, message: "Ukuran lagu maksimal 10 MB." }, 400);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());

      if (!isMp3(bytes)) {
        return json({ success: false, message: "Isi file tidak dikenali sebagai MP3." }, 400);
      }

      const key = `${CUSTOMER_PREFIX}${invitation.id}/${crypto.randomUUID()}.mp3`;
      uploadedKey = key;

      await env.MUSIC.put(key, bytes, {
        httpMetadata: {
          contentType: "audio/mpeg",
          cacheControl: "private, no-store"
        },
        customMetadata: {
          invitationId: String(invitation.id),
          originalName: String(file.name || "musik.mp3").slice(0, 120)
        }
      });

      nextMusic = {
        mode: "upload",
        key,
        title: String(file.name || "Musik pelanggan").slice(0, 120),
        size: file.size,
        type: "audio/mpeg"
      };
    } else {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ success: false, message: "Format permintaan tidak valid." }, 400);
      }

      const mode = String(body.mode || "");

      if (mode === "none") {
        nextMusic = { mode: "none" };
      } else if (mode === "catalog") {
        const key = String(body.key || "");

        if (!key.startsWith(CATALOG_PREFIX) ||
            key.includes("..") ||
            !key.toLowerCase().endsWith(".mp3")) {
          return json({ success: false, message: "Pilihan lagu katalog tidak valid." }, 400);
        }

        const object = await env.MUSIC.head(key);
        if (!object) {
          return json({ success: false, message: "Lagu katalog tidak ditemukan." }, 404);
        }

        nextMusic = {
          mode: "catalog",
          key,
          title: object.customMetadata?.title ||
            key.slice(CATALOG_PREFIX.length).replace(/\.mp3$/i, ""),
          artist: object.customMetadata?.artist || ""
        };
      } else {
        return json({ success: false, message: "Mode musik tidak dikenal." }, 400);
      }
    }

    data.music = nextMusic;

    try {
      await saveInvitationData(env, invitation, data);
    } catch (error) {
      if (uploadedKey) {
        await env.MUSIC.delete(uploadedKey);
      }
      throw error;
    }

    // Hapus unggahan sebelumnya setelah pilihan baru berhasil disimpan.
    if (
      previousMusic.mode === "upload" &&
      previousMusic.key &&
      previousMusic.key.startsWith(`${CUSTOMER_PREFIX}${invitation.id}/`) &&
      previousMusic.key !== nextMusic.key
    ) {
      await env.MUSIC.delete(previousMusic.key);
    }

    return json({
      success: true,
      message: "Pengaturan musik berhasil disimpan.",
      music: nextMusic
    });
  } catch (error) {
    console.error("MUSIC SAVE ERROR:", error);

    if (uploadedKey) {
      try {
        await env.MUSIC.delete(uploadedKey);
      } catch {}
    }

    return json({
      success: false,
      message: error.message || "Gagal menyimpan musik."
    }, 500);
  }
}

// DELETE: menghapus file unggahan pelanggan dan mengatur undangan tanpa musik.
export async function onRequestDelete({ request, env, params }) {
  try {
    if (!env.DB || !env.MUSIC) {
      return json({
        success: false,
        message: "Database atau penyimpanan musik tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) {
      return json({ success: false, message: "Undangan tidak ditemukan." }, 404);
    }

    const restriction = validateEditable(invitation);
    if (restriction) {
      return json({ success: false, message: restriction }, 403);
    }

    const data = readInvitationData(invitation);
    const currentMusic = data.music || { mode: "none" };

    data.music = { mode: "none" };
    await saveInvitationData(env, invitation, data);

    // Hapus objek setelah metadata berhasil diubah agar tidak ada
    // referensi database yang menunjuk ke file yang sudah terhapus.
    if (
      currentMusic.mode === "upload" &&
      currentMusic.key &&
      currentMusic.key.startsWith(`${CUSTOMER_PREFIX}${invitation.id}/`)
    ) {
      await env.MUSIC.delete(currentMusic.key);
    }

    return json({
      success: true,
      message: "Musik berhasil dihapus.",
      music: data.music
    });
  } catch (error) {
    console.error("MUSIC DELETE ERROR:", error);
    return json({
      success: false,
      message: error.message || "Gagal menghapus musik."
    }, 500);
  }
}
