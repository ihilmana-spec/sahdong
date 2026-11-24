
export async function onRequestGet() {
  return Response.json({
    success: true,
    app: "SAHDONG",
    message: "Backend SAHDONG aktif",
    version: "1.0.0"
  });
}
