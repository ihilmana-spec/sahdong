
export async function onRequestGet({ request, env }) {
  try {
    if (!env.GALLERY) {
      return new Response("Penyimpanan foto tidak tersedia.", { status: 500 });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (
      !key ||
      !key.startsWith("invitations/") ||
      key.includes("..") ||
      key.includes("\\")
    ) {
      return new Response("Foto tidak valid.", { status: 400 });
    }

    const object = await env.GALLERY.get(key);

    if (!object) {
      return new Response("Foto tidak ditemukan.", { status: 404 });
    }

    const contentType = object.httpMetadata?.contentType || "";

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(contentType)) {
      return new Response("Format foto tidak diizinkan.", { status: 415 });
    }

    const headers = new Headers();

    object.writeHttpMetadata(headers);
    headers.set("Content-Type", contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(object.body, {
      status: 200,
      headers
    });

  } catch (error) {
    console.error("GALLERY IMAGE ERROR:", error);

    return new Response("Gagal menampilkan foto.", {
      status: 500
    });
  }
}
