
function jsonResponse(data, status = 200) {
  return Response.json(data, { status });
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

async function hashToken(token) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function createDokuSignature(
  clientId,
  requestId,
  timestamp,
  requestTarget,
  body,
  secretKey
) {
  const encoder = new TextEncoder();

  const digestBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(body)
  );

  const digest = bytesToBase64(
    new Uint8Array(digestBuffer)
  );

  const component = [
    `Client-Id:${clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${requestTarget}`,
    `Digest:${digest}`
  ].join("\n");

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(component)
  );

  return "HMACSHA256=" + bytesToBase64(
    new Uint8Array(signatureBuffer)
  );
}

function parseDokuExpiry(value) {
  if (!/^\d{14}$/.test(String(value || ""))) {
    return null;
  }

  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(8, 10);
  const minute = value.slice(10, 12);
  const second = value.slice(12, 14);

  return new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`
  ).getTime();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return jsonResponse({
        success: false,
        message: "Database tidak tersedia."
      }, 500);
    }

    const clientId = env.DOKU_CLIENT_ID;
    const secretKey = env.DOKU_SECRET_KEY;

    if (!clientId || !secretKey) {
      return jsonResponse({
        success: false,
        message: "Konfigurasi DOKU belum tersedia."
      }, 500);
    }

    // 1. Validasi sesi pelanggan
    const token = getSessionCookie(request);

    if (!token) {
      return jsonResponse({
        success: false,
        message: "Silakan login terlebih dahulu."
      }, 401);
    }

    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const session = await env.DB.prepare(`
      SELECT
        sessions.user_id,
        users.full_name,
        users.email,
        users.status,
        users.role
      FROM sessions
      INNER JOIN users
        ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
      LIMIT 1
    `)
      .bind(tokenHash, now)
      .first();

    if (!session || session.status !== "active") {
      return jsonResponse({
        success: false,
        message: "Sesi tidak valid atau sudah kedaluwarsa."
      }, 401);
    }

    if (session.role !== "customer") {
      return jsonResponse({
        success: false,
        message: "Akun ini tidak dapat membuat pembayaran pelanggan."
      }, 403);
    }

    // 2. Ambil ID pesanan
    const data = await request.json();
    const orderId = String(data.order_id || "").trim();

    if (!orderId) {
      return jsonResponse({
        success: false,
        message: "ID pesanan wajib diisi."
      }, 400);
    }

    // 3. Ambil data pesanan langsung dari database
    const record = await env.DB.prepare(`
      SELECT
        orders.id AS order_id,
        orders.order_number,
        orders.amount AS order_amount,
        orders.status AS order_status,

        payments.id AS payment_id,
        payments.amount AS payment_amount,
        payments.status AS payment_status,
        payments.checkout_url,
        payments.checkout_token,
        payments.checkout_expired_at

      FROM orders

      INNER JOIN payments
        ON payments.order_id = orders.id

      WHERE orders.id = ?
        AND orders.user_id = ?

      ORDER BY payments.created_at DESC
      LIMIT 1
    `)
      .bind(orderId, session.user_id)
      .first();

    if (!record) {
      return jsonResponse({
        success: false,
        message: "Pesanan tidak ditemukan."
      }, 404);
    }

    // 4. Pastikan nominal pembayaran sesuai
    if (
      Number(record.order_amount) <= 0 ||
      Number(record.order_amount) !== Number(record.payment_amount)
    ) {
      return jsonResponse({
        success: false,
        message: "Nominal pesanan dan pembayaran tidak sesuai."
      }, 409);
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

    // 5. Gunakan checkout yang masih berlaku jika tersedia
    const existingExpiry = parseDokuExpiry(
      record.checkout_expired_at
    );

    if (
      record.checkout_url &&
      existingExpiry &&
      existingExpiry > Date.now()
    ) {
      return jsonResponse({
        success: true,
        message: "Checkout pembayaran masih tersedia.",
        checkout_url: record.checkout_url,
        expires_at: record.checkout_expired_at,
        reused: true
      });
    }

    // 6. Siapkan request DOKU
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString()
      .replace(/\.\d{3}Z$/, "Z");

    const requestTarget = "/checkout/v1/payment";

    const payload = {
      order: {
        amount: Number(record.order_amount),
        invoice_number: record.order_number,
        currency: "IDR",
        language: "ID",
        callback_url: "https://sahdong.my.id/dashboard.html"
      },
      payment: {
        payment_due_date: 60
      },
      customer: {
        id: session.user_id,
        name: session.full_name,
        email: session.email,
        country: "ID"
      }
    };

    const body = JSON.stringify(payload);

    const signature = await createDokuSignature(
      clientId,
      requestId,
      timestamp,
      requestTarget,
      body,
      secretKey
    );

    // 7. Kirim request ke DOKU Sandbox
    const dokuResponse = await fetch(
      "https://api-sandbox.doku.com/checkout/v1/payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Client-Id": clientId,
          "Request-Id": requestId,
          "Request-Timestamp": timestamp,
          "Signature": signature
        },
        body
      }
    );

    const responseText = await dokuResponse.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      console.error("DOKU returned invalid JSON:", responseText);

      return jsonResponse({
        success: false,
        message: "Respons DOKU tidak dapat dibaca."
      }, 502);
    }

    if (!dokuResponse.ok) {
      console.error("DOKU API ERROR:", {
        status: dokuResponse.status,
        response: result
      });

      return jsonResponse({
        success: false,
        message: "DOKU menolak permintaan pembayaran.",
        doku_status: dokuResponse.status,
        doku_error: result.error_messages || result.message || null
      }, 502);
    }

    // 8. Ambil hasil checkout
    const payment = result.response?.payment;
    const checkoutUrl = payment?.url;
    const checkoutToken = payment?.token_id;
    const expiredAt = payment?.expired_date;

    if (!checkoutUrl || !checkoutToken || !expiredAt) {
      console.error("DOKU response incomplete:", result);

      return jsonResponse({
        success: false,
        message: "Data checkout dari DOKU tidak lengkap."
      }, 502);
    }

    // 9. Simpan data checkout di D1
    await env.DB.prepare(`
      UPDATE payments
      SET
        payment_gateway = 'doku',
        gateway_reference = ?,
        checkout_url = ?,
        checkout_token = ?,
        checkout_expired_at = ?,
        gateway_request_id = ?
      WHERE id = ?
        AND status = 'pending'
    `)
      .bind(
        String(result.response?.uuid || ""),
        checkoutUrl,
        checkoutToken,
        expiredAt,
        requestId,
        record.payment_id
      )
      .run();

    // 10. Kembalikan URL checkout ke pelanggan
    return jsonResponse({
      success: true,
      message: "Checkout DOKU berhasil dibuat.",
      order_number: record.order_number,
      amount: Number(record.order_amount),
      checkout_url: checkoutUrl,
      expires_at: expiredAt
    }, 201);

  } catch (error) {
    console.error("SAHDONG DOKU CREATE PAYMENT ERROR:", error);

    return jsonResponse({
      success: false,
      message: "Terjadi kesalahan saat membuat pembayaran."
    }, 500);
  }
}
