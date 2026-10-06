import {
  MIN_ROBUX, MAX_ROBUX,
  computeReceived, computeProductPrice,
  getOrCreateProduct, getEnvConfig, json,
} from "./_helpers.js";

// POST /api/donate  { amount, coverTax } -> { productId, price, received, ... }
export async function onRequest(context) {
  const { request, env } = context;
  console.log("[donate] handler called, method:", request.method);

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }

  const { apiKey, universeId } = getEnvConfig(env);
  console.log("[donate] ENV check — API_KEY set:", !!apiKey, "UNIVERSE_ID:", universeId);

  if (!apiKey || !universeId) {
    console.error("[donate] Missing env vars!");
    return json({ error: "Server not configured. Set ROBLOX_API_KEY and UNIVERSE_ID in Cloudflare env vars." }, 500);
  }

  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    console.log("[donate] body:", JSON.stringify(body));
    const { amount: rawAmount, coverTax } = body || {};
    const amount = Math.floor(Number(rawAmount));

    if (!Number.isFinite(amount) || amount < MIN_ROBUX || amount > MAX_ROBUX) {
      return json({ error: `Amount must be between ${MIN_ROBUX} and ${MAX_ROBUX.toLocaleString("en-US")}` }, 400);
    }

    const shouldCoverTax = coverTax === true;
    const price = computeProductPrice(amount, shouldCoverTax);
    const received = computeReceived(price);
    console.log("[donate] amount:", amount, "price:", price, "received:", received);

    console.log("[donate] calling getOrCreateProduct...");
    const product = await getOrCreateProduct(request, env, amount, price);
    console.log("[donate] product result:", JSON.stringify(product));

    if (!product) {
      return json({ error: "Could not create developer product. Try again shortly!" }, 502);
    }

    const productLink = `https://www.roblox.com/developer-product/${universeId}/product/${product.id}`;

    return json({ productId: product.id, price, received, amount, coverTax: shouldCoverTax, productLink });
  } catch (err) {
    console.error("[donate] UNCAUGHT ERROR:", err?.stack || err?.message || err);
    return json({ error: "Internal server error" }, 500);
  }
}
