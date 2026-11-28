// GET /api/music-file?key=...
// Melayani file musik katalog + MP3 unggahan customer.
// Sebelumnya file ini (sama seperti demo) hanya menerima key
// customer-music/..., sehingga key invitations/.../music/...
// yang disimpan music.js ditolak dan musik tidak pernah bunyi.

const ALLOWED_KEY = /^(catalog\/[A-Za-z0-9._\- ]+\.mp3|invitations\/[A-Za-z0-9_-]+\/music\/[A-Fa-f0-9-]+\.mp3|customer-music\/[A-Za-z0-9_-]+\/[A-Fa-f0-9-]+\.mp3)$/;

export async function onRequestGet({ request, env }) {
  try {
    if (!env.MUSIC) {
      return new Response("Penyimpanan musik tidak tersedia.", { status: 500 });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";

    if (!key || !ALLOWED_KEY.test(key)) {
      return new Response("File musik tidak valid.", { status: 400 });
    }

    // Dukung Range request supaya audio bisa di-seek / diputar browser.
    const range = request.headers.get("Range") || "";
    const obj = await env.MUSIC.get(key, { range: range || undefined });

    if (!obj) {
      return new Response("File musik tidak ditemukan.", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", "audio/mpeg");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (obj.httpMetadata?.contentLength != null) {
      headers.set("Content-Length", String(obj.httpMetadata.contentLength));
    }
    if (obj.httpMetadata?.contentRange) {
      headers.set("Content-Range", obj.httpMetadata.contentRange);
    }

    return new Response(obj.body, {
      status: obj.httpMetadata?.contentRange ? 206 : 200,
      headers
    });
  } catch (error) {
    console.error("MUSIC FILE ERROR:", error);
    return new Response("Gagal memuat file musik.", { status: 500 });
  }
}
