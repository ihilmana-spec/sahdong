
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

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return Response.json(
        {
          success: false,
          message: "Database tidak tersedia."
        },
        { status: 500 }
      );
    }

    const token = getSessionCookie(request);

    if (!token) {
      return Response.json(
        {
          success: false,
          message: "Belum login."
        },
        { status: 401 }
      );
    }

    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const user = await env.DB.prepare(`
      SELECT
        users.id,
        users.full_name,
        users.email,
        users.phone,
        users.role,
        users.status,
        users.created_at
      FROM sessions
      INNER JOIN users
        ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
      LIMIT 1
    `)
      .bind(tokenHash, now)
      .first();

    if (!user || user.status !== "active") {
      return Response.json(
        {
          success: false,
          message: "Session tidak valid atau sudah kedaluwarsa."
        },
        { status: 401 }
      );
    }

    return Response.json({
      success: true,
      message: "Profil berhasil diambil.",
      user: user
    });

  } catch (error) {
    console.error("SAHDONG PROFILE ERROR:", error);

    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}
