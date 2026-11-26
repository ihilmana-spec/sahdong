
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
        message: "Slug undangan tidak valid."
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
        i.status,
        o.package_name,
        datetime(
          i.activation_date,
          CASE lower(o.package_name)
            WHEN 'basic' THEN '+3 months'
            WHEN 'premium' THEN '+6 months'
            WHEN 'exclusive' THEN '+12 months'
            ELSE '+0 months'
          END
        ) AS expires_at
      FROM invitations i
      INNER JOIN orders o ON o.invitation_id = i.id
      INNER JOIN payments p ON p.order_id = o.id
      WHERE i.slug = ?
        AND i.status != 'archived'
        AND i.activation_date IS NOT NULL
        AND date(i.activation_date) <= date('now')
        AND datetime(
          i.activation_date,
          CASE lower(o.package_name)
            WHEN 'basic' THEN '+3 months'
            WHEN 'premium' THEN '+6 months'
            WHEN 'exclusive' THEN '+12 months'
            ELSE '+0 months'
          END
        ) > datetime('now')
        AND p.status = 'paid'
        AND o.status IN ('paid', 'processing', 'completed')
      LIMIT 1
    `).bind(slug).first();

    if (!invitation) {
      return Response.json({
        success: false,
        message: "Undangan belum aktif, pembayaran belum lunas, atau masa aktif telah berakhir."
      }, { status: 404, headers });
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
        expires_at: invitation.expires_at,
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
