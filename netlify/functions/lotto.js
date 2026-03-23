/**
 * Netlify Function: /.netlify/functions/lotto
 *
 * 설계 원칙: 함수는 항상 50회차 이하만 처리 → 10초 타임아웃 내 안전
 * 클라이언트가 페이지 나눠 여러 번 호출 → freq 누적 후 localStorage 캐싱
 *
 * type=latest
 *   → { latestDrwNo: N }
 *
 * type=freq&from=1&to=50
 *   → { freq:{1:N,...45:N}, fetchedCount:N, from:N, to:N }
 *   → 최대 50회차씩만 처리
 *
 * type=check&nums=1,2,3,4,5,6
 *   → { matches:[{drwNo,drwNoDate}], totalDraws:N }
 *   → 당첨 이력도 50회차씩 나눠 클라이언트가 호출해야 함
 *
 * type=check-range&nums=1,2,3,4,5,6&from=1&to=50
 *   → { matches:[{drwNo,drwNoDate}] }
 */

const https = require("https");
const http  = require("http");

function fetchUrl(url, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error("too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      timeout: 4500,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,*/*" },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchUrl(next, hop + 1));
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => (raw += c));
      res.on("end", () => {
        const t = raw.trim();
        if (!t)               return reject(new Error("empty response"));
        if (t.startsWith("<")) return reject(new Error("html response"));
        try { resolve(JSON.parse(t)); }
        catch (e) { reject(new Error("json parse: " + t.slice(0, 60))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function fetchDraw(drwNo) {
  return fetchUrl(
    `https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=${drwNo}`
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function estimateLatest() {
  const first  = Date.UTC(2002, 11, 7);
  const kstNow = Date.now() + 9 * 3600 * 1000;
  return Math.floor((kstNow - first) / (7 * 24 * 3600 * 1000)) + 1;
}

async function resolveLatest() {
  const est = estimateLatest();
  for (let n = est; n >= est - 2; n--) {
    try {
      const d = await fetchDraw(n);
      if (d && d.returnValue === "success") return n;
    } catch (_) {}
  }
  return est - 1;
}

// 동시 20개 fetch (4.5초 타임아웃 × 20개 = 충분히 10초 이내)
async function fetchBatch(numbers) {
  const CONC = 20;
  const results = [];
  for (let i = 0; i < numbers.length; i += CONC) {
    const chunk = numbers.slice(i, i + CONC);
    const settled = await Promise.allSettled(chunk.map(n => fetchDraw(n)));
    settled.forEach(r => {
      if (r.status === "fulfilled" && r.value?.returnValue === "success")
        results.push(r.value);
    });
    if (i + CONC < numbers.length) await sleep(100);
  }
  return results;
}

// ── 핸들러 ────────────────────────────────────────────────
exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const p    = event.queryStringParameters || {};
  const type = p.type || "latest";

  try {

    // ── latest ──────────────────────────────────────────────
    if (type === "latest") {
      const latestDrwNo = await resolveLatest();
      return { statusCode: 200, headers: h,
        body: JSON.stringify({ latestDrwNo }) };
    }

    // ── freq (50회차 이하만 처리) ────────────────────────────
    if (type === "freq") {
      const from = Math.max(1, parseInt(p.from || "1", 10));
      const reqTo = parseInt(p.to || String(from + 49), 10);

      if (isNaN(from) || isNaN(reqTo) || from > reqTo) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "from/to 오류" }) };
      }

      // ★ 핵심: 최대 50회차로 제한 — 타임아웃 방지
      const to = Math.min(reqTo, from + 49);
      const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const draws = await fetchBatch(numbers);

      const freq = {};
      for (let i = 1; i <= 45; i++) freq[i] = 0;
      draws.forEach(d => {
        [d.drwtNo1, d.drwtNo2, d.drwtNo3, d.drwtNo4, d.drwtNo5, d.drwtNo6]
          .forEach(n => { if (n >= 1 && n <= 45) freq[n]++; });
      });

      return { statusCode: 200, headers: h,
        body: JSON.stringify({ freq, fetchedCount: draws.length, from, to }) };
    }

    // ── check-range (50회차 이하 당첨 이력 탐색) ─────────────
    if (type === "check-range") {
      if (!p.nums) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "nums required" }) };
      }
      const target = p.nums.split(",").map(Number).sort((a, b) => a - b);
      if (target.length !== 6 || target.some(n => isNaN(n) || n < 1 || n > 45)) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "nums: 1~45 숫자 6개 필요" }) };
      }

      const from = Math.max(1, parseInt(p.from || "1", 10));
      const reqTo = parseInt(p.to || String(from + 49), 10);
      const to = Math.min(reqTo, from + 49);
      const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const draws = await fetchBatch(numbers);

      const targetSet = new Set(target);
      const matches = draws
        .filter(d => [d.drwtNo1,d.drwtNo2,d.drwtNo3,d.drwtNo4,d.drwtNo5,d.drwtNo6]
          .every(n => targetSet.has(n)))
        .map(d => ({ drwNo: d.drwNo, drwNoDate: d.drwNoDate }));

      return { statusCode: 200, headers: h,
        body: JSON.stringify({ matches, from, to }) };
    }

    return { statusCode: 400, headers: h,
      body: JSON.stringify({ error: "unknown type. use: latest, freq, check-range" }) };

  } catch (err) {
    console.error("[lotto]", err.message);
    return { statusCode: 500, headers: h,
      body: JSON.stringify({ error: err.message }) };
  }
};
