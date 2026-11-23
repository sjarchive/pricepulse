import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextCheckAt,
  detectPlatform,
  evaluatePriceDrop,
  formatCompactCurrency,
  inferTitleFromUrl,
  isValidEmail,
  isValidTelegramChatId,
  parseLocalePrice,
  sanitizeExternalUrl,
  validateCheckInterval,
} from './priceUtils';
import {
  extractProductFromHtml,
  isPrivateOrReservedIp,
  parsePriceNumber,
} from '../../server/scraper';
import {
  extractProductFromHtmlEdge,
  extractProductWithWorkersAi,
  validateEdgePublicUrl,
} from '../../worker/scraper';

test('detectPlatform recognizes Amazon, Flipkart, Myntra, Ajio, Croma, Walmart and infers currency', () => {
  assert.deepEqual(detectPlatform('https://www.amazon.in/dp/B09XS7JWHH'), {
    platform: 'amazon',
    platformLabel: 'Amazon',
    currency: 'INR',
  });
  assert.deepEqual(detectPlatform('https://www.amazon.com/dp/B09XS7JWHH'), {
    platform: 'amazon',
    platformLabel: 'Amazon',
    currency: 'USD',
  });
  assert.deepEqual(detectPlatform('https://www.flipkart.com/apple-macbook-air/p/itm123'), {
    platform: 'flipkart',
    platformLabel: 'Flipkart',
    currency: 'INR',
  });
  assert.deepEqual(detectPlatform('https://www.myntra.com/shoes/asics/12345/buy'), {
    platform: 'myntra',
    platformLabel: 'Myntra',
    currency: 'INR',
  });
  assert.deepEqual(detectPlatform('https://www.walmart.com/ip/12345'), {
    platform: 'walmart',
    platformLabel: 'Walmart',
    currency: 'USD',
  });
});

test('inferTitleFromUrl extracts readable product names from store slugs', () => {
  const title = inferTitleFromUrl(
    'https://www.amazon.in/Sony-WH-1000XM5-Wireless-Cancelling-Headphones/dp/B09XS7JWHH'
  );
  assert.match(title, /Sony/i);
  assert.match(title, /Headphones/i);
});

test('validateCheckInterval strictly enforces minimum 1 hour and max 720 hours', () => {
  assert.equal(validateCheckInterval(0.5).valid, false);
  assert.equal(validateCheckInterval(0).valid, false);
  assert.equal(validateCheckInterval(-2).valid, false);
  assert.equal(validateCheckInterval(1).valid, true);
  assert.equal(validateCheckInterval(1).value, 1);
  assert.equal(validateCheckInterval(6).valid, true);
  assert.equal(validateCheckInterval(721).valid, false);
});

test('computeNextCheckAt advances ISO timestamp by interval hours', () => {
  const start = '2026-11-22T10:00:00.000Z';
  assert.equal(computeNextCheckAt(start, 1), '2026-11-22T11:00:00.000Z');
  assert.equal(computeNextCheckAt(start, 4), '2026-11-22T14:00:00.000Z');
});

test('evaluatePriceDrop applies any_drop, percent_drop, and target_price rules accurately', () => {
  const anyDrop = evaluatePriceDrop(25000, 24000, null, {
    triggerMode: 'any_drop',
    minDropPercent: 5,
  });
  assert.equal(anyDrop.isDrop, true);
  assert.equal(anyDrop.shouldNotify, true);
  assert.equal(anyDrop.dropAmount, 1000);
  assert.equal(anyDrop.dropPercent, 4);

  const percentTooSmall = evaluatePriceDrop(25000, 24000, 20000, {
    triggerMode: 'percent_drop',
    minDropPercent: 10,
  });
  assert.equal(percentTooSmall.isDrop, true);
  assert.equal(percentTooSmall.shouldNotify, false);

  const hitTarget = evaluatePriceDrop(25000, 19900, 20000, {
    triggerMode: 'target_price',
    minDropPercent: 10,
  });
  assert.equal(hitTarget.shouldNotify, true);

  const priceRose = evaluatePriceDrop(25000, 26000, 27000, {
    triggerMode: 'any_drop',
    minDropPercent: 5,
  });
  assert.equal(priceRose.isDrop, false);
  assert.equal(priceRose.shouldNotify, false);
});

test('sanitizeExternalUrl blocks javascript and data URIs while allowing https and local assets', () => {
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeExternalUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeExternalUrl('https://www.amazon.in/dp/B09XS7JWHH'), 'https://www.amazon.in/dp/B09XS7JWHH');
  assert.equal(
    sanitizeExternalUrl('/src/assets/images/product_sony_headphones_1795363897577.jpg'),
    '/src/assets/images/product_sony_headphones_1795363897577.jpg'
  );
});

test('isPrivateOrReservedIp blocks loopback, RFC1918, and cloud metadata IPs', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
  assert.equal(isPrivateOrReservedIp('172.16.12.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.20'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
});

test('extractProductFromHtml parses JSON-LD, Flipkart, and Amazon product markup', () => {
  const jsonLdHtml = `
    <html><head>
      <script type="application/ld+json">
        {"@type":"Product","name":"Nothing Phone (3) 256GB","offers":{"price":"42999","priceCurrency":"INR","availability":"https://schema.org/InStock"}}
      </script>
    </head><body></body></html>
  `;
  const res1 = extractProductFromHtml(jsonLdHtml, 'https://www.flipkart.com/nothing-phone-3/p/itm99');
  assert.equal(res1.fetchStatus, 'extracted');
  assert.equal(res1.title, 'Nothing Phone (3) 256GB');
  assert.equal(res1.price, 42999);
  assert.equal(res1.currency, 'INR');

  const amazonHtml = `
    <html><head><title>Logitech MX Master 3S - Amazon.in</title></head>
    <body>
      <span id="productTitle">Logitech MX Master 3S Wireless Mouse</span>
      <span class="a-price"><span class="a-offscreen">₹8,995.00</span></span>
    </body></html>
  `;
  const res2 = extractProductFromHtml(amazonHtml, 'https://www.amazon.in/dp/B0B11LJ69K');
  assert.equal(res2.fetchStatus, 'extracted');
  assert.equal(res2.price, 8995);
  assert.equal(res2.platform, 'amazon');

  assert.equal(parsePriceNumber('₹1,24,999'), 124999);
  assert.equal(parsePriceNumber('$249.50'), 249.5);
});

test('email and Telegram chat ID validators check expected formats', () => {
  assert.equal(isValidEmail('buyer@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidTelegramChatId('123456789'), true);
  assert.equal(isValidTelegramChatId('-1001987654321'), true);
  assert.equal(isValidTelegramChatId('@username'), false);
});

test('worker edge scraper extracts JSON-LD and Amazon prices and blocks private URLs', () => {
  assert.throws(() => validateEdgePublicUrl('http://127.0.0.1/admin'));
  assert.throws(() => validateEdgePublicUrl('http://169.254.169.254/latest/meta-data/'));
  assert.throws(() => validateEdgePublicUrl('http://localhost:3000/test'));
  assert.equal(
    validateEdgePublicUrl('https://www.amazon.in/dp/B09XS7JWHH').hostname,
    'www.amazon.in'
  );

  const html = `
    <html><head>
      <script type="application/ld+json">
        {"@type":"Product","name":"Sony WH-1000XM5","offers":{"price":"24989","priceCurrency":"INR"}}
      </script>
    </head><body></body></html>
  `;
  const parsed = extractProductFromHtmlEdge(html, 'https://www.amazon.in/dp/B09XS7JWHH');
  assert.equal(parsed.fetchStatus, 'extracted');
  assert.equal(parsed.price, 24989);
  assert.equal(parsed.title, 'Sony WH-1000XM5');
});

test('extractProductWithWorkersAi parses JSON fallback response and refuses null prices', async () => {
  const messyHtml = `
    <html><head><title>Nothing Ear (a) Wireless Earbuds - Store</title></head>
    <body><div>Nothing Ear (a) ANC Wireless Earbuds Special Deal Price today only: Rs 5,999 (MRP Rs 7,999). In stock and ready to ship across India.</div></body></html>
  `;
  const url = 'https://www.croma.com/nothing-ear-a/p/305123';
  const base = extractProductFromHtmlEdge(messyHtml, url);
  assert.equal(base.fetchStatus, 'partial');

  const mockAiSuccess = {
    async run() {
      return {
        response: '{"title":"Nothing Ear (a) Wireless Earbuds","price":5999,"currency":"INR","inStock":true}',
      };
    },
  };
  const aiResult = await extractProductWithWorkersAi(mockAiSuccess, messyHtml, url, base);
  assert.equal(aiResult.fetchStatus, 'extracted');
  assert.equal(aiResult.price, 5999);
  assert.match(aiResult.note, /Workers AI/);

  const mockAiNull = {
    async run() {
      return { response: '{"title":null,"price":null,"currency":null,"inStock":true}' };
    },
  };
  const fallbackResult = await extractProductWithWorkersAi(mockAiNull, messyHtml, url, base);
  assert.equal(fallbackResult.price, null);
  assert.equal(fallbackResult.fetchStatus, 'partial');
});

test('parseLocalePrice accurately parses US, Indian, and European price formats', () => {
  assert.equal(parseLocalePrice('₹1,24,999'), 124999);
  assert.equal(parseLocalePrice('₹24,990.50'), 24990.5);
  assert.equal(parseLocalePrice('$1,299.99'), 1299.99);
  assert.equal(parseLocalePrice('€1.299,00'), 1299);
  assert.equal(parseLocalePrice('1.299,99 €'), 1299.99);
  assert.equal(parseLocalePrice('EUR 49,95'), 49.95);
  assert.equal(parseLocalePrice('€1.299'), 1299);
  assert.equal(parseLocalePrice('£799.00'), 799);
});

test('validateEdgePublicUrl allows public domains starting with fc/fd/fe while blocking IPv6 private literals', () => {
  assert.equal(validateEdgePublicUrl('https://fc-moto.de/en/helmet').hostname, 'fc-moto.de');
  assert.equal(validateEdgePublicUrl('https://fdnyshop.com/product/jacket').hostname, 'fdnyshop.com');
  assert.equal(validateEdgePublicUrl('https://fe88store.com/item/1').hostname, 'fe88store.com');
  assert.throws(() => validateEdgePublicUrl('http://[::1]/secret'));
  assert.throws(() => validateEdgePublicUrl('http://[fc00::1]/secret'));
  assert.throws(() => validateEdgePublicUrl('http://[fd12:3456::1]/secret'));
  assert.throws(() => validateEdgePublicUrl('http://[fe80::1]/secret'));
});

test('scrapers prioritize Amazon buy-box price over earlier unrelated a-offscreen values', () => {
  const html = `
    <html><head><title>Sony Camera - Amazon.in</title></head>
    <body>
      <div class="nav-delivery"><span class="a-price"><span class="a-offscreen">₹40.00</span></span></div>
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price priceToPay"><span class="a-offscreen">₹89,990.00</span></span>
      </div>
    </body></html>
  `;
  const nodeRes = extractProductFromHtml(html, 'https://www.amazon.in/dp/B09CAMERA1');
  const edgeRes = extractProductFromHtmlEdge(html, 'https://www.amazon.in/dp/B09CAMERA1');
  assert.equal(nodeRes.price, 89990);
  assert.equal(edgeRes.price, 89990);
});

test('scrapers scan multiple JSON-LD Product blocks and nested AggregateOffer offers', () => {
  const html = `
    <html><head>
      <script type="application/ld+json">
        {"@type":"Product","name":"Apple iPad Air M3"}
      </script>
      <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Apple iPad Air M3",
          "offers": {
            "@type": "AggregateOffer",
            "offers": [
              {"@type": "Offer", "price": "64999", "priceCurrency": "INR", "availability": "https://schema.org/OutOfStock"},
              {"@type": "Offer", "price": "59990", "priceCurrency": "INR", "availability": "https://schema.org/InStock"}
            ]
          }
        }
      </script>
    </head><body></body></html>
  `;
  const nodeRes = extractProductFromHtml(html, 'https://www.croma.com/apple-ipad-air/p/123');
  const edgeRes = extractProductFromHtmlEdge(html, 'https://www.croma.com/apple-ipad-air/p/123');
  assert.equal(nodeRes.price, 59990);
  assert.equal(edgeRes.price, 59990);
  assert.equal(nodeRes.inStock, true);
  assert.equal(edgeRes.inStock, true);
});

test('extractProductWithWorkersAi targets price window on long pages and handles trailing text with braces', async () => {
  const longNav = '<nav>' + 'Category Link Item '.repeat(400) + '</nav>';
  const longPadding = '<div>' + 'Promo banner text without currency '.repeat(250) + '</div>';
  const html = `
    <html><head><title>Bose QuietComfort Ultra</title></head>
    <body>${longNav}${longPadding}<h1>Bose QuietComfort Ultra</h1><main>Buy today for ₹29,900 with free delivery.</main></body></html>
  `;
  const url = 'https://www.reliancedigital.in/bose-qc-ultra/p/999';
  const base = extractProductFromHtmlEdge(html, url);
  let capturedPrompt = '';
  const mockAi = {
    async run(_model: string, input: { messages: Array<{ content: string }> }) {
      capturedPrompt = input.messages[1].content;
      return {
        response:
          'Here is the extracted data: {"title":"Bose QuietComfort Ultra","price":29900,"currency":"INR","inStock":true} (note: {currency confirmed})',
      };
    },
  };
  const res = await extractProductWithWorkersAi(mockAi, html, url, base);
  assert.match(capturedPrompt, /29,900/);
  assert.equal(res.fetchStatus, 'extracted');
  assert.equal(res.price, 29900);
});

test('formatCompactCurrency renders symbols for INR, USD, GBP, and EUR', () => {
  assert.equal(formatCompactCurrency(24990, 'INR'), '₹24,990');
  assert.equal(formatCompactCurrency(1299, 'USD'), '$1,299');
  assert.equal(formatCompactCurrency(499, 'GBP'), '£499');
  assert.equal(formatCompactCurrency(1299, 'EUR'), '€1.299');
});

