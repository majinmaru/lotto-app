/**
 * Netlify Function: /.netlify/functions/lotto
 *
 * type=latest  → 최신 회차 번호 반환
 * type=range&from=1&to=10 → 최대 10회차씩 반환 (타임아웃 방지)
 */

const https = require("https");
const http  = require("http");

// 리다이렉트 자동 추적 fetch (타임아웃 5초)
function fetchUrl(url, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error("too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 5000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,*/*" }
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
      res.on("data", c => raw += c);
      res.on("end", () => {
        const t = raw.trim();
        if (!t)            return reject(new Error("empty response"));
        if (t.startsWith("<")) return reject(new Error("html response"));
        try { resolve(JSON.parse(t)); }
        catch (e) { reject(new Error("json parse error: " + t.slice(0, 80))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// 단일 회차 조회
async function fetchDraw(drwNo) {
  const url = `https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=${drwNo}`;
  return fetchUrl(url);
}

// 날짜로 최신 회차 추정 (1회: 2002-12-07 KST)
function estimateLatest() {
  const first = Date.UTC(2002, 11, 7); // 2002-12-07 UTC
  const kstNow = Date.now() + 9 * 3600 * 1000;
  return Math.floor((kstNow - first) / (7 * 24 * 3600 * 1000)) + 1;
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
  const type = p.type || "draw";

  try {
    // ── latest ──────────────────────────────────────────────
    if (type === "latest") {
      const est = estimateLatest();
      // 추정값 기준 ±2 범위에서 실제 최신 회차 확인
      for (let n = est; n >= est - 2; n--) {
        try {
          const d = await fetchDraw(n);
          if (d && d.returnValue === "success") {
            return { statusCode: 200, headers: h,
              body: JSON.stringify({ latestDrwNo: n }) };
          }
        } catch (_) {}
      }
      // API 실패 시 추정값 반환
      return { statusCode: 200, headers: h,
        body: JSON.stringify({ latestDrwNo: est, estimated: true }) };
    }

    // ── range ───────────────────────────────────────────────
    if (type === "range") {
      const from = parseInt(p.from, 10);
      const to   = parseInt(p.to,   10);
      if (isNaN(from) || isNaN(to) || from < 1 || from > to) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "from/to 파라미터 오류" }) };
      }

      // ★ 1회 호출당 최대 10회차 — 타임아웃 방지의 핵심
      const MAX = 10;
      const end = Math.min(to, from + MAX - 1);

      // 10개 동시 요청 (10개는 5초 내 충분히 처리 가능)
      const settled = await Promise.allSettled(
        Array.from({ length: end - from + 1 }, (_, i) => fetchDraw(from + i))
      );

      const draws = settled
        .filter(r => r.status === "fulfilled" && r.value?.returnValue === "success")
        .map(r => {
          const d = r.value;
          // 필요한 필드만 추려서 응답 크기 최소화
          return {
            drwNo:    d.drwNo,
            drwNoDate: d.drwNoDate,
            drwtNo1:  d.drwtNo1, drwtNo2: d.drwtNo2, drwtNo3: d.drwtNo3,
            drwtNo4:  d.drwtNo4, drwtNo5: d.drwtNo5, drwtNo6: d.drwtNo6,
            bnusNo:   d.bnusNo,
          };
        });

      return { statusCode: 200, headers: h,
        body: JSON.stringify({ draws, from, to: end }) };
    }

    // ── draw (단일) ─────────────────────────────────────────
    if (type === "draw") {
      const drwNo = parseInt(p.drwNo, 10);
      if (!drwNo || drwNo < 1) {
        return { statusCode: 400, headers: h,
          body: JSON.stringify({ error: "drwNo 필요" }) };
      }
      const d = await fetchDraw(drwNo);
      return { statusCode: 200, headers: h, body: JSON.stringify(d) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "unknown type" }) };

  } catch (err) {
    console.error("[lotto]", err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
