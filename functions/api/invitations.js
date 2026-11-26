
async function hashToken(token) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
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

function createSlug(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function authenticateCustomer(request, env) {
  if (!env.DB) {
    return {
      error: Response.json(
        { success: false, message: "Database tidak tersedia." },
        { status: 500 }
      )
    };
  }

  const token = getSessionCookie(request);

  if (!token) {
    return {
      error: Response.json(
        { success: false, message: "Belum login." },
        { status: 401 }
      )
    };
  }

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

  if (!user || user.status !== "active") {
    return {
      error: Response.json(
        { success: false, message: "Sesi tidak valid atau sudah kedaluwarsa." },
        { status: 401 }
      )
    };
  }

  if (user.role !== "customer") {
    return {
      error: Response.json(
        { success: false, message: "Akses hanya untuk pelanggan." },
        { status: 403 }
      )
    };
  }

  return { user };
}

// ======================================
// POST: MEMBUAT UNDANGAN BARU
// ======================================

export async function onRequestPost({ request, env }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) return auth.error;

    const user = auth.user;

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, message: "Format JSON tidak valid." },
        { status: 400 }
      );
    }

    const title = String(body.title || "").trim();
    const templateCode = String(body.template_code || "").trim();
    const activationDate = String(body.activation_date || "").trim();

    if (!title || !templateCode || !activationDate) {
      return Response.json(
        {
          success: false,
          message: "Judul, template, dan tanggal aktivasi wajib diisi."
        },
        { status: 400 }
      );
    }

    if (title.length > 150 || templateCode.length > 50) {
      return Response.json(
        { success: false, message: "Judul atau kode template terlalu panjang." },
        { status: 400 }
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(activationDate)) {
      return Response.json(
        { success: false, message: "Format tanggal aktivasi harus YYYY-MM-DD." },
        { status: 400 }
      );
    }

    const parsedDate = new Date(`${activationDate}T00:00:00.000Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== activationDate
    ) {
      return Response.json(
        { success: false, message: "Tanggal aktivasi tidak valid." },
        { status: 400 }
      );
    }

    const invitationData =
      body.invitation_data === undefined ? {} : body.invitation_data;

    if (
      invitationData === null ||
      typeof invitationData !== "object" ||
      Array.isArray(invitationData)
    ) {
      return Response.json(
        { success: false, message: "Data undangan harus berupa objek JSON." },
        { status: 400 }
      );
    }

    const invitationJson = JSON.stringify(invitationData);

    if (invitationJson.length > 100000) {
      return Response.json(
        { success: false, message: "Data undangan terlalu besar." },
        { status: 400 }
      );
    }

    const invitationId = crypto.randomUUID();
    const baseSlug = createSlug(title);

    if (!baseSlug) {
      return Response.json(
        {
          success: false,
          message: "Judul tidak dapat digunakan untuk membuat slug."
        },
        { status: 400 }
      );
    }

    const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;

    await env.DB.prepare(`
      INSERT INTO invitations (
        id,
        user_id,
        title,
        slug,
        template_code,
        invitation_data,
        status,
        activation_date,
        review_status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 'draft')
    `).bind(
      invitationId,
      user.id,
      title,
      slug,
      templateCode,
      invitationJson,
      activationDate
    ).run();

    return Response.json(
      {
        success: true,
        message: "Undangan berhasil dibuat sebagai draft.",
        invitation: {
          id: invitationId,
          title,
          slug,
          template_code: templateCode,
          activation_date: activationDate,
          status: "draft",
          review_status: "draft"
        }
      },
      { status: 201 }
    );

  } catch (error) {
    console.error("SAHDONG INVITATIONS CREATE ERROR:", error);

    return Response.json(
      { success: false, message: "Terjadi kesalahan pada server." },
      { status: 500 }
    );
  }
}

// ======================================
// GET: DAFTAR ATAU DETAIL UNDANGAN
// ======================================

export async function onRequestGet({ request, env }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) return auth.error;

    const user = auth.user;
    const url = new URL(request.url);
    const invitationId = url.searchParams.get("id");

    // Jika ID tersedia, ambil detail satu undangan
    if (invitationId) {
      const invitation = await env.DB.prepare(`
        SELECT
          id,
          title,
          slug,
          template_code,
          invitation_data,
          activation_date,
          status,
          review_status,
          created_at,
          updated_at
        FROM invitations
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `).bind(invitationId, user.id).first();

      if (!invitation) {
        return Response.json(
          { success: false, message: "Undangan tidak ditemukan." },
          { status: 404 }
        );
      }

      let invitationData = {};

      try {
        invitationData = JSON.parse(invitation.invitation_data || "{}");
      } catch {
        invitationData = {};
      }

      return Response.json({
        success: true,
        invitation: {
          ...invitation,
          invitation_data: invitationData
        }
      });
    }

    // Jika tidak ada ID, tampilkan seluruh undangan pelanggan
    const result = await env.DB.prepare(`
      SELECT
        id,
        title,
        slug,
        template_code,
        activation_date,
        status,
        review_status,
        created_at,
        updated_at
      FROM invitations
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).bind(user.id).all();

    return Response.json({
      success: true,
      message: "Daftar undangan berhasil diambil.",
      total: result.results.length,
      invitations: result.results
    });

  } catch (error) {
    console.error("SAHDONG INVITATIONS GET ERROR:", error);

    return Response.json(
      { success: false, message: "Terjadi kesalahan pada server." },
      { status: 500 }
    );
  }
}

// ======================================
// PUT: MENYIMPAN PERUBAHAN UNDANGAN
// ======================================

export async function onRequestPut({ request, env }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) return auth.error;

    const user = auth.user;
    const url = new URL(request.url);
    const invitationId = url.searchParams.get("id");

    if (!invitationId) {
      return Response.json(
        { success: false, message: "ID undangan wajib diisi." },
        { status: 400 }
      );
    }

    const existing = await env.DB.prepare(`
      SELECT id
      FROM invitations
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(invitationId, user.id).first();

    if (!existing) {
      return Response.json(
        { success: false, message: "Undangan tidak ditemukan." },
        { status: 404 }
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, message: "Format JSON tidak valid." },
        { status: 400 }
      );
    }

    const title = String(body.title || "").trim();
    const invitationData = body.invitation_data;

    if (!title || title.length > 150) {
      return Response.json(
        {
          success: false,
          message: "Judul wajib diisi dan maksimal 150 karakter."
        },
        { status: 400 }
      );
    }

    if (
      invitationData === null ||
      typeof invitationData !== "object" ||
      Array.isArray(invitationData)
    ) {
      return Response.json(
        { success: false, message: "Data undangan harus berupa objek JSON." },
        { status: 400 }
      );
    }

    const invitationJson = JSON.stringify(invitationData);

    if (invitationJson.length > 100000) {
      return Response.json(
        { success: false, message: "Data undangan terlalu besar." },
        { status: 400 }
      );
    }

    await env.DB.prepare(`
      UPDATE invitations
      SET
        title = ?,
        invitation_data = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
    `).bind(
      title,
      invitationJson,
      invitationId,
      user.id
    ).run();

    return Response.json({
      success: true,
      message: "Perubahan undangan berhasil disimpan."
    });

  } catch (error) {
    console.error("SAHDONG INVITATION UPDATE ERROR:", error);

    return Response.json(
      { success: false, message: "Terjadi kesalahan pada server." },
      { status: 500 }
    );
  }
}
