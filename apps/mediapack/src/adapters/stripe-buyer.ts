// Sandbox shared-payment-token issuance for the in-browser demo agent (services/demoBuyer.ts).
// KEEP IN SYNC with scripts/stripe-buyer.mjs (createSandboxTokenIssuer): this is a faithful TypeScript port of the
// CLI buyer's issuer. Validation, the test-helper request, the optional-parameter fallback, the 30 s timeout and the
// no-automatic-retry rule must change in both files together. Differences: typed errors, messages worded for a server
// operator instead of a terminal, and an optional apiBase so the local fake Stripe harness (STRIPE_API_BASE) is honoured.
// Test mode only: the key is the merchant's own sk_test_/rk_test_ key and the network is the explicit `internal`
// sandbox network. config.demoBuyer is the gate that guarantees that before this module is ever reached.

const DEFAULT_API_BASE = "https://api.stripe.com";
const TEST_HELPER_PATH = "/v1/test_helpers/shared_payment/granted_tokens";

/** Curated, secret-free failure: the message is safe to show to a browser user and to log. */
export class SandboxTokenError extends Error {
  /** Stripe's HTTP status when it answered definitively; undefined when there was no response at all. */
  readonly httpStatus?: number;
  /** True when the same request may succeed later (no/unreadable response, 429, 5xx). Never implies an automatic retry. */
  readonly transient: boolean;
  constructor(message: string, opts: { httpStatus?: number; transient?: boolean } = {}) {
    super(message);
    this.name = "SandboxTokenError";
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    this.transient = opts.transient ?? false;
  }
}

/** The quote fields the issuer authorizes against (a subset of the Quote wire contract). */
export interface BuyerQuote {
  quote_id: string;
  payment_mode: string;
  amount_minor: number;
  currency: string;
}

/** The subset of mppx's `stripe.charge({ createToken })` parameters that the issuer validates and forwards. */
export interface TokenRequest {
  amount: string;
  currency: string;
  networkId?: string | undefined;
  expiresAt: number;
  challenge?: { request?: { externalId?: string | undefined } | undefined } | undefined;
  metadata?: Record<string, string> | undefined;
}

export interface SandboxTokenIssuerOptions {
  quote: BuyerQuote;
  key: string | undefined;
  testNetworkId?: string | undefined;
  /** Test harness only (STRIPE_API_BASE); defaults to the real Stripe API. */
  apiBase?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createSandboxTokenIssuer({ quote, key, testNetworkId, apiBase, fetchImpl = globalThis.fetch }: SandboxTokenIssuerOptions) {
  if (!/^(sk|rk)_test_/.test(key ?? "")) throw new SandboxTokenError("The demo buyer requires a Stripe sandbox key (sk_test_/rk_test_).");
  if (testNetworkId !== undefined && testNetworkId !== "internal") throw new SandboxTokenError("STRIPE_TEST_NETWORK_ID only supports the explicit internal sandbox network.");
  if (quote?.payment_mode !== "test" || quote.amount_minor !== 50 || quote.currency?.toLowerCase() !== "usd" || !quote.quote_id) {
    throw new SandboxTokenError("Buyer only authorizes the USD 0.50 Stripe sandbox pack. Inspect quote.");
  }
  const secret = key as string;
  const helperUrl = new URL(TEST_HELPER_PATH, apiBase ?? DEFAULT_API_BASE).href;
  let attempted = false;
  return async function createToken({ amount, currency, networkId, expiresAt, challenge, metadata }: TokenRequest): Promise<string> {
    const profile = typeof networkId === "string" && networkId.startsWith("profile_test_");
    const internal = testNetworkId === "internal" && networkId === "internal";
    if (Number(amount) !== quote.amount_minor || currency?.toLowerCase() !== quote.currency.toLowerCase() ||
        !(profile || internal) || challenge?.request?.externalId !== quote.quote_id) {
      throw new SandboxTokenError("MPP challenge does not match the authorized sandbox quote.");
    }
    if (attempted) throw new SandboxTokenError("Sandbox token issuance was already attempted for this buyer. Inspect the job before another payment.");
    const core = {
      payment_method: "pm_card_visa", "usage_limits[currency]": currency,
      "usage_limits[max_amount]": String(amount), "usage_limits[expires_at]": String(expiresAt),
    };
    const body = new URLSearchParams({ ...core, "seller_details[network_id]": networkId as string });
    for (const [name, value] of Object.entries(metadata ?? {})) {
      if (typeof value !== "string") throw new SandboxTokenError("MPP challenge supplied invalid Stripe metadata.");
      body.set(`metadata[${name}]`, value);
    }
    attempted = true;
    const send = async (form: URLSearchParams) => {
      try {
        return await fetchImpl(helperUrl, {
          method: "POST", redirect: "error",
          headers: { authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded", "Stripe-Version": "2026-07-29.preview" },
          body: form, signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new SandboxTokenError("Stripe sandbox token request had no definitive response. No automatic retry; inspect the job before another payment.", { transient: true });
      }
    };
    let response = await send(body);
    if (!response.ok) {
      let failure: { error?: { param?: unknown; code?: unknown } } | undefined;
      try { failure = await response.json(); } catch { /* Unreadable failure is not a safe compatibility retry. */ }
      const parameter = failure?.error?.param;
      const optionalParameter = typeof parameter === "string" && /^(seller_details|metadata)(\[|$)/.test(parameter);
      // A known unsupported optional field is a definitive pre-token rejection.
      // Never retry a timeout, server error, decline or any unknown outcome.
      if (response.status === 400 && failure?.error?.code === "parameter_unknown" && optionalParameter) {
        response = await send(new URLSearchParams(core));
      }
    }
    if (!response.ok) {
      throw new SandboxTokenError(`Stripe sandbox token creation failed (HTTP ${response.status}); check test-helper access and the Stripe key. No automatic retry.`,
        { httpStatus: response.status, transient: response.status === 429 || response.status >= 500 });
    }
    let token: { id?: unknown } | null;
    try { token = await response.json(); } catch { throw new SandboxTokenError("Stripe returned an unreadable sandbox token response. No automatic retry.", { transient: true }); }
    if (typeof token?.id !== "string" || !token.id) throw new SandboxTokenError("Stripe returned no shared payment token. No automatic retry.", { transient: true });
    return token.id;
  };
}
