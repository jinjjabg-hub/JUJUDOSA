/* 주주도사 요금제·한도 — 화면 표시(pricing.html, index.html)와 서버 강제(worker.js)가 같은 상수를 본다.
 * 숫자를 바꿀 때는 이 파일만 고치면 된다. (브라우저: 전역 PLANS / Worker: import)
 * 한도 단위: 매월 1일 00:00(KST) 리셋. 상담팩은 별도 잔액(리셋 없음, 구매일로부터 90일). */
(function (root) {
  var PLANS = {
    free:  { name: '무료',       price: 0,     limits: { reading: 1,  gunghap: 0,  consult: 3,   mbti: 0, daily: 4 } },
    // 1회성: 도사 1명 풀이 또는 궁합 1회 중 택1 (combined 로 합산 1회 제한)
    once:  { name: '1회 이용권', price: 1200,  limits: { reading: 1,  gunghap: 1,  consult: 6,   mbti: 0, daily: 4 },
             combined: { keys: ['reading', 'gunghap'], max: 1 } },
    basic: { name: '월 5,900',   price: 5900,  limits: { reading: 3,  gunghap: 2,  consult: 40,  mbti: 1, daily: 31 } },
    plus:  { name: '월 11,900',  price: 11900, limits: { reading: 6,  gunghap: 5,  consult: 90,  mbti: 1, daily: 62 }, hi: true },
    pro:   { name: '월 25,900',  price: 25900, limits: { reading: 11, gunghap: 10, consult: 200, mbti: 1, daily: 93 } }
  };
  // 예전 등급명 → 새 등급 (기존 회원 호환)
  var LEGACY = { lite: 'basic', standard: 'plus' };
  var PACK = { name: '상담팩', price: 9900, consult: 77, validDays: 90 };
  // 사용자에게 직접 보이지 않는 내부 호출(요약·digest)의 1인 1일 남용 방지 한도
  var INTERNAL_DAILY = { summary: 40, digest: 20 };

  root.PLANS = PLANS;
  root.PLAN_LEGACY = LEGACY;
  root.CONSULT_PACK = PACK;
  root.INTERNAL_DAILY = INTERNAL_DAILY;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PLANS: PLANS, PLAN_LEGACY: LEGACY, CONSULT_PACK: PACK, INTERNAL_DAILY: INTERNAL_DAILY };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
