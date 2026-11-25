
export async function onRequestGet() {
  try {
    const response = await fetch(
      "https://api-sandbox.doku.com",
      {
        method: "GET"
      }
    );

    const text = await response.text();

    return Response.json({
      success: true,
      message: "Server DOKU berhasil dihubungi.",
      doku_http_status: response.status,
      response_preview: text.slice(0, 500)
    });

  } catch (error) {
    return Response.json({
      success: false,
      message: "Gagal menghubungi server DOKU.",
      error_name: error.name,
      error_message: error.message
    }, { status: 502 });
  }
}
