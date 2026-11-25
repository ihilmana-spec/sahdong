
export async function onRequestPost({ request, env }) {
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

    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = cookieHeader.split(";");

    let token = null;

    for (const cookie of cookies) {
      const separator = cookie.indexOf("=");

      if (separator === -1) continue;

      const name = cookie.slice(0, separator).trim();
      const value = cookie.slice(separator + 1).trim();

      if (name === "sahdong_session") {
        token = value;
        break;
      }
    }

    if (token) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
      );

      const tokenHash = Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

      await env.DB.prepare(
        "DELETE FROM sessions WHERE token_hash = ?"
      )
        .bind(tokenHash)
        .run();
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Logout berhasil."
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "sahdong_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
        }
      }
    );

  } catch (error) {
    console.error("SAHDONG LOGOUT ERROR:", error);

    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}
