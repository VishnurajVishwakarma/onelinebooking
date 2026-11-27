import { OneLineBookingClient, OneLineBookingApiError } from "@onelinebooking/sdk/server";

function getServerClient() {
  return new OneLineBookingClient({
    baseUrl: process.env.OLB_API_URL ?? "http://127.0.0.1:4100",
    apiKey: process.env.OLB_API_KEY ?? "",
    tenantId: process.env.OLB_TENANT_ID,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const avail = await getServerClient().availability.get({
    facilityId: url.searchParams.get("facilityId") ?? "",
    fromDate: url.searchParams.get("fromDate") ?? "",
    toDate: url.searchParams.get("toDate") ?? "",
  });
  return Response.json(avail);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { facilityId: string; slotRefs: string[]; customerId?: string };
    const key = req.headers.get("idempotency-key") ?? crypto.randomUUID();
    const client = getServerClient();
    const hold = await client.holds.create(
      { facilityId: body.facilityId, slotRefs: body.slotRefs, externalCustomerId: body.customerId },
      { idempotencyKey: `${key}:hold` },
    );
    const booking = await client.holds.convert(hold.id, {}, { idempotencyKey: `${key}:confirm` });
    return Response.json({ booking }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof OneLineBookingApiError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
