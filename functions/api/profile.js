
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

async function getAuthenticatedUser(request, env) {
  const token = getSessionCookie(request);

  if (!token) {
    return null;
  }

  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  return await env.DB.prepare(`
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
}

// GET: Melihat profil
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

    const user = await getAuthenticatedUser(request, env);

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
      user
    });

  } catch (error) {
    console.error("SAHDONG PROFILE GET ERROR:", error);

    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}

// PUT: Mengubah profil
export async function onRequestPut({ request, env }) {
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

    const user = await getAuthenticatedUser(request, env);

    if (!user || user.status !== "active") {
      return Response.json(
        {
          success: false,
          message: "Session tidak valid atau sudah kedaluwarsa."
        },
        { status: 401 }
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          success: false,
          message: "Format JSON tidak valid."
        },
        { status: 400 }
      );
    }

    const fullName = String(body.full_name || "").trim();
    const phone = String(body.phone || "").trim();

    if (!fullName || !phone) {
      return Response.json(
        {
          success: false,
          message: "Nama lengkap dan nomor HP wajib diisi."
        },
        { status: 400 }
      );
    }

    if (fullName.length > 100) {
      return Response.json(
        {
          success: false,
          message: "Nama lengkap maksimal 100 karakter."
        },
        { status: 400 }
      );
    }

    if (phone.length > 20) {
      return Response.json(
        {
          success: false,
          message: "Nomor HP maksimal 20 karakter."
        },
        { status: 400 }
      );
    }

    await env.DB.prepare(`
      UPDATE users
      SET
        full_name = ?,
        phone = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(fullName, phone, user.id)
      .run();

    const updatedUser = await env.DB.prepare(`
      SELECT
        id,
        full_name,
        email,
        phone,
        role,
        status,
        created_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `)
      .bind(user.id)
      .first();

    return Response.json({
      success: true,
      message: "Profil berhasil diperbarui.",
      user: updatedUser
    });

  } catch (error) {
    console.error("SAHDONG PROFILE PUT ERROR:", error);

    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}
