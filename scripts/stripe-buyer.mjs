// Buyer-only sandbox token issuance. No merchant or worker credentials belong here.
const TEST_HELPER_URL = 'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens';

export function createSandboxTokenIssuer({ quote, key, testNetworkId, fetchImpl = globalThis.fetch }) {
  if (!/^(sk|rk)_test_/.test(key ?? '')) throw new Error('Set MPPX_STRIPE_SECRET_KEY to a buyer Stripe sandbox key in your terminal.');
  if (testNetworkId !== undefined && testNetworkId !== 'internal') throw new Error('MPPX_STRIPE_TEST_NETWORK_ID only supports the explicit internal sandbox network.');
  if (quote?.payment_mode !== 'test' || quote.amount_minor !== 50 || quote.currency?.toLowerCase() !== 'usd' || !quote.quote_id) {
    throw new Error('Buyer only authorizes the USD 0.50 Stripe sandbox pack. Inspect quote.');
  }
  let attempted = false;
  return async function createToken({ amount, currency, networkId, expiresAt, challenge, metadata }) {
    const profile = typeof networkId === 'string' && networkId.startsWith('profile_test_');
    const internal = testNetworkId === 'internal' && networkId === 'internal';
    if (Number(amount) !== quote.amount_minor || currency?.toLowerCase() !== quote.currency.toLowerCase() ||
        !(profile || internal) || challenge?.request?.externalId !== quote.quote_id) {
      throw new Error('MPP challenge does not match the authorized sandbox quote.');
    }
    if (attempted) throw new Error('Sandbox token issuance was already attempted for this buyer. Inspect the job before another payment.');
    const core = {
      payment_method: 'pm_card_visa', 'usage_limits[currency]': currency,
      'usage_limits[max_amount]': String(amount), 'usage_limits[expires_at]': String(expiresAt),
    };
    const body = new URLSearchParams({ ...core, 'seller_details[network_id]': networkId });
    for (const [name, value] of Object.entries(metadata ?? {})) {
      if (typeof value !== 'string') throw new Error('MPP challenge supplied invalid Stripe metadata.');
      body.set(`metadata[${name}]`, value);
    }
    attempted = true;
    const send = async (form) => {
      try {
        return await fetchImpl(TEST_HELPER_URL, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2026-07-29.preview' },
          body: form, signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error('Stripe sandbox token request had no definitive response. No automatic retry; inspect the job before another payment.');
      }
    };
    let response = await send(body);
    if (!response.ok) {
      let failure;
      try { failure = await response.json(); } catch { /* Unreadable failure is not a safe compatibility retry. */ }
      const parameter = failure?.error?.param;
      const optionalParameter = typeof parameter === 'string' && /^(seller_details|metadata)(\[|$)/.test(parameter);
      // A known unsupported optional field is a definitive pre-token rejection.
      // Never retry a timeout, server error, decline or any unknown outcome.
      if (response.status === 400 && failure?.error?.code === 'parameter_unknown' && optionalParameter) {
        response = await send(new URLSearchParams(core));
      }
    }
    if (!response.ok) throw new Error(`Stripe sandbox token creation failed (HTTP ${response.status}); check test-helper access and your buyer key. No automatic retry.`);
    let token;
    try { token = await response.json(); } catch { throw new Error('Stripe returned an unreadable sandbox token response. No automatic retry.'); }
    if (typeof token.id !== 'string' || !token.id) throw new Error('Stripe returned no shared payment token. No automatic retry.');
    return token.id;
  };
}
