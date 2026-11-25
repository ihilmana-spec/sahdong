
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

function jsonError(message, status, extra = {}) {
  return Response.json(
    {
      success: false,
      message,
      ...extra
    },
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

function parseDokuExpiredDate(value) {
  if (!value) return null;

  const dateString = String(value);

  if (!/^\d{14}$/.test(dateString)) {
    return null;
  }

  const formatted =
    dateString.slice(0, 4) + "-" +
    dateString.slice(4, 6) + "-" +
    dateString.slice(6, 8) + "T" +
    dateString.slice(8, 10) + ":" +
    dateString.slice(10, 12) + ":" +
    dateString.slice(12, 14) + "+07:00";

  const date = new Date(formatted);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function isValidCheckoutUrl(value, environment) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    if (
      url.hostname !== "doku.com" &&
      !url.hostname.endsWith(".doku.com")
    ) {
      return false;
    }

    if (
      environment === "sandbox" &&
      url.hostname !== "sandbox.doku.com"
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
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

    // Gunakan kembali halaman checkout jika masih berlaku.
    if (order.checkout_url && order.checkout_expired_at) {
      const expiry = new Date(order.checkout_expired_at);

      if (
        !Number.isNaN(expiry.getTime()) &&
        expiry.getTime() > Date.now() &&
        isValidCheckoutUrl(order.checkout_url, environment)
      ) {
        return Response.json({
          success: true,
          message: "Halaman pembayaran masih tersedia.",
          order_number: order.order_number,
          amount: order.amount,
          checkout_url: order.checkout_url,
          checkout_expired_at: order.checkout_expired_at
        });
      }
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

    // Menghubungi DOKU Sandbox atau Production.
    let dokuResponse;

    try {
      dokuResponse = await fetch(
        endpoint + requestTarget,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Client-Id": clientId,
            "Request-Id": requestId,
            "Request-Timestamp": timestamp,
            "Signature": signature
          },
          body: requestBody
        }
      );
    } catch (error) {
      console.error(
        "DOKU CONNECTION ERROR:",
        error.name,
        error.message
      );

      return jsonError(
        "Cloudflare gagal menghubungi server DOKU.",
        502,
        {
          diagnostic: "DOKU_FETCH_FAILED",
          error_name: error.name,
          error_message: error.message
        }
      );
    }

    const responseText = await dokuResponse.text();

    let dokuData;

    try {
      dokuData = JSON.parse(responseText);
    } catch {
      console.error(
        "DOKU INVALID RESPONSE:",
        dokuResponse.status,
        responseText.slice(0, 1000)
      );

      return jsonError(
        "Respons DOKU bukan JSON yang valid.",
        502,
        {
          diagnostic: "DOKU_INVALID_RESPONSE",
          doku_http_status: dokuResponse.status,
          content_type: dokuResponse.headers.get("content-type"),
          response_preview: responseText.slice(0, 1500)
        }
      );
    }

    if (!dokuResponse.ok) {
      console.error(
        "DOKU CHECKOUT ERROR:",
        dokuResponse.status,
        JSON.stringify(dokuData).slice(0, 1000)
      );

      return jsonError(
        "DOKU menolak permintaan pembuatan pembayaran.",
        502,
        {
          diagnostic: "DOKU_HTTP_ERROR",
          doku_http_status: dokuResponse.status,
          doku_response: dokuData
        }
      );
    }

    const paymentData = dokuData.response?.payment;
    const responseOrder = dokuData.response?.order;

    const checkoutUrl = paymentData?.url;
    const tokenId = paymentData?.token_id;

    const expiredAt = parseDokuExpiredDate(
      paymentData?.expired_date
    );

    if (
      !checkoutUrl ||
      !tokenId ||
      !expiredAt ||
      responseOrder?.invoice_number !== order.order_number ||
      Number(responseOrder?.amount) !== order.amount ||
      !isValidCheckoutUrl(checkoutUrl, environment)
    ) {
      console.error(
        "DOKU RESPONSE VALIDATION FAILED:",
        JSON.stringify(dokuData).slice(0, 1500)
      );

      return jsonError(
        "Respons pembayaran DOKU tidak memenuhi validasi SAHDONG.",
        502,
        {
          diagnostic: "DOKU_RESPONSE_VALIDATION_FAILED"
        }
      );
    }

    // Simpan informasi Checkout.
    // Status pembayaran tetap pending.
    const update = await env.DB.prepare(`
      UPDATE payments
      SET
        payment_gateway = 'DOKU',
        gateway_reference = ?,
        checkout_url = ?,
        checkout_expired_at = ?
      WHERE id = ?
        AND order_id = ?
        AND status = 'pending'
    `).bind(
      tokenId,
      checkoutUrl,
      expiredAt,
      order.payment_id,
      order.id
    ).run();

    if (update.meta.changes !== 1) {
      return jsonError(
        "Data pembayaran berubah. Silakan periksa pesanan.",
        409
      );
    }

    return Response.json({
      success: true,
      message: "Halaman pembayaran berhasil dibuat.",
      order_number: order.order_number,
      amount: order.amount,
      payment_gateway: "DOKU",
      payment_status: "pending",
      checkout_url: checkoutUrl,
      checkout_expired_at: expiredAt
    });

  } catch (error) {
    console.error("SAHDONG DOKU CREATE ERROR:", error);

    return jsonError(
      "Terjadi kesalahan saat membuat pembayaran.",
      500,
      {
        error_name: error.name,
        error_message: error.message
      }
    );
  }
}

export async function onRequestGet() {
  return Response.json({
    success: true,
    message: "Endpoint pembayaran SAHDONG aktif. Gunakan metode POST."
  }, { status: 405 });
}
