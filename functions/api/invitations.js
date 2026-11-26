
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

    if (name === "sahdong_session") return value;
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

function isValidTemplate(code) {
  return /^(BSC|PRM|EXC)-(0[1-9]|10)$/.test(code);
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
        {
          success: false,
          message: "Sesi tidak valid atau sudah kedaluwarsa."
        },
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
// POST: MEMBUAT UNDANGAN DRAFT
// ======================================

export async function onRequestPost({ request, env }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) return auth.error;

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, message: "Format JSON tidak valid." },
        { status: 400 }
      );
    }

    const templateCode = String(
      body.template_code || ""
    ).trim().toUpperCase();

    if (!isValidTemplate(templateCode)) {
      return Response.json(
        {
          success: false,
          message: "Kode template tidak valid. Silakan pilih dari katalog."
        },
        { status: 400 }
      );
    }

    const title = `Undangan ${templateCode}`;
    const invitationData = "{}";

    const invitationId = crypto.randomUUID();
    const baseSlug = createSlug(title);
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
      VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, 'draft')
    `).bind(
      invitationId,
      auth.user.id,
      title,
      slug,
      templateCode,
      invitationData
    ).run();

    return Response.json(
      {
        success: true,
        message: "Undangan draft berhasil dibuat.",
        invitation: {
          id: invitationId,
          title,
          slug,
          template_code: templateCode,
          activation_date: null,
          status: "draft",
          review_status: "draft",
          invitation_data: {}
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

    if (invitationId) {
      const invitation = await env.DB.prepare(`
        SELECT
          id,
          title,
          slug,
          template_code,
          invitation_data,
          activation_date,
          published_at,
          expires_at,
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
        invitationData = JSON.parse(
          invitation.invitation_data || "{}"
        );
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

    const result = await env.DB.prepare(`
      SELECT
        id,
        title,
        slug,
        template_code,
        activation_date,
        published_at,
        expires_at,
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
// PUT: MENYIMPAN PERUBAHAN UNDANGAN DRAFT
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

    // Periksa kepemilikan dan status undangan.
    const existing = await env.DB.prepare(`
      SELECT
        i.id,
        i.status,
        i.review_status,
        EXISTS (
          SELECT 1
          FROM orders o
          INNER JOIN payments p ON p.order_id = o.id
          WHERE o.invitation_id = i.id
            AND o.user_id = i.user_id
            AND o.status = 'paid'
            AND p.status = 'paid'
        ) AS payment_confirmed
      FROM invitations i
      WHERE i.id = ?
        AND i.user_id = ?
      LIMIT 1
    `).bind(invitationId, user.id).first();

    if (!existing) {
      return Response.json(
        { success: false, message: "Undangan tidak ditemukan." },
        { status: 404 }
      );
    }

    // Undangan yang sudah terbit tidak boleh diedit langsung.
    if (
      existing.status !== "draft" ||
      existing.review_status !== "draft"
    ) {
      return Response.json(
        {
          success: false,
          message: "Undangan sudah diterbitkan atau sedang dalam proses revisi. Silakan gunakan pengajuan revisi."
        },
        { status: 403 }
      );
    }

    // Pastikan pesanan dan pembayaran sudah lunas.
    if (!existing.payment_confirmed) {
      return Response.json(
        {
          success: false,
          message: "Pembayaran belum lunas. Data undangan belum dapat disimpan."
        },
        { status: 403 }
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
        {
          success: false,
          message: "Data undangan harus berupa objek JSON."
        },
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

    // Pengamanan ulang pada UPDATE untuk mencegah perubahan
    // jika status berubah setelah pemeriksaan awal.
    const result = await env.DB.prepare(`
      UPDATE invitations
      SET
        title = ?,
        invitation_data = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
        AND status = 'draft'
        AND review_status = 'draft'
        AND EXISTS (
          SELECT 1
          FROM orders o
          INNER JOIN payments p ON p.order_id = o.id
          WHERE o.invitation_id = invitations.id
            AND o.user_id = invitations.user_id
            AND o.status = 'paid'
            AND p.status = 'paid'
        )
    `).bind(
      title,
      invitationJson,
      invitationId,
      user.id
    ).run();

    if (!result.meta || result.meta.changes !== 1) {
      return Response.json(
        {
          success: false,
          message: "Data tidak dapat disimpan. Periksa status undangan dan pembayaran."
        },
        { status: 409 }
      );
    }

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
