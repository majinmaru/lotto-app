/**
 * Netlify Function: /api/lotto
 * 동행복권 API 프록시
 *
 * 수정 사항:
 *  - HTTP 리다이렉트 자동 추적
 *  - latest: 날짜 추정 + 단 1회 API 검증으로 타임아웃 방지
 *  - range: 동시 요청 수 제한(20개) + 재시도 로직
 */

const https = require("https");
const http = require("http");

// ── 리다이렉트 추적 포함 fetch ─────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LottoApp/1.0)",
        "Accept": "application/json, text/plain, */*",
      },
      timeout: 8000,
    }, (res) => {
      // 3xx 리다이렉트 처리
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume(); // 현재 응답 본문 무시
        return resolve(fetchUrl(redirectUrl, redirectCount + 1));
      }

      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (!data.trim()) return reject(new Error("Empty response"));
        // 동행복권이 간혹 HTML 에러 페이지를 200으로 내려주는 경우 방어
        if (data.trim().startsWith("<")) return reject(new Error("HTML response (not JSON)"));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

// ── 단일 회차 조회 (재시도 포함) ──────────────────────────
async function fetchDraw(drwNo, retries = 2) {
  const url = `https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=${drwNo}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await fetchUrl(url);
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 최신 회차 추정 (날짜 기반) ─────────────────────────────
function estimateLatestDrwNo() {
  // 1회차: 2002-12-07(토), 매주 토요일
  const firstDraw = new Date("2002-12-07T00:00:00+09:00");
  const now = new Date();
  const kstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // KST 보정
  const msSince = kstNow - firstDraw;
  const weeksSince = Math.floor(msSince / (7 * 24 * 60 * 60 * 1000));
  return weeksSince + 1;
}

// ── 배치 처리 (동시 N개 제한) ─────────────────────────────
async function fetchRangeBatch(from, to) {
  const CONCURRENCY = 20; // 동시 요청 수 제한
  const results = [];
  const numbers = [];
  for (let i = from; i <= to; i++) numbers.push(i);

  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const batch = numbers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((n) => fetchDraw(n, 1).catch(() => null))
    );
    results.push(...batchResults);
    // 배치 간 딜레이 (서버 부하 방지)
    if (i + CONCURRENCY < numbers.length) await sleep(200);
  }

  return results.filter((r) => r && r.returnValue === "success");
}

// ── 메인 핸들러 ───────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const type = params.type || "draw";

  try {
    // ── latest ──────────────────────────────────────────
    if (type === "latest") {
      const estimated = estimateLatestDrwNo();

      // 추정 회차 ±2 범위에서 실제 최신 회차 확인 (최대 3회 시도)
      for (let drwNo = estimated; drwNo >= estimated - 2; drwNo--) {
        try {
          const d = await fetchDraw(drwNo, 1);
          if (d && d.returnValue === "success") {
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ latestDrwNo: drwNo, draw: d }),
            };
          }
        } catch (_) {}
      }

      // API 호출 실패 시 날짜 추정값만 반환
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ latestDrwNo: estimated - 1, estimated: true }),
      };
    }

    // ── draw (단일 회차) ─────────────────────────────────
    if (type === "draw") {
      const drwNo = parseInt(params.drwNo, 10);
      if (!drwNo || isNaN(drwNo) || drwNo < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "drwNo required" }) };
      }
      const data = await fetchDraw(drwNo);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── range (범위 조회) ────────────────────────────────
    if (type === "range") {
      const from = parseInt(params.from, 10);
      const to = parseInt(params.to, 10);
      if (isNaN(from) || isNaN(to) || from > to || from < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "valid from/to required" }) };
      }
      // 함수 타임아웃(10s) 안에 처리 가능한 최대치: 50개
      const limit = Math.min(to - from + 1, 50);
      const draws = await fetchRangeBatch(from, from + limit - 1);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ draws, count: draws.length, from, to: from + limit - 1 }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown type" }) };

  } catch (err) {
    console.error("[lotto-fn] error:", err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
