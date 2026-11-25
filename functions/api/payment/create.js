
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

async function authenticateCustomer(request, env) {
  const token = getSessionCookie(request);

  if (!token) {
    return { error: "Belum login.", status: 401 };
  }

  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  const user = await env.DB.prepare(`
    SELECT users.id, users.role, users.status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  if (!user || user.status !== "active") {
    return {
      error: "Session tidak valid atau sudah kedaluwarsa.",
      status: 401
    };
  }

  if (user.role !== "customer") {
    return {
      error: "Akses hanya untuk pelanggan.",
      status: 403
    };
  }

  return { user };
}

function jsonError(message, status) {
  return Response.json(
    { success: false, message },
    { status }
  );
}

function toBase64(bytes) {
  return btoa(
    String.fromCharCode(...new Uint8Array(bytes))
  );
}

async function createDigest(body) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  );

  return toBase64(hash);
}

async function createSignature(
  clientId,
  secretKey,
  requestId,
  timestamp,
  requestTarget,
  digest
) {
  const component = [
    `Client-Id:${clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${requestTarget}`,
    `Digest:${digest}`
  ].join("\n");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(component)
  );

  return `HMACSHA256=${toBase64(signature)}`;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return jsonError("Database tidak tersedia.", 500);
    }

    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    const clientId = env.DOKU_CLIENT_ID;
    const secretKey = env.DOKU_SECRET_KEY;
    const environment = String(env.DOKU_ENV || "").toLowerCase();

    if (!clientId || !secretKey) {
      return jsonError(
        "Konfigurasi kredensial DOKU belum lengkap.",
        500
      );
    }

    if (!["sandbox", "production"].includes(environment)) {
      return jsonError(
        "Lingkungan DOKU tidak valid.",
        500
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonError("Format JSON tidak valid.", 400);
    }

    const orderId = String(body.order_id || "").trim();

    if (!orderId) {
      return jsonError("ID pesanan wajib diisi.", 400);
    }

    const order = await env.DB.prepare(`
      SELECT
        o.id,
        o.order_number,
        o.amount,
        o.status AS order_status,
        p.id AS payment_id,
        p.status AS payment_status,
        p.checkout_url,
        p.checkout_expired_at
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      WHERE o.id = ?
        AND o.user_id = ?
      ORDER BY p.created_at DESC
      LIMIT 1
    `).bind(orderId, auth.user.id).first();

    if (!order) {
      return jsonError("Pesanan tidak ditemukan.", 404);
    }

    if (
      order.order_status !== "pending" ||
      order.payment_status !== "pending"
    ) {
      return jsonError(
        "Pesanan tidak dapat dibayar dengan status saat ini.",
        400
      );
    }

    if (
      !Number.isInteger(order.amount) ||
      order.amount <= 0
    ) {
      return jsonError("Nominal pesanan tidak valid.", 400);
    }

    const requestTarget = "/checkout/v1/payment";

    const endpoint = environment === "production"
      ? "https://api.doku.com"
      : "https://api-sandbox.doku.com";

    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const requestBody = JSON.stringify({
      order: {
        amount: order.amount,
        invoice_number: order.order_number
      },
      payment: {
        payment_due_date: 60
      }
    });

    const digest = await createDigest(requestBody);

    const signature = await createSignature(
      clientId,
      secretKey,
      requestId,
      timestamp,
      requestTarget,
      digest
    );

    // TES CHECKPOINT:
    // Berhenti sebelum mengirim request ke DOKU.
    return Response.json({
      success: true,
      checkpoint: "BEFORE_DOKU_REQUEST",
      message: "Proses sebelum menghubungi DOKU berhasil.",
      order_number: order.order_number,
      amount: order.amount,
      environment: environment,
      endpoint: endpoint,
      request_target: requestTarget,
      signature_created: Boolean(signature),
      request_id_created: Boolean(requestId)
    });

  } catch (error) {
    console.error("SAHDONG PAYMENT CHECK ERROR:", error);

    return jsonError(
      "Terjadi kesalahan saat pemeriksaan pembayaran.",
      500
    );
  }
}

export async function onRequestGet() {
  return Response.json({
    success: true,
    message: "Endpoint pembayaran SAHDONG aktif. Gunakan metode POST."
  }, { status: 405 });
}
