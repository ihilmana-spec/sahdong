
export async function onRequestGet({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  try {
    const url = new URL(request.url);
    const slug = (url.searchParams.get("slug") || "").trim();

    if (!slug || slug.length > 200) {
      return Response.json({
        success: false,
        message: "Slug tidak valid."
      }, { status: 400, headers });
    }

    const invitation = await env.DB.prepare(`
      SELECT
        i.id,
        i.title,
        i.slug,
        i.template_code,
        i.invitation_data,
        i.activation_date,
        i.published_at,
        i.status AS invitation_status,
        o.status AS order_status,
        o.package_name,
        p.status AS payment_status
      FROM invitations i
      INNER JOIN orders o ON o.invitation_id = i.id
      INNER JOIN payments p ON p.order_id = o.id
      WHERE i.slug = ?
        AND i.status != 'archived'
        AND p.status = 'paid'
        AND o.status IN ('paid', 'processing', 'completed')
      ORDER BY o.created_at DESC
      LIMIT 1
    `).bind(slug).first();

    if (!invitation) {
      return Response.json({
        success: false,
        message: "Undangan tidak ditemukan atau pembayaran belum lunas."
      }, { status: 404, headers });
    }

    if (!invitation.activation_date) {
      return Response.json({
        success: false,
        message: "Tanggal aktivasi belum ditentukan."
      }, { status: 403, headers });
    }

    const activationDate = invitation.activation_date.slice(0, 10);
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Jakarta"
    });

    if (activationDate > today) {
      return Response.json({
        success: false,
        message: "Undangan belum memasuki tanggal aktivasi.",
        activation_date: activationDate
      }, { status: 403, headers });
    }

    const durations = {
      basic: 3,
      premium: 6,
      exclusive: 12
    };

    const months = durations[
      String(invitation.package_name || "").toLowerCase()
    ];

    if (!months) {
      return Response.json({
        success: false,
        message: "Paket undangan tidak valid."
      }, { status: 400, headers });
    }

    const [year, month, day] = activationDate.split("-").map(Number);
    const expiryDate = new Date(Date.UTC(year, month - 1 + months, day));

    // Sesuaikan akhir bulan agar tanggal tidak bergeser.
    const lastDay = new Date(
      Date.UTC(year, month + months, 0)
    ).getUTCDate();

    if (day > lastDay) {
      expiryDate.setUTCDate(lastDay);
    }

    const expiresAt = expiryDate.toISOString().slice(0, 10);

    if (today >= expiresAt) {
      return Response.json({
        success: false,
        message: "Masa aktif undangan telah berakhir.",
        expires_at: expiresAt
      }, { status: 403, headers });
    }

    let invitationData = {};

    try {
      invitationData = JSON.parse(
        invitation.invitation_data || "{}"
      );
    } catch {
      invitationData = {};
    }

    return Response.json({
      success: true,
      invitation: {
        id: invitation.id,
        title: invitation.title,
        slug: invitation.slug,
        template_code: invitation.template_code,
        invitation_data: invitationData,
        activation_date: invitation.activation_date,
        published_at: invitation.published_at,
        expires_at: expiresAt,
        package_name: invitation.package_name
      }
    }, { status: 200, headers });

  } catch (error) {
    console.error("PUBLIC INVITATION ERROR:", error);

    return Response.json({
      success: false,
      message: "Terjadi kesalahan saat memuat undangan."
    }, { status: 500, headers });
  }
}
