import { MIN_ROBUX, MAX_ROBUX, computeReceived, computeProductPrice, json } from "./_helpers.js";

// POST /api/preview  { amount, coverTax } -> { price, received, amount }
export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ price: 0, received: 0 });
  }

  const { amount: rawAmount, coverTax } = body || {};
  const amount = Math.floor(Number(rawAmount));

  if (!Number.isFinite(amount) || amount < MIN_ROBUX || amount > MAX_ROBUX) {
    return json({ price: 0, received: 0 });
  }

  const price = computeProductPrice(amount, coverTax === true);
  const received = computeReceived(price);

  return json({ price, received, amount });
}
