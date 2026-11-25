
const ITERATIONS = 100000;
const SESSION_DURATION = 7 * 24 * 60 * 60;

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function verifyPassword(password, storedHash) {
  const parts = storedHash.split("$");

  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    return false;
  }

  const iterations = Number(parts[1]);

  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > ITERATIONS
  ) {
    return false;
  }

  const salt = base64ToBytes(parts[2]);
  const expectedHash = base64ToBytes(parts[3]);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedHash = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      key,
      256
    )
  );

  if (derivedHash.length !== expectedHash.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < derivedHash.length; i++) {
    difference |= derivedHash[i] ^ expectedHash[i];
  }

  return difference === 0;
}

async function hashToken(token) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return Response.json(
        { success: false, message: "Database tidak tersedia." },
        { status: 500 }
      );
    }

    const data = await request.json();

    const email = String(data.email || "").trim().toLowerCase();
    const password = String(data.password || "");

    if (!email || !password) {
      return Response.json(
        {
          success: false,
          message: "Email dan password wajib diisi."
        },
        { status: 400 }
      );
    }

    const user = await env.DB.prepare(`
      SELECT id, full_name, email, password_hash, role, status
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
      .bind(email)
      .first();

    if (!user || user.status !== "active") {
      return Response.json(
        {
          success: false,
          message: "Email atau password salah."
        },
        { status: 401 }
      );
    }

    const passwordValid = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordValid) {
      return Response.json(
        {
          success: false,
          message: "Email atau password salah."
        },
        { status: 401 }
      );
    }

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = bytesToBase64Url(tokenBytes);
    const tokenHash = await hashToken(token);

    const sessionId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + SESSION_DURATION;

    await env.DB.prepare(`
      INSERT INTO sessions (
        id,
        user_id,
        token_hash,
        expires_at
      )
      VALUES (?, ?, ?, ?)
    `)
      .bind(
        sessionId,
        user.id,
        tokenHash,
        expiresAt
      )
      .run();

    const cookie = [
      `sahdong_session=${token}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${SESSION_DURATION}`
    ].join("; ");

    return Response.json(
      {
        success: true,
        message: "Login berhasil.",
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          role: user.role
        }
      },
      {
        status: 200,
        headers: {
          "Set-Cookie": cookie
        }
      }
    );

  } catch (error) {
    console.error("SAHDONG LOGIN ERROR:", error);

    return Response.json(
      {
        success: false,
        message: "Terjadi kesalahan pada server."
      },
      { status: 500 }
    );
  }
}
