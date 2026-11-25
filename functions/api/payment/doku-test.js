
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function createDigest(body) {
  const encoded = new TextEncoder().encode(body);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
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
        message: "DOKU Client ID atau Secret Key belum tersedia."
      }, { status: 500 });
    }

    if (env.DOKU_ENV !== "sandbox") {
      return Response.json({
        success: false,
        stage: "ENVIRONMENT",
        message: "Pengujian dihentikan. DOKU_ENV bukan sandbox."
      }, { status: 400 });
    }

    const endpoint = "https://api-sandbox.doku.com/checkout/v1/payment";
    const requestTarget = "/checkout/v1/payment";

    // Payload sengaja tidak lengkap untuk pengujian validasi API.
    const body = "{}";

    const clientId = env.DOKU_CLIENT_ID;
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const digest = await createDigest(body);

    const components = [
      `Client-Id:${clientId}`,
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
          "Client-Id": clientId,
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
        message: "Gagal menghubungi API Checkout DOKU.",
        error_name: error.name,
        error_message: error.message
      }, { status: 502 });
    }

    const responseText = await response.text();

    return Response.json({
      success: true,
      stage: "DOKU_RESPONSE",
      message: "Server menerima respons dari API Checkout DOKU.",
      doku_http_status: response.status,
      doku_response: responseText.slice(0, 3000),
      request_id: requestId
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
    message: "DOKU diagnostic endpoint aktif. Gunakan POST."
  });
}
