// pricing.html 의 요금제 카드를 plans.js(서버 강제와 같은 상수)에서 생성한다.
// 사용: plans.js 를 고친 뒤 `node build-pricing.js`
const fs = require('fs');
const { PASS_DAYS, PLANS, CONSULT_PACK } = require('./plans.js');
const won = (n) => n.toLocaleString('en-US') + '원';

function items(k) {
  const L = PLANS[k].limits, out = [];
  if (PLANS[k].combined) out.push('도사 1명 풀이 또는 궁합 1회 (택 1)', '구매일로부터 ' + PASS_DAYS + '일 안에 사용 (지나면 소멸)');
  else {
    out.push('종합 풀이 ' + L.reading + '회' + (k === 'free' ? ' (본인)' : ' (본인+' + (L.reading - 1) + '인)'));
    if (L.gunghap) out.push('궁합 풀이 ' + L.gunghap + '회');
  }
  out.push('AI 사주 상담 ' + L.consult + '회');
  if (L.mbti) out.push('정밀 MBTI 분석 월 ' + L.mbti + '회');
  out.push(k === 'free' || k === 'once' ? '주간 운세' : '매일 운세');
  return out;
}
const card = (cls, name, price, per, lis) =>
  `    <div class="plan${cls}">\n      <div class="pname">${name}</div>\n      <div class="price">${price}${per ? ' <small>' + per + '</small>' : ''}</div>\n      <ul>\n${lis.map((l) => '        <li>' + l + '</li>').join('\n')}\n      </ul>\n    </div>`;

const cards = [
  card('', '무료', '0원', '', items('free')),
  card('', PLANS.once.name, won(PLANS.once.price), '/ 1회', items('once')),
  ...['basic', 'plus', 'pro'].map((k) => card(PLANS[k].hi ? ' hi' : '', PLANS[k].name + '원', won(PLANS[k].price), '/ 월', items(k))),
  card('', CONSULT_PACK.name, won(CONSULT_PACK.price), '', [
    'AI 사주 상담 ' + CONSULT_PACK.consult + '회',
    '구매일로부터 ' + CONSULT_PACK.validDays + '일 안에 사용 (지나면 남은 횟수 소멸)',
    '월 이용권의 상담 횟수를 먼저 쓰고, 소진 후 팩에서 차감',
  ]),
].join('\n');

const p = __dirname + '/pricing.html';
let html = fs.readFileSync(p, 'utf8');
const re = /(<!-- PLANS:START -->)[\s\S]*?(<!-- PLANS:END -->)/;
if (!re.test(html)) throw new Error('pricing.html 에 PLANS 마커가 없습니다');
html = html.replace(re, '$1\n' + cards + '\n  $2');
fs.writeFileSync(p, html);
console.log('pricing.html 갱신 완료');
