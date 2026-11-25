
async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);

  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestGet({ request, env, params }) {
  try {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/(?:^|;\s*)sahdong_session=([^;]+)/);

    if (!match) {
      return Response.json(
        { success: false, message: "Belum login." },
        { status: 401 }
      );
    }

    const tokenHash = await hashToken(match[1]);
    const now = Math.floor(Date.now() / 1000);

    const session = await env.DB.prepare(`
      SELECT
        users.id,
        users.role,
        users.status
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
      LIMIT 1
    `).bind(tokenHash, now).first();

    if (!session || session.status !== "active") {
      return Response.json(
        {
          success: false,
          message: "Sesi tidak valid atau sudah kedaluwarsa."
        },
        { status: 401 }
      );
    }

    if (session.role !== "customer") {
      return Response.json(
        { success: false, message: "Akses hanya untuk pelanggan." },
        { status: 403 }
      );
    }

    const invitationId = params.id;

    if (!invitationId) {
      return Response.json(
        { success: false, message: "ID undangan wajib diisi." },
        { status: 400 }
      );
    }

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
    `).bind(invitationId, session.id).first();

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
      message: "Detail undangan berhasil diambil.",
      invitation: {
        id: invitation.id,
        title: invitation.title,
        slug: invitation.slug,
        template_code: invitation.template_code,
        activation_date: invitation.activation_date,
        status: invitation.status,
        review_status: invitation.review_status,
        created_at: invitation.created_at,
        updated_at: invitation.updated_at,
        invitation_data: invitationData
      }
    });

  } catch (error) {
    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}

export async function onRequestPut({ request, env, params }) {
  try {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/(?:^|;\s*)sahdong_session=([^;]+)/);

    if (!match) {
      return Response.json(
        { success: false, message: "Belum login." },
        { status: 401 }
      );
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
      return Response.json(
        { success: false, message: "Sesi tidak valid atau sudah kedaluwarsa." },
        { status: 401 }
      );
    }

    if (session.role !== "customer") {
      return Response.json(
        { success: false, message: "Akses hanya untuk pelanggan." },
        { status: 403 }
      );
    }

    const invitationId = params.id;

    if (!invitationId) {
      return Response.json(
        { success: false, message: "ID undangan wajib diisi." },
        { status: 400 }
      );
    }

    const invitation = await env.DB.prepare(`
      SELECT *
      FROM invitations
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).bind(invitationId, session.id).first();

    if (!invitation) {
      return Response.json(
        { success: false, message: "Undangan tidak ditemukan." },
        { status: 404 }
      );
    }

    if (
      invitation.status !== "draft" ||
      !["draft", "revision"].includes(invitation.review_status)
    ) {
      return Response.json(
        {
          success: false,
          message: "Undangan tidak dapat diedit karena sedang atau sudah diproses admin."
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { success: false, message: "Format data tidak valid." },
        { status: 400 }
      );
    }

    let title = invitation.title;
    let templateCode = invitation.template_code;
    let activationDate = invitation.activation_date;

    if (body.title !== undefined) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 150
      ) {
        return Response.json(
          { success: false, message: "Judul wajib diisi dan maksimal 150 karakter." },
          { status: 400 }
        );
      }

      title = body.title.trim();
    }

    if (body.template_code !== undefined) {
      if (
        typeof body.template_code !== "string" ||
        !body.template_code.trim() ||
        body.template_code.trim().length > 100
      ) {
        return Response.json(
          { success: false, message: "Kode template tidak valid." },
          { status: 400 }
        );
      }

      templateCode = body.template_code.trim();
    }

    if (body.activation_date !== undefined) {
      const date = body.activation_date;

      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        new Date(date + "T00:00:00.000Z").toISOString().slice(0, 10) !== date
      ) {
        return Response.json(
          { success: false, message: "Format tanggal aktivasi harus YYYY-MM-DD." },
          { status: 400 }
        );
      }

      activationDate = date;
    }

    let invitationData = {};

    try {
      invitationData = JSON.parse(invitation.invitation_data || "{}");
    } catch {
      return Response.json(
        { success: false, message: "Data undangan lama tidak dapat dibaca." },
        { status: 500 }
      );
    }

    if (body.invitation_data !== undefined) {
      if (
        !body.invitation_data ||
        typeof body.invitation_data !== "object" ||
        Array.isArray(body.invitation_data)
      ) {
        return Response.json(
          { success: false, message: "invitation_data harus berupa objek." },
          { status: 400 }
        );
      }

      invitationData = {
        ...invitationData,
        ...body.invitation_data
      };
    }

    const invitationDataJson = JSON.stringify(invitationData);

    if (invitationDataJson.length > 100000) {
      return Response.json(
        { success: false, message: "Data undangan terlalu besar." },
        { status: 400 }
      );
    }

    await env.DB.prepare(`
      UPDATE invitations
      SET
        title = ?,
        template_code = ?,
        activation_date = ?,
        invitation_data = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).bind(
      title,
      templateCode,
      activationDate,
      invitationDataJson,
      invitationId,
      session.id
    ).run();

    const updated = await env.DB.prepare(`
      SELECT
        id,
        title,
        slug,
        template_code,
        activation_date,
        status,
        review_status,
        created_at,
        updated_at,
        invitation_data
      FROM invitations
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).bind(invitationId, session.id).first();

    return Response.json({
      success: true,
      message: "Undangan berhasil diperbarui.",
      invitation: {
        ...updated,
        invitation_data: JSON.parse(updated.invitation_data || "{}")
      }
    });

  } catch (error) {
    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}
