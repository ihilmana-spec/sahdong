
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function createDigest(body) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  );

  return toBase64(new Uint8Array(hash));
}

async function createSignature(secret, components) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(components)
  );

  return "HMACSHA256=" + toBase64(new Uint8Array(signature));
}

export async function onRequestPost({ env }) {
  try {
    if (!env.DOKU_CLIENT_ID || !env.DOKU_SECRET_KEY) {
      return Response.json({
        success: false,
        stage: "CONFIGURATION",
        message: "Kredensial DOKU belum tersedia."
      }, { status: 500 });
    }

    if (env.DOKU_ENV !== "sandbox") {
      return Response.json({
        success: false,
        stage: "ENVIRONMENT",
        message: "Pengujian hanya diizinkan untuk Sandbox."
      }, { status: 400 });
    }

    const endpoint =
      "https://api-sandbox.doku.com/checkout/v1/payment";

    const requestTarget = "/checkout/v1/payment";
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const invoiceNumber = "SHD" + Date.now();

    const payload = {
      order: {
        amount: 25000,
        invoice_number: invoiceNumber,
        currency: "IDR",
        auto_redirect: true
      },
      payment: {
        payment_due_date: 60
      }
    };

    const body = JSON.stringify(payload);
    const digest = await createDigest(body);

    const components = [
      `Client-Id:${env.DOKU_CLIENT_ID}`,
      `Request-Id:${requestId}`,
      `Request-Timestamp:${timestamp}`,
      `Request-Target:${requestTarget}`,
      `Digest:${digest}`
    ].join("\n");

    const signature = await createSignature(
      env.DOKU_SECRET_KEY,
      components
    );

    let response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Client-Id": env.DOKU_CLIENT_ID,
          "Request-Id": requestId,
          "Request-Timestamp": timestamp,
          "Signature": signature
        },
        body
      });
    } catch (error) {
      return Response.json({
        success: false,
        stage: "FETCH",
        error_name: error.name,
        error_message: error.message
      }, { status: 502 });
    }

    const responseText = await response.text();

    let dokuData;

    try {
      dokuData = JSON.parse(responseText);
    } catch {
      return Response.json({
        success: false,
        stage: "INVALID_RESPONSE",
        doku_http_status: response.status,
        doku_response: responseText.slice(0, 3000),
        invoice_number: invoiceNumber
      }, { status: 502 });
    }

    const payment = dokuData.response?.payment || {};

    return Response.json({
      success: response.ok,
      stage: "CHECKOUT_RESULT",
      doku_http_status: response.status,
      invoice_number: invoiceNumber,
      amount: 25000,
      doku_message: dokuData.message || null,
      checkout_url: payment.url || null,
      token_id_received: Boolean(payment.token_id),
      expired_date: payment.expired_date || null,
      response: dokuData
    });

  } catch (error) {
    return Response.json({
      success: false,
      stage: "INTERNAL_ERROR",
      error_name: error.name,
      error_message: error.message
    }, { status: 500 });
  }
}

export async function onRequestGet() {
  return Response.json({
    success: true,
    message: "DOKU Sandbox Checkout test aktif. Gunakan POST."
  });
}
