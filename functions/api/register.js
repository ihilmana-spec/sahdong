
const ITERATIONS = 310000;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  const toBase64 = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)));

  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
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

    const fullName = String(data.full_name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");

    if (!fullName || !email || !password) {
      return Response.json(
        { success: false, message: "Nama, email, dan password wajib diisi." },
        { status: 400 }
      );
    }

    if (fullName.length > 100 || phone.length > 20) {
      return Response.json(
        { success: false, message: "Data yang dimasukkan terlalu panjang." },
        { status: 400 }
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return Response.json(
        { success: false, message: "Format email tidak valid." },
        { status: 400 }
      );
    }

    if (password.length < 8 || password.length > 128) {
      return Response.json(
        { success: false, message: "Password harus 8–128 karakter." },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO users (
        id,
        full_name,
        email,
        phone,
        password_hash,
        role,
        status
      )
      VALUES (?, ?, ?, ?, ?, 'customer', 'active')
    `)
      .bind(
        userId,
        fullName,
        email,
        phone || null,
        passwordHash
      )
      .run();

    return Response.json(
      {
        success: true,
        message: "Registrasi berhasil.",
        user: {
          id: userId,
          full_name: fullName,
          email,
          role: "customer"
        }
      },
      { status: 201 }
    );

  } catch (error) {
    console.error("SAHDONG REGISTER ERROR:", error);

    if (error.message?.includes("UNIQUE constraint failed")) {
      return Response.json(
        { success: false, message: "Email sudah terdaftar." },
        { status: 409 }
      );
    }

    return Response.json(
  {
    success: false,
    message: "Terjadi kesalahan pada server.",
    debug: error.message || String(error)
  },
  { status: 500 }
);
