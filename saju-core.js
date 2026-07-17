/* 주주도사 만세력 코어 엔진 v0.1
   원칙: 계산은 코드, 해석은 AI. 이 파일은 계산만 담당한다.
   - 일주: 율리우스일(JDN) 기반 60갑자 (결정론적, 오차 없음)
   - 년주/월주: 태양 겉보기 황경 계산으로 절기 판정 (Meeus 저정밀, 오차 약 ±15분)
   - 시주: 일간 기준 오둔법
   - 보정: 한국 표준시 변경(1954~61), 서머타임(1948~60, 1987~88), 경도 보정
*/

const STEMS_HANJA = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const STEMS_KO    = ['갑','을','병','정','무','기','경','신','임','계'];
const BRANCH_HANJA= ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const BRANCH_KO   = ['자','축','인','묘','진','사','오','미','신','유','술','해'];

// 오행: 0목 1화 2토 3금 4수
const STEM_ELEM   = [0,0,1,1,2,2,3,3,4,4];
const BRANCH_ELEM = [4,2,0,0,2,1,1,2,3,3,2,4]; // 子수 丑토 寅목 卯목 辰토 巳화 午화 未토 申금 酉금 戌토 亥수
const ELEM_KO = ['목(木)','화(火)','토(土)','금(金)','수(水)'];

// ---------- 시간 보정 ----------

// 한국 서머타임 기간 (당시 시계 기준). 1987~88은 시각까지 확정, 이전은 날짜 단위(±1일 주의).
const DST_RANGES = [
  ['1948-06-01T00:00','1948-09-13T00:00', true],
  ['1949-04-03T00:00','1949-09-11T00:00', true],
  ['1950-04-01T00:00','1950-09-10T00:00', true],
  ['1951-05-06T00:00','1951-09-09T00:00', true],
  ['1955-05-05T00:00','1955-09-09T00:00', true],
  ['1956-05-20T00:00','1956-09-30T00:00', true],
  ['1957-05-05T00:00','1957-09-22T00:00', true],
  ['1958-05-04T00:00','1958-09-21T00:00', true],
  ['1959-05-03T00:00','1959-09-20T00:00', true],
  ['1960-05-01T00:00','1960-09-18T00:00', true],
  ['1987-05-10T02:00','1987-10-11T03:00', false],
  ['1988-05-08T02:00','1988-10-09T03:00', false],
];

// 표준시 UTC+8:30 사용 기간 (기준 자오선 127.5도)
const KST830_START = '1954-03-21T00:00';
const KST830_END   = '1961-08-10T00:00';

function tsKey(y,mo,d,h,mi){ // 비교용 문자열 키 'YYYY-MM-DDTHH:MM'
  const p=(n,w=2)=>String(n).padStart(w,'0');
  return `${p(y,4)}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
}

function analyzeCorrections(y,mo,d,h,mi, lonDeg, useLon){
  const key = tsKey(y,mo,d,h,mi);
  let dstMin = 0, dstFuzzy = false;
  for(const [s,e,fuzzy] of DST_RANGES){
    if(key >= s && key < e){ dstMin = -60; dstFuzzy = fuzzy; break; }
  }
  const is830 = (key >= KST830_START && key < KST830_END);
  const utcOffsetMin = (is830 ? 510 : 540) + (dstMin===-60 ? 60 : 0); // 시계가 UTC보다 앞선 분
  // 경도 보정: 시계 기준 자오선 대비 실제 경도의 차 (진태양시 근사, 균시차 미적용)
  const meridian = is830 ? 127.5 : 135.0;
  const lonMin = useLon ? Math.round((lonDeg - meridian) * 4) : 0;
  return { dstMin, dstFuzzy, is830, utcOffsetMin, lonMin, meridian };
}

// ---------- 달력 수학 ----------

function jdnFromDate(y, mo, d){ // 그레고리력 날짜 -> 율리우스일 번호(정오 기준 정수)
  const a = Math.floor((14 - mo) / 12);
  const yy = y + 4800 - a;
  const mm = mo + 12 * a - 3;
  return d + Math.floor((153*mm + 2)/5) + 365*yy + Math.floor(yy/4)
       - Math.floor(yy/100) + Math.floor(yy/400) - 32045;
}

function addMinutes(y,mo,d,h,mi, delta){ // 순수 달력 연산 (Date 타임존 이슈 회피)
  let total = h*60 + mi + delta;
  let dayShift = Math.floor(total / 1440);
  total -= dayShift * 1440;
  let jdn = jdnFromDate(y,mo,d) + dayShift;
  const dt = dateFromJdn(jdn);
  return { y:dt.y, mo:dt.mo, d:dt.d, h:Math.floor(total/60), mi:total%60 };
}

function dateFromJdn(jdn){
  let a = jdn + 32044;
  const b = Math.floor((4*a + 3)/146097);
  const c = a - Math.floor(146097*b/4);
  const dd = Math.floor((4*c + 3)/1461);
  const e = c - Math.floor(1461*dd/4);
  const m = Math.floor((5*e + 2)/153);
  return {
    d: e - Math.floor((153*m + 2)/5) + 1,
    mo: m + 3 - 12*Math.floor(m/10),
    y: 100*b + dd - 4800 + Math.floor(m/10)
  };
}

// ---------- 태양 황경 (Meeus 저정밀, 오차 ~0.01도 = 시간으로 약 15분) ----------

function sunApparentLongitude(jde){
  const T = (jde - 2451545.0) / 36525.0;
  const rad = Math.PI/180;
  const L0 = 280.46646 + 36000.76983*T + 0.0003032*T*T;
  const M  = 357.52911 + 35999.05029*T - 0.0001537*T*T;
  const C  = (1.914602 - 0.004817*T - 0.000014*T*T)*Math.sin(M*rad)
           + (0.019993 - 0.000101*T)*Math.sin(2*M*rad)
           + 0.000289*Math.sin(3*M*rad);
  const omega = 125.04 - 1934.136*T;
  let lon = L0 + C - 0.00569 - 0.00478*Math.sin(omega*rad);
  lon = lon % 360; if(lon < 0) lon += 360;
  return lon;
}

function jdeFromUT(y,mo,d,h,mi){ // UT -> 율리우스일 (실수)
  return jdnFromDate(y,mo,d) - 0.5 + (h + mi/60)/24;
}

// 입춘(황경 315도) 시각 탐색: 해당 연도 1/25 ~ 2/15 사이 이분 탐색, UT 기준 JDE 반환
function findIpchunJde(year){
  let lo = jdeFromUT(year,1,25,0,0), hi = jdeFromUT(year,2,15,0,0);
  // 315도 교차: (lon-315) 부호 변화 탐색. 연말 랩어라운드 처리 위해 각도차 함수 사용
  const f = (jde)=>{
    let diff = sunApparentLongitude(jde) - 315;
    while(diff > 180) diff -= 360;
    while(diff < -180) diff += 360;
    return diff;
  };
  for(let i=0;i<60;i++){
    const mid = (lo+hi)/2;
    if(f(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo+hi)/2;
}

// ---------- 사주 계산 본체 ----------

/**
 * @param {object} input
 *  y,mo,d,h,mi : 출생 당시 시계(호적) 기준
 *  timeUnknown : true면 시주 생략
 *  lonDeg      : 출생지 경도 (예: 부산 129.08)
 *  useLon      : 경도 보정 적용 여부
 *  yajasi      : true면 야자시(23~24시 출생을 당일 일주로)
 */
function computeSaju(input){
  const { y,mo,d,h=12,mi=0, timeUnknown=false, lonDeg=127.0, useLon=false, yajasi=false } = input;
  const corr = analyzeCorrections(y,mo,d,h,mi, lonDeg, useLon);

  // 1) 표준시(서머타임 제거) 시각
  const std = addMinutes(y,mo,d,h,mi, corr.dstMin);
  // 2) UT 시각 -> 절기 판정용
  const utOffset = corr.is830 ? 510 : 540;
  const ut = addMinutes(std.y,std.mo,std.d,std.h,std.mi, -utOffset);
  const jde = jdeFromUT(ut.y,ut.mo,ut.d,ut.h,ut.mi);
  const lon = sunApparentLongitude(jde);

  // 3) 년주: 입춘 기준
  let sajuYear = std.y;
  const ipchunThisYear = findIpchunJde(std.y);
  if(jde < ipchunThisYear) sajuYear = std.y - 1;
  const yearStem = ((sajuYear - 4) % 10 + 10) % 10;
  const yearBranch = ((sajuYear - 4) % 12 + 12) % 12;

  // 4) 월주: 황경 315도부터 30도 구간 = 인월(0) ~ 축월(11)
  const monthIdx = Math.floor((((lon - 315) % 360) + 360) % 360 / 30);
  const monthBranch = (monthIdx + 2) % 12; // 인=2
  const monthStemStart = (yearStem % 5) * 2 + 2; // 연상기월법
  const monthStem = (monthStemStart + monthIdx) % 10;

  // 5) 일주: 경도 보정 적용한 '체감 시각' 기준, 23시 이후는 다음 날(정자시) — 야자시 옵션 시 당일 유지
  const app = addMinutes(std.y,std.mo,std.d,std.h,std.mi, corr.lonMin);
  let dayJdn = jdnFromDate(app.y,app.mo,app.d);
  let lateNight = false;
  if(!timeUnknown && app.h === 23){ lateNight = true; if(!yajasi) dayJdn += 1; }
  const dayGz = ((dayJdn + 49) % 60 + 60) % 60;
  const dayStem = dayGz % 10, dayBranch = dayGz % 12;

  // 6) 시주: 오둔법
  let hourStem = null, hourBranch = null;
  if(!timeUnknown){
    const minutes = app.h*60 + app.mi;
    hourBranch = Math.floor(((minutes + 60) % 1440) / 120);
    const hourStemStart = (dayStem % 5) * 2;
    hourStem = (hourStemStart + hourBranch) % 10;
  }

  // 7) 절기 경계 근접 경고 (황경이 절입선 15도±0.1도 이내 = 약 ±2.4시간)
  let mod30 = ((lon % 30) + 30) % 30;
  const distDeg = Math.abs(mod30 - 15);
  const nearTerm = distDeg < 0.1;

  // 오행 집계
  const pillars = [
    {label:'년주', stem:yearStem, branch:yearBranch},
    {label:'월주', stem:monthStem, branch:monthBranch},
    {label:'일주', stem:dayStem, branch:dayBranch},
  ];
  if(hourStem !== null) pillars.push({label:'시주', stem:hourStem, branch:hourBranch});
  const elemCount = [0,0,0,0,0];
  for(const p of pillars){ elemCount[STEM_ELEM[p.stem]]++; elemCount[BRANCH_ELEM[p.branch]]++; }

  return {
    pillars, elemCount, sajuYear,
    sunLongitude: lon,
    corrections: {
      dstApplied: corr.dstMin !== 0, dstFuzzy: corr.dstFuzzy,
      kst830: corr.is830, lonMin: corr.lonMin, useLon, yajasi, lateNight,
      appliedTime: app, standardTime: std,
    },
    nearTerm,
    timeUnknown,
  };
}

function fmtPillar(p){
  return {
    label: p.label,
    hanja: STEMS_HANJA[p.stem] + BRANCH_HANJA[p.branch],
    ko: STEMS_KO[p.stem] + BRANCH_KO[p.branch],
    stemElem: STEM_ELEM[p.stem], branchElem: BRANCH_ELEM[p.branch],
    stemHanja: STEMS_HANJA[p.stem], branchHanja: BRANCH_HANJA[p.branch],
    stemKo: STEMS_KO[p.stem], branchKo: BRANCH_KO[p.branch],
  };
}

if (typeof module !== 'undefined') {
  module.exports = { computeSaju, fmtPillar, ELEM_KO, STEMS_HANJA, BRANCH_HANJA, findIpchunJde, sunApparentLongitude, jdeFromUT, jdnFromDate };
}
