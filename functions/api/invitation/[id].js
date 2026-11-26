
async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonError(message, status) {
  return Response.json(
    { success: false, message },
    { status }
  );
}

async function authenticateCustomer(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)sahdong_session=([^;]+)/);

  if (!match) {
    return { error: "Belum login.", status: 401 };
  }

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
    return {
      error: "Sesi tidak valid atau sudah kedaluwarsa.",
      status: 401
    };
  }

  if (session.role !== "customer") {
    return {
      error: "Akses hanya untuk pelanggan.",
      status: 403
    };
  }

  return { user: session };
}

// MENGAMBIL DETAIL UNDANGAN
export async function onRequestGet({ request, env, params }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    const invitationId = params.id;

    if (!invitationId) {
      return jsonError("ID undangan wajib diisi.", 400);
    }

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
    `).bind(invitationId, auth.user.id).first();

    if (!invitation) {
      return jsonError("Undangan tidak ditemukan.", 404);
    }

    let invitationData = {};

    try {
      invitationData = JSON.parse(
        invitation.invitation_data || "{}"
      );
    } catch {
      return jsonError(
        "Data undangan tidak dapat dibaca.",
        500
      );
    }

    return Response.json({
      success: true,
      message: "Detail undangan berhasil diambil.",
      invitation: {
        ...invitation,
        invitation_data: invitationData
      }
    });

  } catch (error) {
    console.error("SAHDONG INVITATION GET ERROR:", error);

    return jsonError(
      "Terjadi kesalahan pada server.",
      500
    );
  }
}

// MENYIMPAN DATA UNDANGAN
export async function onRequestPut({ request, env, params }) {
  try {
    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    const invitationId = params.id;

    if (!invitationId) {
      return jsonError("ID undangan wajib diisi.", 400);
    }

    // Ambil undangan milik pelanggan beserta status pembayaran.
    const invitation = await env.DB.prepare(`
      SELECT
        i.*,
        o.status AS order_status,
        p.status AS payment_status
      FROM invitations i
      LEFT JOIN orders o
        ON o.invitation_id = i.id
       AND o.user_id = i.user_id
      LEFT JOIN payments p
        ON p.order_id = o.id
      WHERE i.id = ?
        AND i.user_id = ?
      ORDER BY o.created_at DESC
      LIMIT 1
    `).bind(invitationId, auth.user.id).first();

    if (!invitation) {
      return jsonError("Undangan tidak ditemukan.", 404);
    }

    // Editor hanya untuk undangan yang belum diterbitkan.
    if (invitation.status !== "draft") {
      return jsonError(
        "Undangan sudah diterbitkan. Perubahan harus diajukan melalui fitur revisi.",
        403
      );
    }

    if (invitation.review_status !== "draft") {
      return jsonError(
        "Undangan sedang dalam proses pemeriksaan atau revisi.",
        403
      );
    }

    // Pastikan pesanan dan pembayaran sudah lunas.
    if (
      invitation.order_status !== "paid" ||
      invitation.payment_status !== "paid"
    ) {
      return jsonError(
        "Undangan hanya dapat diedit setelah pembayaran terkonfirmasi lunas.",
        403
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonError("Format JSON tidak valid.", 400);
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return jsonError("Format data tidak valid.", 400);
    }

    // Judul boleh diperbarui.
    let title = invitation.title;

    if (body.title !== undefined) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 150
      ) {
        return jsonError(
          "Judul wajib diisi dan maksimal 150 karakter.",
          400
        );
      }

      title = body.title.trim();
    }

    // Template dan tanggal aktivasi tidak dapat diubah dari editor.
    let invitationData = {};

    try {
      invitationData = JSON.parse(
        invitation.invitation_data || "{}"
      );
    } catch {
      return jsonError(
        "Data undangan lama tidak dapat dibaca.",
        500
      );
    }

    if (body.invitation_data !== undefined) {
      if (
        !body.invitation_data ||
        typeof body.invitation_data !== "object" ||
        Array.isArray(body.invitation_data)
      ) {
        return jsonError(
          "invitation_data harus berupa objek.",
          400
        );
      }

      invitationData = {
        ...invitationData,
        ...body.invitation_data
      };
    }

    const invitationDataJson = JSON.stringify(invitationData);

    if (invitationDataJson.length > 100000) {
      return jsonError(
        "Data undangan terlalu besar.",
        400
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
        AND status = 'draft'
        AND review_status = 'draft'
    `).bind(
      title,
      invitationDataJson,
      invitationId,
      auth.user.id
    ).run();

    const updated = await env.DB.prepare(`
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
        updated_at,
        invitation_data
      FROM invitations
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(invitationId, auth.user.id).first();

    return Response.json({
      success: true,
      message: "Data undangan berhasil disimpan.",
      invitation: {
        ...updated,
        invitation_data: JSON.parse(
          updated.invitation_data || "{}"
        )
      }
    });

  } catch (error) {
    console.error("SAHDONG INVITATION UPDATE ERROR:", error);

    return jsonError(
      "Terjadi kesalahan pada server.",
      500
    );
  }
}
