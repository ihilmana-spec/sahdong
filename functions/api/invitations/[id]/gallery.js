
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
const MAX_BATCH_FILES = 20;

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

  if (!data.portraits || typeof data.portraits !== "object" || Array.isArray(data.portraits)) {
    data.portraits = {};
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
    throw new Error("Gagal menyimpan foto. Muat ulang halaman.");
  }
}

function validateEditable(invitation) {
  if (invitation.status !== "draft" || invitation.review_status !== "draft") {
    return "Undangan sudah diterbitkan atau sedang diproses. Foto tidak dapat diubah.";
  }

  if (invitation.order_status !== "paid") {
    return "Pembayaran belum lunas.";
  }

  if (!PACKAGE_LIMITS[invitation.package_name]) {
    return "Paket undangan tidak valid.";
  }

  return null;
}

function validateFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    return "File foto tidak valid.";
  }

  if (!ALLOWED_TYPES[file.type]) {
    return "Format foto harus JPG, PNG, atau WebP.";
  }

  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return "Ukuran setiap foto harus lebih dari 0 dan maksimal 5 MB.";
  }

  return null;
}

async function readAndValidateFile(file) {
  const error = validateFile(file);
  if (error) throw new Error(error);

  const bytes = await file.arrayBuffer();
  const signature = new Uint8Array(bytes.slice(0, 12));

  const isJpeg =
    signature[0] === 0xff &&
    signature[1] === 0xd8 &&
    signature[2] === 0xff;

  const isPng =
    signature[0] === 0x89 &&
    signature[1] === 0x50 &&
    signature[2] === 0x4e &&
    signature[3] === 0x47;

  const isWebp =
    String.fromCharCode(...signature.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...signature.slice(8, 12)) === "WEBP";

  if (
    (file.type === "image/jpeg" && !isJpeg) ||
    (file.type === "image/png" && !isPng) ||
    (file.type === "image/webp" && !isWebp)
  ) {
    throw new Error("Isi file tidak sesuai dengan format foto.");
  }

  return bytes;
}

function createPhoto(invitationId, file, bytes, folder = "gallery") {
  const extension = ALLOWED_TYPES[file.type];
  const key = `invitations/${invitationId}/${folder}/${crypto.randomUUID()}.${extension}`;

  return {
    key,
    url: `/api/gallery-image?key=${encodeURIComponent(key)}`,
    name: String(file.name || "foto").slice(0, 120),
    type: file.type,
    size: bytes.byteLength
  };
}

async function putPhoto(env, photo, bytes) {
  await env.GALLERY.put(photo.key, bytes, {
    httpMetadata: {
      contentType: photo.type,
      cacheControl: "public, max-age=31536000, immutable"
    }
  });
}

// GET: Mengambil galeri dan foto mempelai.
export async function onRequestGet({ request, env, params }) {
  try {
    if (!env.DB) {
      return json({
        success: false,
        message: "Database tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);

    if (!invitation) {
      return json({
        success: false,
        message: "Undangan tidak ditemukan."
      }, 404);
    }

    const data = readGallery(invitation);
    const limit = PACKAGE_LIMITS[invitation.package_name] || 0;

    return json({
      success: true,
      gallery: data.gallery,
      portraits: {
        groom: data.portraits.groom || null,
        bride: data.portraits.bride || null
      },
      package_name: invitation.package_name,
      limit,
      remaining: Math.max(0, limit - data.gallery.length),
      editable:
        invitation.status === "draft" &&
        invitation.review_status === "draft"
    });
  } catch (error) {
    console.error("GALLERY GET ERROR:", error);

    return json({
      success: false,
      message: error.message || "Gagal mengambil galeri."
    }, 500);
  }
}

// POST:
// role=gallery: unggah beberapa foto galeri sekaligus.
// role=portrait: unggah foto mempelai dengan portrait=groom atau bride.
export async function onRequestPost({ request, env, params }) {
  const uploadedKeys = [];

  try {
    if (!env.DB || !env.GALLERY) {
      return json({
        success: false,
        message: "Database atau penyimpanan foto tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);

    if (!invitation) {
      return json({
        success: false,
        message: "Undangan tidak ditemukan."
      }, 404);
    }

    const restriction = validateEditable(invitation);

    if (restriction) {
      return json({ success: false, message: restriction }, 403);
    }

    const form = await request.formData();
    const role = String(form.get("role") || "gallery");
    const data = readGallery(invitation);
    const limit = PACKAGE_LIMITS[invitation.package_name];

    // =========================================
    // UNGGAH FOTO MEMPELAI
    // =========================================
    if (role === "portrait") {
      const portrait = String(form.get("portrait") || "");

      if (!["groom", "bride"].includes(portrait)) {
        return json({
          success: false,
          message: "Jenis foto mempelai tidak valid."
        }, 400);
      }

      const file = form.get("photo");
      const validationError = validateFile(file);

      if (validationError) {
        return json({
          success: false,
          message: validationError
        }, 400);
      }

      const bytes = await readAndValidateFile(file);
      const photo = createPhoto(
        invitation.id,
        file,
        bytes,
        `portraits/${portrait}`
      );

      await putPhoto(env, photo, bytes);
      uploadedKeys.push(photo.key);

      const oldPhoto = data.portraits[portrait];

      data.portraits[portrait] = photo;

      try {
        await saveGallery(env, invitation, data);
      } catch (error) {
        await Promise.all(
          uploadedKeys.map(key => env.GALLERY.delete(key))
        );
        throw error;
      }

      // Hapus foto lama setelah data baru berhasil disimpan.
      if (
        oldPhoto &&
        oldPhoto.key &&
        oldPhoto.key.startsWith(`invitations/${invitation.id}/portraits/`)
      ) {
        await env.GALLERY.delete(oldPhoto.key);
      }

      return json({
        success: true,
        message: portrait === "groom"
          ? "Foto mempelai pria berhasil disimpan."
          : "Foto mempelai wanita berhasil disimpan.",
        portraits: data.portraits
      });
    }

    // =========================================
    // UNGGAH FOTO GALERI
    // =========================================
    if (role !== "gallery") {
      return json({
        success: false,
        message: "Jenis unggahan tidak dikenal."
      }, 400);
    }

    const files = form.getAll("photos").filter(
      file => file && typeof file.arrayBuffer === "function"
    );

    // Kompatibilitas dengan editor versi lama.
    if (files.length === 0) {
      const oldFile = form.get("photo");

      if (oldFile && typeof oldFile.arrayBuffer === "function") {
        files.push(oldFile);
      }
    }

    if (files.length === 0) {
      return json({
        success: false,
        message: "Pilih minimal satu foto."
      }, 400);
    }

    if (files.length > MAX_BATCH_FILES) {
      return json({
        success: false,
        message: `Maksimal ${MAX_BATCH_FILES} file dalam satu kali unggah.`
      }, 400);
    }

    const remaining = Math.max(0, limit - data.gallery.length);

    if (files.length > remaining) {
      return json({
        success: false,
        message: `Sisa kuota hanya ${remaining} foto. Kamu memilih ${files.length} foto.`,
        remaining,
        limit
      }, 400);
    }

    // Validasi seluruh file terlebih dahulu sebelum mengunggah.
    const preparedFiles = [];

    for (const file of files) {
      const bytes = await readAndValidateFile(file);
      preparedFiles.push({ file, bytes });
    }

    const newPhotos = preparedFiles.map(({ file, bytes }) =>
      createPhoto(invitation.id, file, bytes, "gallery")
    );

    // Unggah seluruh foto.
    try {
      for (let index = 0; index < preparedFiles.length; index++) {
        await putPhoto(
          env,
          newPhotos[index],
          preparedFiles[index].bytes
        );

        uploadedKeys.push(newPhotos[index].key);
      }
    } catch (error) {
      await Promise.all(
        uploadedKeys.map(key => env.GALLERY.delete(key))
      );

      throw error;
    }

    data.gallery.push(...newPhotos);

    try {
      await saveGallery(env, invitation, data);
    } catch (error) {
      await Promise.all(
        uploadedKeys.map(key => env.GALLERY.delete(key))
      );

      throw error;
    }

    return json({
      success: true,
      message: `${newPhotos.length} foto berhasil diunggah.`,
      photos: newPhotos,
      gallery: data.gallery,
      package_name: invitation.package_name,
      limit,
      remaining: Math.max(0, limit - data.gallery.length)
    });

  } catch (error) {
    console.error("GALLERY UPLOAD ERROR:", error);

    return json({
      success: false,
      message: error.message || "Gagal mengunggah foto."
    }, 500);
  }
}

// DELETE:
// { key: "...", role: "gallery" }
// { key: "...", role: "groom" }
// { key: "...", role: "bride" }
export async function onRequestDelete({ request, env, params }) {
  try {
    if (!env.DB || !env.GALLERY) {
      return json({
        success: false,
        message: "Database atau penyimpanan foto tidak tersedia."
      }, 500);
    }

    const auth = await authenticate(request, env);
    if (auth.error) {
      return json({ success: false, message: auth.error }, auth.status);
    }

    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);

    if (!invitation) {
      return json({
        success: false,
        message: "Undangan tidak ditemukan."
      }, 404);
    }

    const restriction = validateEditable(invitation);

    if (restriction) {
      return json({ success: false, message: restriction }, 403);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        success: false,
        message: "Permintaan penghapusan tidak valid."
      }, 400);
    }

    const key = String(body.key || "");
    const role = String(body.role || "gallery");
    const prefix = `invitations/${invitation.id}/`;

    if (
      !key.startsWith(prefix) ||
      key.includes("..") ||
      key.includes("\\")
    ) {
      return json({
        success: false,
        message: "Foto tidak valid."
      }, 400);
    }

    const data = readGallery(invitation);
    let removedPhoto = null;

    if (role === "gallery") {
      const index = data.gallery.findIndex(photo => photo.key === key);

      if (index === -1) {
        return json({
          success: false,
          message: "Foto galeri tidak ditemukan."
        }, 404);
      }

      removedPhoto = data.gallery[index];
      data.gallery.splice(index, 1);

    } else if (role === "groom" || role === "bride") {
      const photo = data.portraits[role];

      if (!photo || photo.key !== key) {
        return json({
          success: false,
          message: "Foto mempelai tidak ditemukan."
        }, 404);
      }

      removedPhoto = photo;
      data.portraits[role] = null;

    } else {
      return json({
        success: false,
        message: "Jenis foto tidak valid."
      }, 400);
    }

    // Simpan perubahan database terlebih dahulu.
    await saveGallery(env, invitation, data);

    // Setelah database berhasil, hapus objek R2.
    if (removedPhoto && removedPhoto.key) {
      await env.GALLERY.delete(removedPhoto.key);
    }

    const limit = PACKAGE_LIMITS[invitation.package_name];

    return json({
      success: true,
      message: "Foto berhasil dihapus.",
      gallery: data.gallery,
      portraits: {
        groom: data.portraits.groom || null,
        bride: data.portraits.bride || null
      },
      limit,
      remaining: Math.max(0, limit - data.gallery.length)
    });

  } catch (error) {
    console.error("GALLERY DELETE ERROR:", error);

    return json({
      success: false,
      message: error.message || "Gagal menghapus foto."
    }, 500);
  }
}
