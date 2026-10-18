import { createServer, type IncomingHttpHeaders } from "node:http";

export interface FakeStripeCall { headers: IncomingHttpHeaders; form: URLSearchParams }
export interface FakeFailure { status: number; body: unknown }

/**
 * A local stand-in for the Stripe HTTP API, used as STRIPE_API_BASE. It speaks only what the MPP flow touches:
 * the sandbox shared-token test helper, PaymentIntent create and PaymentIntent retrieve. Everything above this edge
 * (mppx client and server, the purchase gate, Postgres) is the real code.
 */
export async function startFakeStripe() {
  const intents = new Map<string, Record<string, unknown>>();
  const mints: FakeStripeCall[] = [];
  const charges: FakeStripeCall[] = [];
  const retrievals: string[] = [];
  const behavior = { mintDelayMs: 0, chargeDelayMs: 0, mintFailure: undefined as FakeFailure | undefined, chargeFailure: undefined as FakeFailure | undefined };
  let issued = 0;

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    // A caller that gave up (deadline tests) has closed its socket: answering it is a no-op, never an error.
    const send = (status: number, body: unknown) => { if (!res.destroyed && !res.writableEnded) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
    const path = new URL(req.url ?? "/", "http://fake.invalid").pathname;
    if (req.method === "POST" && path === "/v1/test_helpers/shared_payment/granted_tokens") {
      mints.push({ headers: req.headers, form });
      if (behavior.mintDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.mintDelayMs));
      if (behavior.mintFailure) return send(behavior.mintFailure.status, behavior.mintFailure.body);
      return send(200, { id: `spt_fake_${++issued}`, object: "shared_payment.granted_token" });
    }
    if (req.method === "POST" && path === "/v1/payment_intents") {
      const number = charges.push({ headers: req.headers, form }); // ids follow arrival order, even when charges overlap
      if (behavior.chargeDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.chargeDelayMs));
      if (behavior.chargeFailure) return send(behavior.chargeFailure.status, behavior.chargeFailure.body);
      const metadata: Record<string, string> = {};
      for (const [name, value] of form) { const m = /^metadata\[(.+)\]$/.exec(name); if (m) metadata[m[1]!] = value; }
      const intent = {
        id: `pi_fake_${number}`, object: "payment_intent", status: "succeeded", livemode: false,
        amount: Number(form.get("amount")), currency: form.get("currency"), metadata,
      };
      intents.set(intent.id, intent);
      return send(200, intent);
    }
    const retrieve = req.method === "GET" ? /^\/v1\/payment_intents\/(pi_\w+)$/.exec(path) : null;
    if (retrieve) {
      retrievals.push(retrieve[1]!);
      const intent = intents.get(retrieve[1]!);
      return intent ? send(200, intent) : send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
    }
    send(404, { error: { type: "invalid_request_error", message: `unexpected ${req.method} ${path}` } });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    mints, charges, retrievals, behavior,
    /** Every request that reached the fake, for "Stripe was never contacted" assertions. */
    get traffic() { return mints.length + charges.length + retrievals.length; },
    reset() {
      intents.clear(); mints.length = 0; charges.length = 0; retrievals.length = 0; issued = 0;
      Object.assign(behavior, { mintDelayMs: 0, chargeDelayMs: 0, mintFailure: undefined, chargeFailure: undefined });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type FakeStripe = Awaited<ReturnType<typeof startFakeStripe>>;
