# Sarjy — voice assistant

## Setup

You need a Groq API key: https://console.groq.com

```bash
cd server
cp .env.example .env      # paste your GROQ_API_KEY in here
npm install
npm run dev                # http://localhost:8787

# in a second terminal
cd client
npm install
npm run dev                # http://localhost:5173, proxies /api to :8787
```

For a single deployed URL (matching the PRD's "one URL, no setup" requirement):

```bash
cd client && npm run build   # outputs client/dist
cd ../server && npm start    # serves client/dist AND the API on one port
```