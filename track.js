/* 주주도사 이용 흐름 측정 (Google Analytics 4)
 * 목적: 방문 → 로그인 → 사주 등록 → 풀이 → 결제 중 어디서 사람이 빠지는지 숫자로 본다.
 * 사용법: 아래 GA_ID 에 측정 ID(G-로 시작) 한 줄만 넣으면 켜진다. 비어 있으면 아무것도 보내지 않는다.
 * 원칙: 이름·생년월일·이메일·상담 내용 같은 개인정보는 절대 보내지 않는다. (행동 이름과 요금제·도사 종류만)
 * 확인: 주소 끝에 ?trackdebug=1 을 붙이면 보내는 이벤트가 브라우저 콘솔에 찍힌다.
 */
(function (root) {
  var GA_ID = ''; // 예: 'G-XXXXXXXXXX'

  var debug = false;
  try { debug = /[?&]trackdebug=1/.test(location.search); } catch (e) {}

  root.dataLayer = root.dataLayer || [];
  function gtag() { root.dataLayer.push(arguments); }

  if (GA_ID) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    // 광고 개인화 신호는 끈다. 주소의 쿼리(결제 복귀 값 등)는 보내지 않도록 경로만 기록한다.
    gtag('config', GA_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: location.origin + location.pathname
    });
  }

  // 허용된 값만 통과: 짧은 문자열·숫자·불리언 (실수로 긴 글이나 개인정보가 섞이는 것을 막는다)
  function clean(params) {
    var out = {};
    for (var k in (params || {})) {
      var v = params[k];
      if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.slice(0, 40);
    }
    return out;
  }

  root.track = function (name, params) {
    try {
      var p = clean(params);
      if (debug) console.log('[track]', name, p, GA_ID ? '' : '(GA_ID 없음 — 전송 안 함)');
      if (GA_ID) gtag('event', name, p);
    } catch (e) {}
  };
  // 요금제 등급처럼 사람 단위로 나눠 볼 값
  root.trackUser = function (props) {
    try {
      var p = clean(props);
      if (debug) console.log('[track:user]', p);
      if (GA_ID) gtag('set', 'user_properties', p);
    } catch (e) {}
  };
})(window);
