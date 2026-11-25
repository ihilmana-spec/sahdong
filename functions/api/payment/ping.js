export async function onRequest(context) {
  return Response.json({
    success: true,
    message: "Payment API berjalan",
    method: context.request.method
  });
}
