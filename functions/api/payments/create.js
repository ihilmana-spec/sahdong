
function jsonResponse(data, status = 200) {
  return Response.json(data, { status });
}

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

async function sha256Base64(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return btoa(
    String.fromCharCode(...new Uint8Array(digest))
  );
}

async function createDokuSignature({
  clientId,
  secretKey,
  requestId,
  timestamp,
  requestTarget,
  body
}) {
  const digest = await sha256Base64(body);

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

  const encoded = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `HMACSHA256=${encoded}`;
}

function parseDokuExpiry(value) {
  if (!/^\d{14}$/.test(String(value || ""))) {
    return null;
  }

  const date = String(value);

  const iso =
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${date.slice(8, 10)}:${date.slice(10, 12)}:${date.slice(12, 14)}+07:00`;

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return jsonResponse({
        success: false,
        message: "Database tidak tersedia."
      }, 500);
    }

    if (!env.DOKU_CLIENT_ID || !env.DOKU_SECRET_KEY) {
      return jsonResponse({
        success: false,
        message: "Konfigurasi pembayaran belum tersedia."
      }, 500);
    }

    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonResponse({
        success: false,
        message: auth.error
      }, auth.status);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse({
        success: false,
        message: "Format JSON tidak valid."
      }, 400);
    }

    const orderId = String(body.order_id || "").trim();

    if (!orderId) {
      return jsonResponse({
        success: false,
        message: "ID pesanan wajib diisi."
      }, 400);
    }

    // Ambil pesanan milik pelanggan yang sedang login.
    const record = await env.DB.prepare(`
      SELECT
        o.id AS order_id,
        o.order_number,
        o.amount AS order_amount,
        o.status AS order_status,
        p.id AS payment_id,
        p.amount AS payment_amount,
        p.status AS payment_status,
        p.checkout_url,
        p.checkout_expired_at
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      WHERE o.id = ?
        AND o.user_id = ?
      LIMIT 1
    `).bind(orderId, auth.user.id).first();

    if (!record) {
      return jsonResponse({
        success: false,
        message: "Pesanan tidak ditemukan."
      }, 404);
    }

    if (
      record.order_status !== "pending" ||
      record.payment_status !== "pending"
    ) {
      return jsonResponse({
        success: false,
        message: "Pesanan tidak dalam status menunggu pembayaran."
      }, 409);
    }

    if (
      !Number.isInteger(record.order_amount) ||
      record.order_amount <= 0 ||
      record.order_amount !== record.payment_amount
    ) {
      return jsonResponse({
        success: false,
        message: "Nominal pembayaran tidak valid."
      }, 409);
    }

    // Gunakan checkout yang masih berlaku jika sudah pernah dibuat.
    if (record.checkout_url) {
      const expiry = record.checkout_expired_at
        ? new Date(record.checkout_expired_at).getTime()
        : 0;

      if (expiry > Date.now()) {
        return jsonResponse({
          success: true,
          message: "Halaman pembayaran tersedia.",
          payment: {
            checkout_url: record.checkout_url,
            expired_at: record.checkout_expired_at
          }
        });
      }

      return jsonResponse({
        success: false,
        message: "Halaman pembayaran sudah kedaluwarsa. Silakan hubungi admin."
      }, 409);
    }

    const clientId = env.DOKU_CLIENT_ID;
    const secretKey = env.DOKU_SECRET_KEY;

    const requestTarget = "/checkout/v1/payment";
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const requestBody = JSON.stringify({
      order: {
        amount: record.order_amount,
        invoice_number: record.order_number
      },
      payment: {
        payment_due_date: 60
      }
    });

    const signature = await createDokuSignature({
      clientId,
      secretKey,
      requestId,
      timestamp,
      requestTarget,
      body: requestBody
    });

    const dokuResponse = await fetch(
      `https://api.doku.com${requestTarget}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Client-Id": clientId,
          "Request-Id": requestId,
          "Request-Timestamp": timestamp,
          "Signature": signature
        },
        body: requestBody
      }
    );

    const dokuData = await dokuResponse.json().catch(() => null);

    if (!dokuResponse.ok) {
      console.error(
        "DOKU CREATE PAYMENT ERROR:",
        dokuResponse.status,
        JSON.stringify(dokuData).slice(0, 1000)
      );

      return jsonResponse({
        success: false,
        message: "DOKU belum dapat membuat transaksi pembayaran."
      }, 502);
    }

    const paymentData = dokuData?.response?.payment;

    const checkoutUrl = paymentData?.url;
    const tokenId = paymentData?.token_id;
    const expiredAt = parseDokuExpiry(paymentData?.expired_date);

    if (
      !checkoutUrl ||
      !tokenId ||
      !expiredAt ||
      new URL(checkoutUrl).protocol !== "https:"
    ) {
      console.error(
        "DOKU INVALID RESPONSE:",
        JSON.stringify(dokuData).slice(0, 1000)
      );

      return jsonResponse({
        success: false,
        message: "Respons pembayaran DOKU tidak lengkap."
      }, 502);
    }

    const update = await env.DB.prepare(`
      UPDATE payments
      SET
        payment_gateway = 'DOKU',
        gateway_reference = ?,
        checkout_url = ?,
        checkout_expired_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND checkout_url IS NULL
    `).bind(
      tokenId,
      checkoutUrl,
      expiredAt,
      record.payment_id
    ).run();

    if (!update.meta || update.meta.changes !== 1) {
      return jsonResponse({
        success: false,
        message: "Data pembayaran berubah. Periksa status pesanan."
      }, 409);
    }

    return jsonResponse({
      success: true,
      message: "Halaman pembayaran berhasil dibuat.",
      payment: {
        gateway: "DOKU",
        checkout_url: checkoutUrl,
        expired_at: expiredAt
      }
    });

  } catch (error) {
    console.error("SAHDONG DOKU CREATE ERROR:", error);

    return jsonResponse({
      success: false,
      message: "Terjadi kesalahan pada server."
    }, 500);
  }
}
