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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
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

const MAX_MUSIC_SIZE = 10 * 1024 * 1024;

// Parser multipart manual — sama seperti gallery.js.
// formData() bawaan Cloudflare terbukti mengubah part file
// (foto maupun MP3) jadi string biner. Parser ini kerja di level byte.
function parseMultipart(bodyBytes, boundary) {
  const entries = [];
  const boundaryBytes = new TextEncoder().encode("--" + boundary);
  function indexOfBytes(haystack, needle, from = 0) {
    outer: for (let i = from; i + needle.length <= haystack.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
  const DOUBLE_CRLF = new Uint8Array([13, 10, 13, 10]);
  const decoder = new TextDecoder("utf-8");
  let pos = indexOfBytes(bodyBytes, boundaryBytes, 0);
  while (pos !== -1) {
    let cursor = pos + boundaryBytes.length;
    if (bodyBytes[cursor] === 45 && bodyBytes[cursor + 1] === 45) break;
    if (bodyBytes[cursor] === 13 && bodyBytes[cursor + 1] === 10) cursor += 2;
    const headerEnd = indexOfBytes(bodyBytes, DOUBLE_CRLF, cursor);
    if (headerEnd === -1) break;
    const headerText = decoder.decode(bodyBytes.slice(cursor, headerEnd));
    const contentStart = headerEnd + 4;
    const nextBoundary = indexOfBytes(bodyBytes, boundaryBytes, contentStart);
    if (nextBoundary === -1) break;
    let contentEnd = nextBoundary;
    if (contentEnd >= 2 && bodyBytes[contentEnd - 2] === 13 && bodyBytes[contentEnd - 1] === 10) contentEnd -= 2;
    const contentBytes = bodyBytes.slice(contentStart, contentEnd);
    const nameMatch = headerText.match(/name="([^"]*)"/);
    const fileMatch = headerText.match(/filename="([^"]*)"/);
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n;]+)/i);
    const name = nameMatch ? nameMatch[1] : "";
    if (!name) { pos = nextBoundary; continue; }
    if (fileMatch) {
      const fileObj = {
        name: fileMatch[1] || "musik.mp3",
        type: (typeMatch ? typeMatch[1].trim() : "") || "application/octet-stream",
        size: contentBytes.byteLength,
        arrayBuffer: async () => contentBytes.buffer.slice(
          contentBytes.byteOffset, contentBytes.byteOffset + contentBytes.byteLength
        )
      };
      entries.push([name, fileObj]);
    } else {
      entries.push([name, decoder.decode(contentBytes)]);
    }
    pos = nextBoundary;
  }
  return entries;
}

function makeForm(entries) {
  return {
    get(name) {
      const f = entries.find(([n]) => n === name);
      return f ? f[1] : null;
    },
    getAll(name) {
      return entries.filter(([n]) => n === name).map(([, v]) => v);
    }
  };
}

async function getOwnedInvitation(env, invitationId, userId) {
  return env.DB.prepare(`
    SELECT i.id, i.user_id, i.status, i.review_status, i.invitation_data,
      o.status AS order_status, o.package_name
    FROM invitations i
    JOIN orders o ON o.invitation_id = i.id AND o.user_id = i.user_id
    WHERE i.id = ? AND i.user_id = ?
    ORDER BY o.created_at DESC LIMIT 1
  `).bind(invitationId, userId).first();
}

function readData(invitation) {
  let data = {};
  try { data = JSON.parse(invitation.invitation_data || "{}"); } catch {
    throw new Error("Data undangan tidak valid.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Format data undangan tidak valid.");
  }
  return data;
}

async function saveData(env, invitation, data) {
  const result = await env.DB.prepare(`
    UPDATE invitations SET invitation_data = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND status = 'draft' AND review_status = 'draft'
  `).bind(JSON.stringify(data), invitation.id, invitation.user_id).run();
  if (!result.meta || result.meta.changes !== 1) {
    throw new Error("Gagal menyimpan musik. Muat ulang halaman.");
  }
}

function validateEditable(invitation) {
  if (invitation.status !== "draft" || invitation.review_status !== "draft") {
    return "Undangan sudah diterbitkan atau sedang diproses. Musik tidak dapat diubah.";
  }
  if (invitation.order_status !== "paid") return "Pembayaran belum lunas.";
  return null;
}

// GET: katalog + musik yang dipilih
export async function onRequestGet({ request, env, params }) {
  try {
    if (!env.DB) return json({ success: false, message: "Database tidak tersedia." }, 500);
    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);
    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);

    const data = readData(invitation);
    let catalog = [];
    if (env.MUSIC) {
      try {
        const listed = await env.MUSIC.list({ prefix: "catalog/" });
        catalog = (listed.objects || [])
          .filter(o => /\.mp3$/i.test(o.key))
          .map(o => {
            const fileName = o.key.split("/").pop().replace(/\.mp3$/i, "");
            const parts = fileName.split(" - ");
            return {
              key: o.key,
              title: parts.length > 1 ? parts.slice(0, -1).join(" - ") : fileName,
              artist: parts.length > 1 ? parts[parts.length - 1] : "",
              name: fileName
            };
          });
      } catch { catalog = []; }
    }
    return json({
      success: true,
      catalog,
      music: data.music || { mode: "none" },
      editable: invitation.status === "draft" && invitation.review_status === "draft"
    });
  } catch (error) {
    console.error("MUSIC GET ERROR:", error);
    return json({ success: false, message: error.message || "Gagal mengambil musik." }, 500);
  }
}

// POST:
// JSON {mode:"catalog", key} / {mode:"none"}
// multipart FormData {music: File MP3}
export async function onRequestPost({ request, env, params }) {
  try {
    if (!env.DB || !env.MUSIC) {
      return json({ success: false, message: "Database atau penyimpanan musik tidak tersedia." }, 500);
    }
    const auth = await authenticate(request, env);
    if (auth.error) return json({ success: false, message: auth.error }, auth.status);
    const invitation = await getOwnedInvitation(env, params.id, auth.user.id);
    if (!invitation) return json({ success: false, message: "Undangan tidak ditemukan." }, 404);
    const restriction = validateEditable(invitation);
    if (restriction) return json({ success: false, message: restriction }, 403);

    const contentType = request.headers.get("Content-Type") || "";
    const data = readData(invitation);

    // --- Mode JSON: pilih katalog / tanpa musik (tetap seperti dulu) ---
    if (contentType.includes("application/json")) {
      let body;
      try { body = await request.json(); } catch {
        return json({ success: false, message: "Permintaan tidak valid." }, 400);
      }
      if (body.mode === "none") {
        data.music = { mode: "none" };
        await saveData(env, invitation, data);
        return json({ success: true, message: "Undangan diatur tanpa musik.", music: data.music });
      }
      if (body.mode === "catalog") {
        const key = String(body.key || "");
        if (!key.startsWith("catalog/") || !/\.mp3$/i.test(key)) {
          return json({ success: false, message: "Musik katalog tidak valid." }, 400);
        }
        const obj = await env.MUSIC.get(key);
        if (!obj) return json({ success: false, message: "Musik katalog tidak ditemukan." }, 404);
        const fileName = key.split("/").pop().replace(/\.mp3$/i, "");
        data.music = { mode: "catalog", key, title: fileName, name: fileName };
        await saveData(env, invitation, data);
        return json({ success: true, message: "Musik katalog berhasil dipilih.", music: data.music });
      }
      return json({ success: false, message: "Mode musik tidak dikenal." }, 400);
    }

    // --- Mode upload MP3: multipart, parser manual (bukan formData) ---
    if (!contentType.includes("multipart/form-data")) {
      return json({ success: false, message: "Format unggahan tidak valid." }, 400);
    }
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || "").trim() : "";
    if (!boundary) {
      return json({ success: false, message: "Content-Type multipart tidak valid." }, 400);
    }
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const entries = parseMultipart(bodyBytes, boundary);
    const form = makeForm(entries);
    const file = form.get("music");

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ success: false, message: "File MP3 tidak valid." }, 400);
    }
    const isMp3 = file.type === "audio/mpeg" || /\.mp3$/i.test(file.name || "");
    if (!isMp3) {
      return json({ success: false, message: "File harus berformat MP3." }, 400);
    }
    if (file.size <= 0 || file.size > MAX_MUSIC_SIZE) {
      return json({ success: false, message: "Ukuran MP3 harus lebih dari 0 dan maksimal 10 MB." }, 400);
    }
    const bytes = await file.arrayBuffer();
    // Cek header MP3: ID3 atau frame sync 0xFF 0xFB / 0xFF 0xF3
    const head = new Uint8Array(bytes.slice(0, 3));
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    if (!isId3 && !isFrame) {
      return json({ success: false, message: "Isi file tidak sesuai dengan format MP3." }, 400);
    }

    const oldMusic = data.music;
    const key = `invitations/${invitation.id}/music/${crypto.randomUUID()}.mp3`;
    await env.MUSIC.put(key, bytes, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }
    });

    data.music = {
      mode: "upload",
      key,
      title: String(file.name || "musik.mp3").slice(0, 120),
      size: bytes.byteLength,
      type: "audio/mpeg"
    };

    try {
      await saveData(env, invitation, data);
    } catch (error) {
      await env.MUSIC.delete(key);
      throw error;
    }

    // Hapus MP3 unggahan lama setelah yang baru tersimpan.
    if (oldMusic && oldMusic.mode === "upload" && oldMusic.key &&
        oldMusic.key.startsWith(`invitations/${invitation.id}/music/`)) {
      await env.MUSIC.delete(oldMusic.key);
    }

    return json({
      success: true,
      message: "Musik MP3 berhasil diunggah dan dipilih.",
      music: data.music
    });
  } catch (error) {
    console.error("MUSIC UPLOAD ERROR:", error);
    return json({ success: false, message: error.message || "Gagal mengunggah musik." }, 500);
  }
}
