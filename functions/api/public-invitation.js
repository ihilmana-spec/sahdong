
function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// Mengambil waktu sekarang berdasarkan WIB.
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

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return jsonResponse({
        success: false,
        message: "Database tidak tersedia."
      }, 500);
    }

    const url = new URL(request.url);
    const slug = (url.searchParams.get("slug") || "").trim();

    if (!slug || slug.length > 200) {
      return jsonResponse({
        success: false,
        message: "Slug tidak valid."
      }, 400);
    }

    // Hanya mengambil undangan yang benar-benar sudah diterbitkan.
    const invitation = await env.DB.prepare(`
      SELECT
        i.id,
        i.title,
        i.slug,
        i.template_code,
        i.invitation_data,
        i.activation_date,
        i.published_at,
        i.expires_at,
        i.status AS invitation_status,
        o.status AS order_status,
        o.package_name,
        p.status AS payment_status
      FROM invitations i
      INNER JOIN orders o
        ON o.invitation_id = i.id
       AND o.user_id = i.user_id
      INNER JOIN payments p
        ON p.order_id = o.id
      WHERE i.slug = ?
        AND i.status = 'published'
        AND i.published_at IS NOT NULL
        AND i.activation_date IS NOT NULL
        AND i.expires_at IS NOT NULL
        AND o.status = 'paid'
        AND p.status = 'paid'
      ORDER BY p.created_at DESC
      LIMIT 1
    `).bind(slug).first();

    if (!invitation) {
      return jsonResponse({
        success: false,
        message: "Undangan tidak ditemukan, belum diterbitkan, atau pembayaran belum lunas."
      }, 404);
    }

    // Periksa tanggal aktivasi.
    const today = getJakartaDateTime().slice(0, 10);
    const activationDate = invitation.activation_date.slice(0, 10);

    if (activationDate > today) {
      return jsonResponse({
        success: false,
        message: "Undangan belum memasuki tanggal aktivasi.",
        activation_date: activationDate
      }, 403);
    }

    // Gunakan tanggal kedaluwarsa yang sudah disimpan
    // saat pelanggan menerbitkan undangan.
    const now = getJakartaDateTime();
    const expiresAt = String(invitation.expires_at).slice(0, 19);

    if (now >= expiresAt) {
      return jsonResponse({
        success: false,
        message: "Masa aktif undangan telah berakhir.",
        expires_at: invitation.expires_at
      }, 403);
    }

    // Baca data undangan.
    let invitationData;

    try {
      invitationData = JSON.parse(
        invitation.invitation_data || "{}"
      );
    } catch {
      return jsonResponse({
        success: false,
        message: "Data undangan tidak dapat dibaca."
      }, 500);
    }

    if (
      !invitationData ||
      typeof invitationData !== "object" ||
      Array.isArray(invitationData)
    ) {
      return jsonResponse({
        success: false,
        message: "Format data undangan tidak valid."
      }, 500);
    }

    return jsonResponse({
      success: true,
      invitation: {
        id: invitation.id,
        title: invitation.title,
        slug: invitation.slug,
        template_code: invitation.template_code,
        invitation_data: invitationData,
        activation_date: invitation.activation_date,
        published_at: invitation.published_at,
        expires_at: invitation.expires_at,
        package_name: invitation.package_name
      }
    });

  } catch (error) {
    console.error("PUBLIC INVITATION ERROR:", error);

    return jsonResponse({
      success: false,
      message: "Terjadi kesalahan saat memuat undangan."
    }, 500);
  }
}
