// Shared helpers for Cloudflare Pages Functions.
// Pure Web APIs only — no fs, path, Buffer, process.env, or Node requires.
// Env vars come from the per-request `env` binding (context.env).

export const MIN_ROBUX = 1;
export const MAX_ROBUX = 1_000_000_000;
const RECEIVE_NUM = 7;
const RECEIVE_DEN = 10;
const PAGE_LIMIT = 100;
const MAX_RETRIES = 2;
const OC_BASE = "https://apis.rotunnel.com/developer-products/v2";

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let cachedProducts = null;
let lastCacheTime = 0;

// Product icon bytes, loaded once per isolate from the site's own static asset.
let cachedIconBytes = null; // Uint8Array | null
let iconLoadAttempted = false;

export function computeReceived(price) {
  return Math.max(1, Math.floor((Math.floor(price) * RECEIVE_NUM) / RECEIVE_DEN));
}

export function computeProductPrice(amount, coverTax) {
  let price = Math.floor(amount);
  if (coverTax) {
    price = Math.floor((price * RECEIVE_DEN + RECEIVE_NUM - 1) / RECEIVE_NUM);
  }
  return Math.max(1, price);
}

function fmtInt(n) {
  return Math.floor(n).toLocaleString("en-US");
}

function fillTemplate(tpl, amount, price) {
  return tpl
    .replace(/\{amount\}/g, fmtInt(amount))
    .replace(/\{price\}/g, fmtInt(price))
    .replace(/\{receiving\}/g, fmtInt(computeReceived(price)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getConfig(env) {
  return {
    apiKey: env?.ROBLOX_API_KEY,
    universeId: env?.UNIVERSE_ID,
    nameTpl: env?.PRODUCT_NAME_TEMPLATE || "Donate {receiving} Robux",
    descTpl: env?.PRODUCT_DESCRIPTION_TEMPLATE || "Donated {receiving} Robux via BloxTip.",
  };
}

// Loads public/Cash.png via the site's own URL. No fs on Workers —
// static assets are fetched over HTTP and cached in isolate memory.
async function getIconBytes(request) {
  if (iconLoadAttempted) return cachedIconBytes;
  iconLoadAttempted = true;
  try {
    const iconUrl = new URL("/Cash.png", request.url);
    const res = await fetch(iconUrl);
    if (!res.ok) {
      console.warn(`[helpers] No product icon at /Cash.png (${res.status}) — products will have no icon`);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    console.log(`[helpers] Loaded product icon: /Cash.png (${buf.length} bytes)`);
    cachedIconBytes = buf.length > 0 ? buf : null;
    return cachedIconBytes;
  } catch (e) {
    console.warn("[helpers] Could not load product icon — products will have no icon:", e?.message || e);
    return null;
  }
}

function buildForm(fields, iconBytes) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields || {})) {
    if (value != null) form.append(name, String(value));
  }
  if (iconBytes) {
    form.append("imageFile", new Blob([iconBytes], { type: "image/png" }), "Cash.png");
  }
  return form;
}

async function robloxRequest(method, urlPath, apiKey, fields, iconBytes) {
  const url = `${OC_BASE}${urlPath}`;
  console.log(`[roblox] ${method} ${url}`);

  const maxAttempts = method === "POST" ? 1 : MAX_RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const opts = { method, headers: { "x-api-key": apiKey, Accept: "application/json" } };
      if (fields) opts.body = buildForm(fields, iconBytes);

      const res = await fetch(url, opts);
      console.log(`[roblox] Response: ${res.status} ${res.statusText}`);
      if (res.ok) {
        const text = await res.text();
        return { ok: true, data: text ? JSON.parse(text) : {} };
      }
      const errText = await res.text().catch(() => "");
      console.warn(`[roblox] ERROR ${res.status}:`, errText.substring(0, 500));
      if (res.status !== 429 && res.status < 500)
        return { ok: false, error: errText, retryable: false };
      if (attempt < maxAttempts) {
        const ra = res.headers.get("retry-after");
        await sleep(ra ? Math.min(parseFloat(ra) * 1000, 30000) : 500 * 2 ** (attempt - 1));
      }
    } catch (e) {
      console.error(`[roblox] FETCH ERROR:`, e?.message || e);
      if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: "Request failed after retries", retryable: true };
}

function extractId(entry) {
  const raw = entry?.productId ?? entry?.id ?? entry?.Id ?? entry?.path;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const n = parseInt(raw, 10);
  if (!isNaN(n)) return n;
  const m = raw.match(/developer-?[Pp]roducts\/(\d+)/) || raw.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function extractPrice(entry) {
  const pi = entry?.priceInformation;
  if (pi) {
    const p = pi.defaultPriceInRobux ?? pi.priceInRobux;
    if (p != null) return Math.floor(Number(p));
  }
  const p = entry?.priceInRobux ?? entry?.PriceInRobux ?? entry?.basePrice ?? entry?.price ?? entry?.Price;
  return p != null ? Math.floor(Number(p)) : null;
}

function readProduct(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = extractId(entry);
  const price = extractPrice(entry);
  if (id == null || price == null) return null;
  return {
    id, priceInRobux: price,
    name: String(entry.name || entry.displayName || entry.Name || ""),
    description: String(entry.description || entry.Description || ""),
    isForSale: entry.isForSale === true || entry.IsForSale === true,
    storePageEnabled: entry.storePageEnabled === true,
    hasIcon: entry.iconImageAssetId != null && entry.iconImageAssetId !== null,
    isRegionalPricingEnabled: entry.isRegionalPricingEnabled === true ||
      entry.priceConfiguration?.isRegionalPricingEnabled === true,
  };
}

async function findExisting(price, apiKey, universeId) {
  const now = Date.now();
  if (cachedProducts && (now - lastCacheTime < CACHE_TTL)) {
    console.log(`[cache] findExisting hit in-memory cache for price ${price}`);
    const found = cachedProducts.find((p) => p.priceInRobux === price);
    if (found) return found;
  }

  console.log(`[cache] Cache miss or expired for price ${price}. Fetching fresh list from Roblox...`);
  const freshList = [];
  let cursor = null;
  do {
    let url = `/universes/${universeId}/developer-products/creator?pageSize=${PAGE_LIMIT}`;
    if (cursor) url += `&pageToken=${encodeURIComponent(cursor)}`;
    const r = await robloxRequest("GET", url, apiKey);
    if (!r.ok || !r.data) return null;
    const items = r.data.developerProducts || r.data.developer_products || r.data.data || [];
    for (const e of Array.isArray(items) ? items : Object.values(items)) {
      const p = readProduct(e);
      if (p) freshList.push(p);
    }
    cursor = r.data.nextPageToken || null;
  } while (cursor);

  cachedProducts = freshList;
  lastCacheTime = now;
  console.log(`[cache] Loaded ${freshList.length} developer products into cache`);

  return cachedProducts.find((p) => p.priceInRobux === price) || null;
}

async function createProduct(amount, price, ctx) {
  const { apiKey, universeId, nameTpl, descTpl } = ctx;
  const name = fillTemplate(nameTpl, amount, price);
  const desc = fillTemplate(descTpl, amount, price);

  const fields = {
    name,
    description: desc,
    price,
    isForSale: true,
    storePageEnabled: true,
  };

  const iconBytes = await getIconBytes(ctx.request);
  const r = await robloxRequest("POST", `/universes/${universeId}/developer-products`, apiKey, fields, iconBytes);
  if (!r.ok || !r.data) return { product: null, shouldRecover: r.retryable !== false };
  let product = readProduct(r.data);
  if (!product) {
    const id = extractId(r.data);
    if (id != null) product = { id, priceInRobux: price, name, description: desc, isForSale: true, storePageEnabled: true, hasIcon: !!iconBytes, isRegionalPricingEnabled: false };
  }

  if (product && product.priceInRobux === price && cachedProducts) {
    cachedProducts.push(product);
  }

  return product?.priceInRobux === price
    ? { product, shouldRecover: false }
    : { product: null, shouldRecover: true };
}

function patchBody(product, amount, nameTpl, descTpl) {
  const expName = fillTemplate(nameTpl, amount, product.priceInRobux);
  const expDesc = fillTemplate(descTpl, amount, product.priceInRobux);
  const body = {};
  if (product.name !== expName) body.name = expName;
  if (product.description !== expDesc) body.description = expDesc;
  if (!product.isForSale) body.isForSale = true;
  if (!product.storePageEnabled) body.storePageEnabled = true;
  if (product.isRegionalPricingEnabled) body.isRegionalPricingEnabled = false;

  const needsIcon = !product.hasIcon && cachedIconBytes;
  // Note: if the icon hasn't loaded yet at patch time, we still PATCH field
  // changes now; the icon will attach on a later create/update once cached.
  const hasFieldChanges = Object.keys(body).length > 0;
  return (hasFieldChanges || needsIcon) ? { fields: body, needsIcon } : null;
}

async function updateProduct(product, amount, ctx) {
  const { apiKey, universeId, nameTpl, descTpl } = ctx;
  const patch = patchBody(product, amount, nameTpl, descTpl);
  if (!patch) return product;

  const { fields, needsIcon } = patch;

  if (Object.keys(fields).length === 0 && needsIcon) {
    fields.name = fillTemplate(nameTpl, amount, product.priceInRobux);
  }

  const iconBytes = needsIcon ? (cachedIconBytes || await getIconBytes(ctx.request)) : null;

  const r = await robloxRequest("PATCH", `/universes/${universeId}/developer-products/${product.id}`, apiKey, fields, iconBytes);
  if (!r.ok) return null;
  const updated = r.data ? readProduct(r.data) : null;
  const finalProduct = updated || {
    ...product,
    ...fields,
    storePageEnabled: fields.storePageEnabled ?? product.storePageEnabled,
    hasIcon: needsIcon ? true : product.hasIcon,
  };

  if (cachedProducts) {
    const idx = cachedProducts.findIndex((p) => p.id === product.id);
    if (idx !== -1) cachedProducts[idx] = finalProduct;
  }

  return finalProduct;
}

export async function getOrCreateProduct(request, env, amount, price) {
  const { apiKey, universeId, nameTpl, descTpl } = getConfig(env);
  const ctx = { request, apiKey, universeId, nameTpl, descTpl };
  // Warm the icon cache in parallel with the product lookup (non-blocking).
  const iconWarm = getIconBytes(request).catch(() => null);
  let product = await findExisting(price, apiKey, universeId);
  await iconWarm;
  if (product) {
    if (patchBody(product, amount, nameTpl, descTpl)) product = await updateProduct(product, amount, ctx);
    return product;
  }
  const { product: created, shouldRecover } = await createProduct(amount, price, ctx);
  if (created) {
    // The Roblox create endpoint ignores storePageEnabled, so we PATCH it right after
    if (patchBody(created, amount, nameTpl, descTpl)) {
      const patched = await updateProduct(created, amount, ctx);
      return patched || created;
    }
    return created;
  }
  if (shouldRecover) {
    await sleep(1500);
    const recovered = await findExisting(price, apiKey, universeId);
    if (recovered && patchBody(recovered, amount, nameTpl, descTpl)) {
      const patched = await updateProduct(recovered, amount, ctx);
      return patched || recovered;
    }
    return recovered;
  }
  return null;
}

export async function getUniverseDetails(universeId) {
  try {
    const res = await fetch(`https://games.rotunnel.com/v1/games?universeIds=${universeId}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.data && data.data.length > 0) {
      return data.data[0];
    }
  } catch (e) {
    console.error("Failed to fetch universe details:", e?.message || e);
  }
  return null;
}

export function getEnvConfig(env) {
  return getConfig(env);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
