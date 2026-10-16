/** Removed Midas data transports return an explicit migration contract. */
export function retiredResearchResponse(datasets: readonly string[]): Response {
  return Response.json({ error: { code: "data_endpoint_replaced", message: "Use Trader's independent /api/v1/data endpoints. The old Midas response schema is no longer served." }, replacements: datasets.map(id => ({ dataset: id, endpoint: `/api/v1/data/${id}`, describe: `/api/v1/data/${id}/describe` })) }, { status: 410, headers: { "Cache-Control": "no-store", Link: '</api/v1/data>; rel="successor-version"' } });
}
