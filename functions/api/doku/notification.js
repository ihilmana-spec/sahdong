
function jsonResponse(data, status = 200) {
  return Response.json(data, { status });
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

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
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
        message: "Konfigurasi DOKU tidak tersedia."
      }, 500);
    }

    // 1. Ambil header notifikasi DOKU
    const receivedClientId = request.headers.get("Client-Id") || "";
    const requestId = request.headers.get("Request-Id") || "";
    const timestamp = request.headers.get("Request-Timestamp") || "";
    const receivedSignature = request.headers.get("Signature") || "";

    if (
      receivedClientId !== clientId ||
      !requestId ||
      !timestamp ||
      !receivedSignature
    ) {
      return jsonResponse({
        success: false,
        message: "Header notifikasi tidak valid."
      }, 401);
    }

    // 2. Ambil body mentah untuk verifikasi signature
    const rawBody = await request.text();

    const requestTarget = "/api/doku/notification";

    const expectedSignature = await createDokuSignature(
      clientId,
      requestId,
      timestamp,
      requestTarget,
      rawBody,
      secretKey
    );

    if (!safeEqual(receivedSignature, expectedSignature)) {
      console.error("DOKU notification signature invalid.");

      return jsonResponse({
        success: false,
        message: "Signature notifikasi tidak valid."
      }, 401);
    }

    // 3. Baca isi notifikasi
    let data;

    try {
      data = JSON.parse(rawBody);
    } catch {
      return jsonResponse({
        success: false,
        message: "Format JSON notifikasi tidak valid."
      }, 400);
    }

    const invoiceNumber = String(
      data.order?.invoice_number || ""
    ).trim();

    const amount = Number(data.order?.amount);

    const transactionStatus = String(
      data.transaction?.status || ""
    ).toUpperCase();

    const originalRequestId = String(
      data.transaction?.original_request_id || ""
    ).trim();

    if (
      !invoiceNumber ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !originalRequestId
    ) {
      return jsonResponse({
        success: false,
        message: "Data transaksi tidak lengkap."
      }, 400);
    }

    // 4. Checkout: status FAILED diabaikan.
    // Pelanggan masih dapat memilih metode pembayaran lain.
    if (transactionStatus === "FAILED") {
      return jsonResponse({
        success: true,
        message: "Notifikasi FAILED diabaikan untuk DOKU Checkout."
      });
    }

    // Hanya SUCCESS yang dapat melunasi pesanan.
    if (transactionStatus !== "SUCCESS") {
      return jsonResponse({
        success: false,
        message: "Status transaksi belum dapat diproses."
      }, 400);
    }

    // 5. Cocokkan transaksi dengan database SAHDONG
    const record = await env.DB.prepare(`
      SELECT
        orders.id AS order_id,
        orders.order_number,
        orders.amount AS order_amount,
        orders.status AS order_status,

        payments.id AS payment_id,
        payments.amount AS payment_amount,
        payments.status AS payment_status,
        payments.payment_gateway,
        payments.gateway_request_id

      FROM orders

      INNER JOIN payments
        ON payments.order_id = orders.id

      WHERE orders.order_number = ?
      LIMIT 1
    `)
      .bind(invoiceNumber)
      .first();

    if (!record) {
      console.error("DOKU invoice not found:", invoiceNumber);

      return jsonResponse({
        success: false,
        message: "Pesanan tidak ditemukan."
      }, 404);
    }

    // 6. Pastikan nominal sesuai
    if (
      Number(record.order_amount) !== amount ||
      Number(record.payment_amount) !== amount
    ) {
      console.error("DOKU amount mismatch:", invoiceNumber);

      return jsonResponse({
        success: false,
        message: "Nominal transaksi tidak sesuai."
      }, 409);
    }

    // 7. Pastikan transaksi berasal dari checkout SAHDONG
    if (
      record.payment_gateway !== "doku" ||
      record.gateway_request_id !== originalRequestId
    ) {
      console.error("DOKU request ID mismatch:", invoiceNumber);

      return jsonResponse({
        success: false,
        message: "Referensi transaksi tidak cocok."
      }, 409);
    }

    // 8. Idempotensi: transaksi yang sudah lunas tidak diproses ulang
    if (record.payment_status === "paid") {
      return jsonResponse({
        success: true,
        message: "Pembayaran sudah pernah diproses.",
        duplicate: true
      });
    }

    if (
      record.payment_status !== "pending" ||
      record.order_status !== "pending"
    ) {
      return jsonResponse({
        success: false,
        message: "Status pesanan tidak dapat diperbarui."
      }, 409);
    }

    // 9. Perbarui pembayaran dan pesanan
    const paidAt = data.transaction?.date &&
      !Number.isNaN(Date.parse(data.transaction.date))
      ? new Date(data.transaction.date).toISOString()
      : new Date().toISOString();

    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE payments
        SET
          status = 'paid',
          paid_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND gateway_request_id = ?
      `).bind(
        paidAt,
        record.payment_id,
        originalRequestId
      ),

      env.DB.prepare(`
        UPDATE orders
        SET status = 'paid'
        WHERE id = ?
          AND status = 'pending'
          AND EXISTS (
            SELECT 1
            FROM payments
            WHERE payments.order_id = orders.id
              AND payments.status = 'paid'
          )
      `).bind(record.order_id)
    ]);

    const paymentChanges = results?.[0]?.meta?.changes ?? 0;

    if (paymentChanges === 0) {
      const latest = await env.DB.prepare(`
        SELECT status
        FROM payments
        WHERE id = ?
        LIMIT 1
      `)
        .bind(record.payment_id)
        .first();

      if (latest?.status === "paid") {
        return jsonResponse({
          success: true,
          message: "Pembayaran sudah pernah diproses.",
          duplicate: true
        });
      }

      return jsonResponse({
        success: false,
        message: "Pembayaran gagal diperbarui."
      }, 409);
    }

    console.log("SAHDONG PAYMENT SUCCESS:", invoiceNumber);

    return jsonResponse({
      success: true,
      message: "Pembayaran berhasil dikonfirmasi.",
      order_number: invoiceNumber,
      status: "paid"
    });

  } catch (error) {
    console.error("SAHDONG DOKU NOTIFICATION ERROR:", error);

    return jsonResponse({
      success: false,
      message: "Terjadi kesalahan saat memproses notifikasi."
    }, 500);
  }
}
