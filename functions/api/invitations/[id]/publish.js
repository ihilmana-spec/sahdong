
async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonError(message, status) {
  return Response.json(
    { success: false, message },
    { status }
  );
}

async function authenticateCustomer(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)sahdong_session=([^;]+)/);

  if (!match) {
    return { error: "Belum login.", status: 401 };
  }

  const tokenHash = await hashToken(match[1]);
  const now = Math.floor(Date.now() / 1000);

  const session = await env.DB.prepare(`
    SELECT users.id, users.role, users.status
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  if (!session || session.status !== "active") {
    return {
      error: "Sesi tidak valid atau sudah kedaluwarsa.",
      status: 401
    };
  }

  if (session.role !== "customer") {
    return {
      error: "Akses hanya untuk pelanggan.",
      status: 403
    };
  }

  return { user: session };
}

// Mengambil tanggal dan waktu WIB.
function getJakartaDateTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

// Menambahkan bulan kalender dengan memperhatikan
// jumlah hari pada bulan tujuan.
function addMonths(date, months) {
  const targetMonthIndex =
    date.month - 1 + months;

  const targetYear =
    date.year + Math.floor(targetMonthIndex / 12);

  const targetMonth =
    (targetMonthIndex % 12) + 1;

  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth, 0)
  ).getUTCDate();

  const targetDay = Math.min(date.day, lastDay);

  return {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    hour: date.hour,
    minute: date.minute,
    second: date.second
  };
}

function formatDate(date) {
  return [
    date.year,
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0")
  ].join("-");
}

function formatDateTime(date) {
  return `${formatDate(date)} ${String(date.hour).padStart(2, "0")}:${String(date.minute).padStart(2, "0")}:${String(date.second).padStart(2, "0")}`;
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

// MENERBITKAN UNDANGAN
export async function onRequestPost({ request, env, params }) {
  try {
    if (!env.DB) {
      return jsonError("Database tidak tersedia.", 500);
    }

    const auth = await authenticateCustomer(request, env);

    if (auth.error) {
      return jsonError(auth.error, auth.status);
    }

    const invitationId = params.id;

    if (!invitationId) {
      return jsonError("ID undangan wajib diisi.", 400);
    }

    // Ambil undangan, pesanan, dan pembayaran.
    const invitation = await env.DB.prepare(`
      SELECT
        i.id,
        i.user_id,
        i.title,
        i.slug,
        i.template_code,
        i.invitation_data,
        i.status,
        i.review_status,
        i.activation_date,
        i.published_at,
        i.expires_at,
        o.id AS order_id,
        o.order_number,
        o.package_name,
        o.amount AS order_amount,
        o.status AS order_status,
        p.id AS payment_id,
        p.amount AS payment_amount,
        p.status AS payment_status
      FROM invitations i
      LEFT JOIN orders o
        ON o.invitation_id = i.id
       AND o.user_id = i.user_id
      LEFT JOIN payments p
        ON p.order_id = o.id
      WHERE i.id = ?
        AND i.user_id = ?
      ORDER BY o.created_at DESC, p.created_at DESC
      LIMIT 1
    `).bind(
      invitationId,
      auth.user.id
    ).first();

    if (!invitation) {
      return jsonError("Undangan tidak ditemukan.", 404);
    }

    // Cegah publikasi berulang.
    if (
      invitation.status !== "draft" ||
      invitation.published_at
    ) {
      return jsonError(
        "Undangan sudah diterbitkan atau tidak dapat diterbitkan lagi.",
        409
      );
    }

    if (invitation.review_status !== "draft") {
      return jsonError(
        "Status undangan tidak memungkinkan untuk diterbitkan.",
        403
      );
    }

    // Periksa pembayaran.
    if (
      invitation.order_status !== "paid" ||
      invitation.payment_status !== "paid"
    ) {
      return jsonError(
        "Pembayaran belum lunas. Undangan belum dapat diterbitkan.",
        403
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
      return jsonError("Paket tidak ditemukan.", 400);
    }

    // Pastikan paket dan nominal pesanan sesuai template.
    if (
      invitation.package_name !== selectedPackage.name ||
      Number(invitation.order_amount) !== selectedPackage.amount ||
      Number(invitation.payment_amount) !== selectedPackage.amount
    ) {
      return jsonError(
        "Data paket atau nominal pembayaran tidak sesuai dengan template.",
        400
      );
    }

    // Periksa kelengkapan dasar data undangan.
    if (!invitation.title || !invitation.title.trim()) {
      return jsonError(
        "Judul undangan belum diisi.",
        400
      );
    }

    let invitationData;

    try {
      invitationData = JSON.parse(
        invitation.invitation_data || "{}"
      );
    } catch {
      return jsonError(
        "Data undangan tidak dapat dibaca.",
        400
      );
    }

    if (
      !invitationData ||
      typeof invitationData !== "object" ||
      Array.isArray(invitationData) ||
      Object.keys(invitationData).length === 0
    ) {
      return jsonError(
        "Lengkapi data undangan sebelum menerbitkannya.",
        400
      );
    }

    // Tentukan tanggal aktivasi pada saat publikasi.
    const activation = getJakartaDateTime();

    const expiry = addMonths(
      activation,
      selectedPackage.duration_months
    );

    const activationDate = formatDate(activation);
    const publishedAt = formatDateTime(activation);
    const expiresAt = formatDateTime(expiry);

    // Update hanya jika undangan masih draft.
    const result = await env.DB.prepare(`
      UPDATE invitations
      SET
        status = 'published',
        activation_date = ?,
        published_at = ?,
        expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
        AND status = 'draft'
        AND review_status = 'draft'
        AND published_at IS NULL
    `).bind(
      activationDate,
      publishedAt,
      expiresAt,
      invitationId,
      auth.user.id
    ).run();

    if (!result.meta || result.meta.changes !== 1) {
      return jsonError(
        "Undangan gagal diterbitkan. Silakan muat ulang halaman.",
        409
      );
    }

    return Response.json({
      success: true,
      message: "Selamat! Undangan berhasil diterbitkan.",
      invitation: {
        id: invitationId,
        title: invitation.title,
        slug: invitation.slug,
        template_code: templateCode,
        package: selectedPackage.name,
        duration_months: selectedPackage.duration_months,
        status: "published",
        activation_date: activationDate,
        published_at: publishedAt,
        expires_at: expiresAt,
        public_url: `/demo/${templateCode}/?slug=${encodeURIComponent(invitation.slug)}`
      }
    });

  } catch (error) {
    console.error("SAHDONG PUBLISH ERROR:", error);

    return jsonError(
      "Terjadi kesalahan saat menerbitkan undangan.",
      500
    );
  }
}
