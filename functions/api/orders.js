
async function hashToken(token) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
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

const PACKAGES = {
  BSC: {
    name: "Basic",
    amount: 25000,
    duration_months: 3
  },
  PRM: {
    name: "Premium",
    amount: 45000,
    duration_months: 6
  },
  EXC: {
    name: "Exclusive",
    amount: 92000,
    duration_months: 12
  }
};

function jsonError(message, status) {
  return Response.json(
    { success: false, message },
    { status }
  );
}

// MEMBUAT PESANAN
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return jsonError("Database tidak tersedia.", 500);
    }

    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonError("Format JSON tidak valid.", 400);
    }

    const invitationId = String(
      body.invitation_id || ""
    ).trim();

    if (!invitationId) {
      return jsonError("ID undangan wajib diisi.", 400);
    }

    // Ambil template dari data undangan.
    // Paket tidak boleh ditentukan oleh input pelanggan.
    const invitation = await env.DB.prepare(`
      SELECT
        id,
        title,
        template_code,
        status,
        activation_date
      FROM invitations
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(invitationId, auth.user.id).first();

    if (!invitation) {
      return jsonError(
        "Undangan tidak ditemukan atau bukan milik Anda.",
        404
      );
    }

    if (invitation.status !== "draft") {
      return jsonError(
        "Pesanan hanya dapat dibuat untuk undangan berstatus draft.",
        400
      );
    }

    const templateCode = String(
      invitation.template_code || ""
    ).trim().toUpperCase();

    const templateMatch = templateCode.match(
      /^(BSC|PRM|EXC)-(0[1-9]|10)$/
    );

    if (!templateMatch) {
      return jsonError(
        "Kode template undangan tidak valid.",
        400
      );
    }

    const selectedPackage = PACKAGES[templateMatch[1]];

    if (!selectedPackage) {
      return jsonError(
        "Paket untuk template ini tidak tersedia.",
        400
      );
    }

    // Cegah pembuatan pesanan ganda untuk undangan yang sama.
    const existingOrder = await env.DB.prepare(`
      SELECT id, order_number, status
      FROM orders
      WHERE invitation_id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(invitationId, auth.user.id).first();

    if (existingOrder) {
      return jsonError(
        "Undangan ini sudah memiliki pesanan. Silakan buka detail pesanan Anda.",
        409
      );
    }

    const orderId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();

    const dateCode = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    const randomCode = crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 8)
      .toUpperCase();

    const orderNumber = `SHD-${dateCode}-${randomCode}`;

    const orderStatement = env.DB.prepare(`
      INSERT INTO orders (
        id,
        user_id,
        invitation_id,
        order_number,
        package_name,
        amount,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).bind(
      orderId,
      auth.user.id,
      invitationId,
      orderNumber,
      selectedPackage.name,
      selectedPackage.amount
    );

    const paymentStatement = env.DB.prepare(`
      INSERT INTO payments (
        id,
        order_id,
        payment_gateway,
        gateway_reference,
        amount,
        status
      )
      VALUES (?, ?, NULL, NULL, ?, 'pending')
    `).bind(
      paymentId,
      orderId,
      selectedPackage.amount
    );

    await env.DB.batch([
      orderStatement,
      paymentStatement
    ]);

    return Response.json({
      success: true,
      message: "Pesanan berhasil dibuat. Menunggu pembayaran.",
      order: {
        id: orderId,
        order_number: orderNumber,
        invitation_id: invitationId,
        invitation_title: invitation.title,
        template_code: templateCode,
        package: selectedPackage.name,
        amount: selectedPackage.amount,
        duration_months: selectedPackage.duration_months,
        activation_date: null,
        status: "pending",
        payment: {
          id: paymentId,
          status: "pending"
        }
      }
    }, { status: 201 });

  } catch (error) {
    console.error("SAHDONG ORDERS CREATE ERROR:", error);

    return jsonError(
      "Terjadi kesalahan pada server.",
      500
    );
  }
}

// MELIHAT DAFTAR DAN DETAIL PESANAN
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return jsonError("Database tidak tersedia.", 500);
    }

    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    const url = new URL(request.url);
    const orderId = url.searchParams.get("id");

    if (orderId) {
      const order = await env.DB.prepare(`
        SELECT
          o.id,
          o.order_number,
          o.invitation_id,
          o.package_name,
          o.amount,
          o.status,
          o.created_at,
          i.title AS invitation_title,
          i.template_code,
          i.activation_date,
          p.id AS payment_id,
          p.payment_gateway,
          p.gateway_reference,
          p.status AS payment_status,
          p.paid_at
        FROM orders o
        LEFT JOIN invitations i
          ON i.id = o.invitation_id
        LEFT JOIN payments p
          ON p.order_id = o.id
        WHERE o.id = ?
          AND o.user_id = ?
        LIMIT 1
      `).bind(orderId, auth.user.id).first();

      if (!order) {
        return jsonError("Pesanan tidak ditemukan.", 404);
      }

      return Response.json({
        success: true,
        message: "Detail pesanan berhasil diambil.",
        order
      });
    }

    const result = await env.DB.prepare(`
      SELECT
        o.id,
        o.order_number,
        o.invitation_id,
        o.package_name,
        o.amount,
        o.status,
        o.created_at,
        i.title AS invitation_title,
        i.template_code,
        i.activation_date,
        p.id AS payment_id,
        p.status AS payment_status,
        p.paid_at
      FROM orders o
      LEFT JOIN invitations i
        ON i.id = o.invitation_id
      LEFT JOIN payments p
        ON p.order_id = o.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `).bind(auth.user.id).all();

    return Response.json({
      success: true,
      message: "Daftar pesanan berhasil diambil.",
      total: result.results.length,
      orders: result.results
    });

  } catch (error) {
    console.error("SAHDONG ORDERS GET ERROR:", error);

    return jsonError(
      "Terjadi kesalahan pada server.",
      500
    );
  }
}
