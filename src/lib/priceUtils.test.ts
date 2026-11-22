import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextCheckAt,
  detectPlatform,
  evaluatePriceDrop,
  inferTitleFromUrl,
  isValidEmail,
  isValidTelegramChatId,
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
