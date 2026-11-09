# 상담 방향 일관성 검증 도구

같은 명식·같은 질문에 AI가 같은 방향으로 답하는지 재는 도구. (이직·창업·결혼·이사 4종 × 가상 명식 40개 × 3회)

```bash
# 1) 가상 명식 + 실제 서비스 프롬프트 생성 (이미 profiles.json 있음, 다시 만들 때만)
node tools/direction/gen_profiles.js 40 tools/direction/profiles.json

# 2) Claude 답변 수집 (약 480회 호출, 끊겨도 같은 명령으로 이어서)
ANTHROPIC_API_KEY=... python3 tools/direction/collect.py anthropic tools/direction/profiles.json tools/direction/out_claude.json 3

# 3) 결론 방향 분류 (분류에 OpenAI 키 사용)
OPENAI_API_KEY=... python3 tools/direction/classify.py tools/direction/out_claude.json tools/direction/labeled_claude.json
```
`result_luna_labeled.json` 은 GPT-6 Luna 로 같은 방식으로 돌린 결과. 키는 파일에 넣지 말고 환경변수로만 사용.
