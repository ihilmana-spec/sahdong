
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
