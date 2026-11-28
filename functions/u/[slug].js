// functions/u/[slug].js
// Melayani link pendek /u/<slug> dengan template BSC-01.
// URL di browser tamu TETAP /u/<slug>, tidak berubah jadi /demo/...
// Template baca slug-nya dari pathname (/u/<slug>), jadi jangan redirect,
// tapi sajikan isi /demo/BSC-01/index.html apa adanya.

export async function onRequestGet({ request, env }) {
  const demoUrl = new URL("/demo/BSC-01/index.html", request.url);

  // Ambil file statis template dari origin yang sama.
  // Pakai env.ASSETS kalau tersedia (Pages Functions), fallback ke fetch.
  let response;
  try {
    if (env && env.ASSETS) {
      response = await env.ASSETS.fetch(demoUrl);
    } else {
      response = await fetch(demoUrl, { headers: { "Accept": "text/html" } });
    }
  } catch (e) {
    return new Response("Undangan tidak dapat dimuat.", { status: 500 });
  }

  if (!response || !response.ok) {
    return new Response("Undangan tidak ditemukan.", { status: 404 });
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(response.body, { status: 200, headers });
}
