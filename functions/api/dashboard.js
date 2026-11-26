
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

    if (name === "sahdong_session") {
      return value;
    }
  }

  return null;
}

export async function onRequestGet({ request, env }) {
  try {
    // 1. Periksa database
    if (!env.DB) {
      return Response.json({
        success: false,
        message: "Database tidak tersedia."
      }, { status: 500 });
    }

    // 2. Periksa sesi login
    const token = getSessionCookie(request);

    if (!token) {
      return Response.json({
        success: false,
        message: "Belum login."
      }, { status: 401 });
    }

    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const user = await env.DB.prepare(`
      SELECT
        users.id,
        users.full_name,
        users.email,
        users.phone,
        users.role,
        users.status
      FROM sessions
      INNER JOIN users
        ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
      LIMIT 1
    `)
      .bind(tokenHash, now)
      .first();

    if (!user || user.status !== "active") {
      return Response.json({
        success: false,
        message: "Session tidak valid atau sudah kedaluwarsa."
      }, { status: 401 });
    }

    // 3. Hanya customer yang dapat mengakses dashboard
    if (user.role !== "customer") {
      return Response.json({
        success: false,
        message: "Akses khusus customer."
      }, { status: 403 });
    }

    // 4. Ambil seluruh ringkasan dan data terbaru
    const [
      invitationCount,
      orderCount,
      paymentCount,
      pendingOrderCount,
      activeInvitationCount,
      recentInvitations,
      recentOrders
    ] = await Promise.all([

      // Total undangan
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM invitations
        WHERE user_id = ?
      `)
        .bind(user.id)
        .first(),

      // Total pesanan
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM orders
        WHERE user_id = ?
      `)
        .bind(user.id)
        .first(),

      // Total pembayaran lunas
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM payments
        INNER JOIN orders
          ON orders.id = payments.order_id
        WHERE orders.user_id = ?
          AND payments.status = 'paid'
      `)
        .bind(user.id)
        .first(),

      // Pesanan menunggu pembayaran
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM orders
        WHERE user_id = ?
          AND status = 'pending'
      `)
        .bind(user.id)
        .first(),

      // Undangan aktif atau sudah dipublikasikan
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM invitations
        WHERE user_id = ?
          AND status IN ('active', 'published')
      `)
        .bind(user.id)
        .first(),

      // Lima undangan terbaru
      env.DB.prepare(`
        SELECT
          id,
          title,
          slug,
          status,
          review_status,
          activation_date,
          published_at,
          expires_at,
          created_at
        FROM invitations
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `)
        .bind(user.id)
        .all(),

      // Lima pesanan terbaru
      env.DB.prepare(`
        SELECT
          orders.id,
          orders.order_number,
          orders.invitation_id,
          orders.package_name,
          orders.amount,
          orders.status,
          orders.created_at,
          invitations.title AS invitation_title,

          (
            SELECT payments.status
            FROM payments
            WHERE payments.order_id = orders.id
            ORDER BY payments.created_at DESC
            LIMIT 1
          ) AS payment_status,

          (
            SELECT payments.paid_at
            FROM payments
            WHERE payments.order_id = orders.id
            ORDER BY payments.created_at DESC
            LIMIT 1
          ) AS paid_at

        FROM orders
        LEFT JOIN invitations
          ON invitations.id = orders.invitation_id

        WHERE orders.user_id = ?
        ORDER BY orders.created_at DESC
        LIMIT 5
      `)
        .bind(user.id)
        .all()

    ]);

    // 5. Kirim respons dashboard
    return Response.json({
      success: true,
      message: "Dashboard berhasil diambil.",

      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role
      },

      summary: {
        total_invitations: invitationCount.total,
        total_orders: orderCount.total,
        total_paid_payments: paymentCount.total,
        pending_orders: pendingOrderCount.total,
        active_invitations: activeInvitationCount.total
      },

      invitations: recentInvitations.results || [],
      orders: recentOrders.results || []
    });

  } catch (error) {
    console.error("SAHDONG DASHBOARD ERROR:", error);

    return Response.json({
      success: false,
      message: "Terjadi kesalahan pada server."
    }, { status: 500 });
  }
}
