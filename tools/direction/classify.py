#!/usr/bin/env python3
"""수집된 답변의 '결론 방향'을 GO/CAUTION/WAIT/UNCLEAR 로 분류 (분류용 GPT-6 Luna, temperature 0)
사용: python3 classify.py out_luna.json labeled_luna.json"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
inp, outp = sys.argv[1], sys.argv[2]
rows = json.load(open(inp))
SYS = """상담 답변의 맨 앞부분을 읽고, 상담자 질문에 대한 '결론 방향'을 하나로 분류한다. 출력은 아래 라벨 단어 하나만.
GO: 해도 된다 / 하는 쪽이 낫다 / 추진하셔도 좋다 (무조건적 허용)
CAUTION: 하되 조건·준비를 갖춘 뒤 / 작게 시작 / 확정 후 움직이라 / 서두르지 말라 (올해 안에 조건부 가능)
WAIT: 지금(올해)은 하지 말라 / 다음 시기 이후로 미루라 / 기다리라
UNCLEAR: 결론이 없거나 단정이 어렵다고만 함"""
def lab(t):
    body = {'model': 'gpt-6-luna', 'reasoning_effort': 'none', 'temperature': 0, 'max_completion_tokens': 8,
            'messages': [{'role': 'system', 'content': SYS}, {'role': 'user', 'content': t[:450]}]}
    for a in range(5):
        try:
            req = urllib.request.Request('https://api.openai.com/v1/chat/completions', json.dumps(body).encode(),
                {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ.get('OPENAI_API_KEY', 'proxy-injected')})
            w = json.load(urllib.request.urlopen(req, timeout=60))['choices'][0]['message']['content'].strip().upper()
            for k in ('UNCLEAR', 'CAUTION', 'WAIT', 'GO'):
                if k in w: return k
            return 'UNCLEAR'
        except Exception: time.sleep(3 * (a + 1))
    return 'ERR'
ok = [r for r in rows if r.get('text')]
with ThreadPoolExecutor(6) as ex: labels = list(ex.map(lambda r: lab(r['text']), ok))
for r, l in zip(ok, labels): r['label'] = l
json.dump(ok, open(outp, 'w'), ensure_ascii=False)
print('labeled', len(ok), 'of', len(rows))
