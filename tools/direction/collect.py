#!/usr/bin/env python3
"""가상 명식 × 결정형 질문 4종 × 반복 N회 답변 수집 (Claude/GPT 공용, 표준 라이브러리만 사용)
사용:
  GPT   : OPENAI_API_KEY=... python3 collect.py openai  profiles.json out_luna.json  [반복=3]
  Claude: ANTHROPIC_API_KEY=... python3 collect.py anthropic profiles.json out_claude.json [반복=3]
중간에 끊겨도 같은 명령을 다시 실행하면 이어서 진행한다."""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

prov, inp, outp = sys.argv[1], sys.argv[2], sys.argv[3]
REPS = int(sys.argv[4]) if len(sys.argv) > 4 else 3
QS = {'job': '올해 이직해도 될까요?', 'biz': '내년에 창업해도 될까요?',
      'wed': '올해 결혼해도 될까요? 사귄 지 2년 됐어요.', 'move': '올해 이사해도 될까요?'}
profiles = json.load(open(inp))
done = json.load(open(outp)) if os.path.exists(outp) else []
have = {(r['pid'], r['q'], r['rep']) for r in done}

def post(url, headers, body):
    for a in range(5):
        try:
            req = urllib.request.Request(url, json.dumps(body).encode(), headers)
            return json.load(urllib.request.urlopen(req, timeout=120))
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 502, 503, 529): time.sleep(5 * (a + 1)); continue
            return {'error': f'{e.code} {msg}'}
        except Exception as e:
            time.sleep(3 * (a + 1)); err = str(e)
    return {'error': 'retry exhausted'}

def ask(system, q):
    if prov == 'openai':
        d = post('https://api.openai.com/v1/chat/completions',
                 {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ.get('OPENAI_API_KEY', 'proxy-injected')},
                 {'model': 'gpt-6-luna', 'reasoning_effort': 'none', 'max_completion_tokens': 2000,
                  'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': q}]})
        if 'error' in d: return None, d['error']
        return d['choices'][0]['message']['content'], None
    d = post('https://api.anthropic.com/v1/messages',
             {'Content-Type': 'application/json', 'x-api-key': os.environ['ANTHROPIC_API_KEY'], 'anthropic-version': '2023-06-01'},
             {'model': 'claude-sonnet-5-5', 'max_tokens': 2000, 'thinking': {'type': 'between_tools'},
              'system': system, 'messages': [{'role': 'user', 'content': q}]})
    if 'error' in d and 'thinking' in str(d['error']):  # worker.js 와 같은 폴백
        d = post('https://api.anthropic.com/v1/messages',
                 {'Content-Type': 'application/json', 'x-api-key': os.environ['ANTHROPIC_API_KEY'], 'anthropic-version': '2023-06-01'},
                 {'model': 'claude-sonnet-5-5', 'max_tokens': 2000, 'output_config': {'effort': 'low'},
                  'system': system, 'messages': [{'role': 'user', 'content': q}]})
    if 'error' in d: return None, str(d['error'])
    return ''.join(b.get('text', '') for b in d['content']), None

jobs = [(p, k, q, r) for p in profiles for k, q in QS.items() for r in range(REPS) if (p['pid'], q, r) not in have]
print('남은 호출', len(jobs), '/ 전체', len(profiles) * len(QS) * REPS)

def run(j):
    p, k, q, r = j
    text, err = ask(p['system'], q)
    return {'pid': p['pid'], 'kind': k, 'q': q, 'rep': r, 'text': text, 'error': err}

with ThreadPoolExecutor(4) as ex:
    for i, row in enumerate(ex.map(run, jobs)):
        done.append(row)
        if i % 20 == 0:
            json.dump(done, open(outp, 'w'), ensure_ascii=False); print(i + 1, '/', len(jobs), flush=True)
json.dump(done, open(outp, 'w'), ensure_ascii=False)
print('완료', len(done), '오류', sum(1 for r in done if r['error']))
