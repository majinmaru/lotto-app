/**
 * Netlify Function: /api/lotto
 * 동행복권 API를 중계하는 서버리스 프록시
 *
 * 사용 예:
 *   GET /api/lotto?type=draw&drwNo=1       → 특정 회차 당첨번호
 *   GET /api/lotto?type=latest             → 최신 회차 번호 조회
 *   GET /api/lotto?type=range&from=1&to=50 → 복수 회차 일괄 조회
 */

const https = require("https");

function fetchDraw(drwNo) {
  return new Promise((resolve, reject) => {
    const url = `https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=${drwNo}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("JSON parse error"));
        }
      });
    }).on("error", reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const type = params.type || "draw";

  try {
    // ── 1. 최신 회차 조회 ──────────────────────────────────────
    if (type === "latest") {
      // drwNo를 지정하지 않으면 최신 회차를 반환하는 API 특성 활용
      const data = await fetchDraw(99999); // 존재하지 않는 미래 회차 → returnValue: FAIL
      // 대신 현재 날짜 기반으로 추정 (2002-12-07 1회, 매주 토요일)
      const start = new Date("2002-12-07");
      const now = new Date();
      const weeks = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
      const estimated = weeks + 1;

      // 추정 회차부터 역방향으로 실제 존재하는 최신 회차 탐색
      for (let drwNo = estimated; drwNo >= estimated - 3; drwNo--) {
        try {
          const d = await fetchDraw(drwNo);
          if (d.returnValue === "success") {
            return { statusCode: 200, headers, body: JSON.stringify({ latestDrwNo: drwNo, draw: d }) };
          }
        } catch (_) {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ latestDrwNo: estimated - 1 }) };
    }

    // ── 2. 단일 회차 조회 ─────────────────────────────────────
    if (type === "draw") {
      const drwNo = parseInt(params.drwNo, 10);
      if (!drwNo || isNaN(drwNo)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "drwNo required" }) };
      }
      const data = await fetchDraw(drwNo);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── 3. 범위 일괄 조회 ─────────────────────────────────────
    if (type === "range") {
      const from = parseInt(params.from, 10);
      const to = parseInt(params.to, 10);
      if (isNaN(from) || isNaN(to) || from > to) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "valid from/to required" }) };
      }
      // 최대 100회차씩 처리 (Netlify function timeout 10s 이내)
      const limit = Math.min(to - from + 1, 100);
      const promises = [];
      for (let i = from; i < from + limit; i++) {
        promises.push(fetchDraw(i).catch(() => null));
      }
      const results = await Promise.all(promises);
      const draws = results.filter((r) => r && r.returnValue === "success");
      return { statusCode: 200, headers, body: JSON.stringify({ draws, count: draws.length }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown type" }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
