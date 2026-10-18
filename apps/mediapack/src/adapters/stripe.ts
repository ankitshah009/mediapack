// Stripe + mppx (SPT-only MPP) adapter. Mppx instance is built once; per-request options bind the challenge
// to route, quote, job and terms.
import Stripe from "stripe";
import { Mppx, Store, stripe as mppxStripe } from "mppx/server";
import { Receipt } from "mppx";
import { mppSecret, requireStripe, requireStripeWebhookSecret, type Config } from "../config.js";

export interface ChargeBinding {
  amountMinor: number;
  currency: string;
  quoteId: string;
  jobId: string;
  termsHash: string;
  route: string; // "POST /v1/jobs/<id>/purchase"
  /** Called by mppx just before it creates the PaymentIntent; returns trusted metadata. */
  intentMetadata?: () => Record<string, string>;
}

export type ChargeOutcome =
  | { status: 402; response: Response; reachedStripe: boolean }
  | { status: 200; reference: string; receiptHeader: string | null; withReceipt: (r: Response) => Response };

export interface StripeAdapter {
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  searchPaymentIntentsByAttempt(attemptId: string): Promise<Stripe.PaymentIntent[]>;
  constructEvent(rawBody: string, signature: string | undefined): Stripe.Event;
  /** Runs the MPP gate. No credential => 402 challenge; credential => may charge. */
  charge(request: Request, binding: ChargeBinding): Promise<ChargeOutcome>;
  readonly livemode: boolean;
}

export function createStripeAdapter(cfg: Config): StripeAdapter {
  type AnyMppx = { charge: (o: Record<string, unknown>) => (r: Request) => Promise<any> };
  let built: { client: Stripe; mppx: AnyMppx } | undefined;
  const build = () => {
    if (built) return built;
    const { secretKey, profileId } = requireStripe(cfg);
    const apiBase = cfg.stripeApiBase ? new URL(cfg.stripeApiBase) : undefined;
    const client = new Stripe(secretKey, {
      timeout: cfg.stripeTimeoutMs,
      maxNetworkRetries: 0,
      ...(apiBase ? { host: apiBase.hostname, port: apiBase.port, protocol: apiBase.protocol.replace(":", "") as "http" | "https" } : {}),
    });
    const livemode = !/_test_/.test(secretKey);
    const smp = mppxStripe.create({ client, networkId: profileId, livemode, store: Store.memory() });
    const mppx = Mppx.create({
      methods: [smp.spt.charge()],
      secretKey: mppSecret(cfg),
      realm: new URL(cfg.publicOrigin).host,
    });
    return (built = { client, mppx: mppx as unknown as AnyMppx });
  };

  return {
    get livemode() { return !/_test_/.test(requireStripe(cfg).secretKey); },
    retrievePaymentIntent: (id) => build().client.paymentIntents.retrieve(id),
    async searchPaymentIntentsByAttempt(attemptId) {
      const r = await build().client.paymentIntents.search({ query: `metadata['attempt_id']:'${attemptId.replace(/'/g, "")}'`, limit: 5 });
      return r.data;
    },
    constructEvent(raw, signature) {
      return build().client.webhooks.constructEvent(raw, signature ?? "", requireStripeWebhookSecret(cfg));
    },
    async charge(request, b) {
      const { mppx } = build();
      let reached = false;
      const result = await mppx.charge({
        amount: (b.amountMinor / 100).toFixed(2),
        description: `MediaPack video pack (quote ${b.quoteId})`,
        externalId: b.quoteId, // HMAC-bound in the challenge and echoed in the credential
        scope: b.route,
        meta: { job_id: b.jobId, quote_id: b.quoteId, terms_hash: b.termsHash },
        // Request-scoped PaymentIntent metadata (not serialized into the challenge).
        paymentIntentOptions: () => {
          reached = true;
          return { metadata: b.intentMetadata?.() ?? {} };
        },
      })(request);
      if (result.status === 402) return { status: 402, response: (result as { challenge: Response }).challenge, reachedStripe: reached };
      const ok = result as { withReceipt: (r: Response) => Response };
      const probe = ok.withReceipt(new Response(null, { status: 200 }));
      const receipt = Receipt.fromResponse(probe);
      return {
        status: 200,
        reference: receipt.reference,
        receiptHeader: probe.headers.get("payment-receipt"),
        withReceipt: ok.withReceipt,
      };
    },
  };
}
