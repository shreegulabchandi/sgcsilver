/**
 * SGC Auto Price Updater
 * ─────────────────────────────────────────────────────────────────
 * What this does (every X hours):
 *   1. Fetches live silver spot price (INR/toz) from metals.dev
 *   2. Converts to INR/gram and adds 9% margin → stored as shop
 *      metafield "silver_price"
 *   3. Updates every variant price using:
 *        price = CEIL_10( (silver_price_per_gram + 35) × weight_g × 1.03 )
 *      Fallback ₹5000 if variant has no silver_weight set
 *
 * Formula:
 *   new_per_gram = (live_inr_per_toz / 31.1035) × 1.09
 *   variant_price = (new_per_gram + 35) × silver_weight_g × 1.03
 * ─────────────────────────────────────────────────────────────────
 */

const https = require('https');

// ═══════════════════════════════════════════════════════════
//  CONFIG — set these as environment variables on Railway
//  (or in .env file for local testing)
// ═══════════════════════════════════════════════════════════
const SHOP_DOMAIN      = process.env.SHOP_DOMAIN;
const CLIENT_ID        = process.env.CLIENT_ID;
const CLIENT_SECRET    = process.env.CLIENT_SECRET;
const METALS_API_KEY   = process.env.METALS_API_KEY;
const INTERVAL_HOURS   = parseFloat(process.env.INTERVAL_HOURS || '1');
// ═══════════════════════════════════════════════════════════

const API_VERSION    = '2024-04';
const FALLBACK_PRICE = 5000;
const TROY_OZ_TO_G   = 31.1035; // 1 troy oz = 31.1035 grams

// ── Validate config ──────────────────────────────────────────
function validateConfig() {
  const missing = ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET', 'METALS_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}\nCheck your Railway environment settings.`);
  }
}

// ── Price formulas ───────────────────────────────────────────

// new_per_gram = live_inr_per_gram × 1.09  (9% added)
function calcSilverMetafieldPrice(livePriceInrPerGram) {
  return livePriceInrPerGram * 1.09;
}

// variant_price = (silver_price_per_gram + 45) × weight_g
// rounded UP to nearest ₹100  (e.g. 323 → 400, 367 → 400, 401 → 500)
function calcVariantPrice(weightG, silverPricePerG) {
  const raw = (silverPricePerG + 45) * weightG;
  return Math.ceil(raw / 100) * 100;
}

// ── Generic HTTPS GET (with optional headers) ────────────────
function httpsGet(reqUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...headers },
    };
    https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    }).on('error', reject).end();
  });
}

// ── Generic HTTPS POST (form-encoded) ───────────────────────
function httpsPost(hostname, path, formBody) {
  return new Promise((resolve, reject) => {
    const payload = formBody;
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Get Shopify access token ─────────────────────────────────
let ACCESS_TOKEN = null;

async function fetchAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();

  const res = await httpsPost(SHOP_DOMAIN, '/admin/oauth/access_token', body);
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`Token fetch failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

// ── Shopify API helper ───────────────────────────────────────
function shopifyRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SHOP_DOMAIN,
      path:     `/admin/api/${API_VERSION}${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type':           'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ${msg}`);
}

// ── Step 1: Fetch live silver price in INR/gram ──────────────
async function fetchLiveSilverPriceINR() {
  const apiUrl = `https://api.metals.dev/v1/latest?api_key=${METALS_API_KEY}&currency=INR&unit=toz`;
  const res = await httpsGet(apiUrl);

  if (res.status !== 200 || !res.body || res.body.status !== 'success') {
    throw new Error(`metals.dev API failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  const inrPerTroyOz = parseFloat(res.body.metals && res.body.metals.silver);
  if (isNaN(inrPerTroyOz) || inrPerTroyOz <= 0) {
    throw new Error(`Invalid silver price from metals.dev: ${JSON.stringify(res.body.metals)}`);
  }

  const inrPerGram = inrPerTroyOz / TROY_OZ_TO_G;
  log(`🌐 metals.dev API response → silver: ₹${inrPerTroyOz.toFixed(2)} per troy oz (INR/toz)`);
  log(`📏 Converted to grams     → ₹${inrPerTroyOz.toFixed(2)} ÷ 31.1035 = ₹${inrPerGram.toFixed(4)} per gram`);
  return inrPerGram;
}

// ── Step 2: Update silver_price shop metafield ───────────────
async function updateSilverMetafield(newPrice) {
  const res = await shopifyRequest('GET', '/metafields.json?namespace=custom&key=silver_price');
  const existing = (res.body.metafields || []).find(
    m => m.namespace === 'custom' && m.key === 'silver_price'
  );

  const payload = {
    metafield: {
      namespace: 'custom',
      key:       'silver_price',
      value:     String(newPrice.toFixed(4)),
      type:      'number_decimal',
    },
  };

  if (existing) {
    const upd = await shopifyRequest('PUT', `/metafields/${existing.id}.json`, payload);
    if (upd.status !== 200) throw new Error(`Metafield update failed (${upd.status})`);
  } else {
    const crt = await shopifyRequest('POST', '/metafields.json', payload);
    if (crt.status !== 201) throw new Error(`Metafield create failed (${crt.status})`);
  }

  log(`✅ Shop metafield silver_price updated → ₹${newPrice.toFixed(4)}/gram`);
}

// ── Step 3: Fetch all products ───────────────────────────────
async function getAllProducts() {
  const all = [];
  let sinceId = 0;
  while (true) {
    const path = `/products.json?limit=250&fields=id,title,variants${sinceId ? '&since_id=' + sinceId : ''}`;
    const res = await shopifyRequest('GET', path);
    if (res.status !== 200) throw new Error(`Products fetch failed (${res.status})`);
    const batch = res.body.products || [];
    all.push(...batch);
    if (batch.length < 250) break;
    sinceId = batch[batch.length - 1].id;
    await sleep(400);
  }
  return all;
}

// ── Step 4: Get variant silver weight ────────────────────────
async function getVariantSilverWeight(productId, variantId) {
  const res = await shopifyRequest('GET', `/products/${productId}/variants/${variantId}/metafields.json`);
  if (res.status !== 200) return null;
  const mf = (res.body.metafields || []).find(
    m => m.namespace === 'custom' && m.key === 'silver_weight_in_grams'
  );
  if (!mf || !mf.value) return null;
  const val = parseFloat(mf.value);
  return isNaN(val) || val <= 0 ? null : val;
}

// ── Step 5: Update variant price ────────────────────────────
async function updateVariantPrice(variantId, priceRupees) {
  const res = await shopifyRequest('PUT', `/variants/${variantId}.json`, {
    variant: { id: variantId, price: priceRupees.toFixed(2) },
  });
  return res.status === 200;
}

// ── Main update cycle ────────────────────────────────────────
async function runUpdateCycle() {
  log('═'.repeat(50));
  log('🔄 Starting price update cycle...');

  try {
    // Refresh token each cycle
    ACCESS_TOKEN = await fetchAccessToken();

    // 1. Live silver price from metals.dev (INR/gram)
    const livePriceInrPerGram = await fetchLiveSilverPriceINR();

    // 2. Apply 9% margin → new per gram price
    const silverPrice = calcSilverMetafieldPrice(livePriceInrPerGram);
    log(`💹 After 9% margin        → ₹${livePriceInrPerGram.toFixed(4)} × 1.09 = ₹${silverPrice.toFixed(4)} per gram`);

    // 3. Update shop metafield
    await updateSilverMetafield(silverPrice);

    // 4. Get all products
    const products = await getAllProducts();
    log(`📦 ${products.length} products found`);

    let updated = 0, fallback = 0, failed = 0;

    for (const product of products) {
      for (const variant of product.variants) {
        await sleep(250);
        const weightG = await getVariantSilverWeight(product.id, variant.id);

        let newPrice;
        if (weightG === null) {
          newPrice = FALLBACK_PRICE;
          fallback++;
        } else {
          newPrice = calcVariantPrice(weightG, silverPrice);
          updated++;
          log(`   📦 ${product.title} [${variant.title}] | weight: ${weightG}g | (₹${silverPrice.toFixed(2)}+45) × ${weightG} = ₹${newPrice}`);
        }

        const ok = await updateVariantPrice(variant.id, newPrice);
        if (!ok) {
          log(`❌ Failed: ${product.title} [${variant.title}]`);
          failed++;
        }
        await sleep(150);
      }
    }

    log(`✅ Done — ${updated} priced by formula | ${fallback} fallback ₹${FALLBACK_PRICE} | ${failed} failed`);

  } catch (err) {
    log(`❌ Cycle error: ${err.message}`);
  }

  log(`⏰ Next run in ${INTERVAL_HOURS} hour(s)`);
  log('═'.repeat(50));
}

// ── Entry point ──────────────────────────────────────────────
validateConfig();

log('🚀 SGC Auto Price Updater started');
log(`   Shop     : ${SHOP_DOMAIN}`);
log(`   Interval : every ${INTERVAL_HOURS} hour(s)`);
log(`   Formula  : (silver_price/g + ₹35) × weight × 1.03  |  silver_price = live×1.09`);

// Run immediately, then on interval
runUpdateCycle();
setInterval(runUpdateCycle, INTERVAL_HOURS * 60 * 60 * 1000);
