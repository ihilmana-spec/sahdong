export async function onRequest({ request }) {
  return Response.json({
    success: true,
    message: "POST Payment API berjalan",
    method: request.method
  });
}
