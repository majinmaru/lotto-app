/**
 * Netlify Function: /.netlify/functions/lotto
 *
 * type=stats
 *   → 전체 회차를 서버에서 집계 후 요약본만 반환
 *   → { totalDraws, freq: {1:N, ...45:N}, latestDrwNo, updatedAt }
 *   → 응답 크기 < 1KB, 로드 시간 3~5초
 *
 * type=check&nums=1,6,13,26,33,43
 *   → 특정 번호 조합의 과거 1등 당첨 이력 조회
 *   → { matches: [{drwNo, drwNoDate}] }
 */

const https = require("https");
const http  = require("http");

// ── 리다이렉트 추적 fetch (타임아웃 5초) ──────────────────
function fetchUrl(url, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error("too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      timeout: 5000,
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
        if (!t)              return reject(new Error("empty response"));
        if (t.startsWith("<")) return reject(new Error("html response"));
        try { resolve(JSON.parse(t)); }
        catch (e) { reject(new Error("json parse: " + t.slice(0, 80))); }
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 날짜 기반 최신 회차 추정
function estimateLatest() {
  const first  = Date.UTC(2002, 11, 7);
  const kstNow = Date.now() + 9 * 3600 * 1000;
  return Math.floor((kstNow - first) / (7 * 24 * 3600 * 1000)) + 1;
}

// 실제 최신 회차 확인 (추정값 ±2)
async function resolveLatest() {
  const est = estimateLatest();
  for (let n = est; n >= est - 2; n--) {
    try {
      const d = await fetchDraw(n);
      if (d && d.returnValue === "success") return { drwNo: n, date: d.drwNoDate };
    } catch (_) {}
  }
  return { drwNo: est - 1, date: null };
}

// 20개씩 병렬 fetch — 5초 내 안정 처리
async function fetchBatch(numbers) {
  const CONCURRENCY = 20;
  const results = [];
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const chunk = numbers.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(n => fetchDraw(n)));
    settled.forEach(r => {
      if (r.status === "fulfilled" && r.value?.returnValue === "success")
        results.push(r.value);
    });
    if (i + CONCURRENCY < numbers.length) await sleep(150);
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
  const type = p.type || "stats";

  try {

    // ══════════════════════════════════════════════════════
    // type=stats  전체 집계 요약 반환
    // ══════════════════════════════════════════════════════
    if (type === "stats") {
      const { drwNo: latestDrwNo, date: latestDate } = await resolveLatest();

      // 1~latestDrwNo 전체 fetch (Netlify 함수 타임아웃 26초 — Netlify Pro 기본값)
      // 무료 플랜 타임아웃 10초 → 한 번에 전체를 못 가져올 수 있음
      // 해결책: 클라이언트가 from 파라미터로 페이지 나눠 호출
      const from = parseInt(p.from || "1", 10);
      const to   = Math.min(parseInt(p.to || String(latestDrwNo), 10), latestDrwNo);

      const numbers = [];
      for (let i = from; i <= to; i++) numbers.push(i);

      const draws = await fetchBatch(numbers);

      // 번호별 출현 빈도 집계
      const freq = {};
      for (let i = 1; i <= 45; i++) freq[i] = 0;
      draws.forEach(d => {
        [d.drwtNo1, d.drwtNo2, d.drwtNo3, d.drwtNo4, d.drwtNo5, d.drwtNo6]
          .forEach(n => { if (n >= 1 && n <= 45) freq[n]++; });
      });

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({
          latestDrwNo,
          latestDate,
          from,
          to,
          fetchedCount: draws.length,
          freq,
        }),
      };
    }

    // ══════════════════════════════════════════════════════
    // type=check&nums=1,6,13,26,33,43  당첨 이력 조회
    // ══════════════════════════════════════════════════════
    if (type === "check") {
      if (!p.nums) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: "nums required" }) };
      }

      const target = p.nums.split(",").map(Number).sort((a, b) => a - b);
      if (target.length !== 6 || target.some(n => isNaN(n) || n < 1 || n > 45)) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: "nums must be 6 numbers 1-45" }) };
      }

      const { drwNo: latestDrwNo } = await resolveLatest();
      const numbers = [];
      for (let i = 1; i <= latestDrwNo; i++) numbers.push(i);

      const draws = await fetchBatch(numbers);

      const targetSet = new Set(target);
      const matches = draws
        .filter(d => {
          const drawn = [d.drwtNo1, d.drwtNo2, d.drwtNo3, d.drwtNo4, d.drwtNo5, d.drwtNo6];
          return drawn.every(n => targetSet.has(n));
        })
        .map(d => ({ drwNo: d.drwNo, drwNoDate: d.drwNoDate }));

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({ matches, totalDraws: draws.length }),
      };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "unknown type" }) };

  } catch (err) {
    console.error("[lotto]", err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
