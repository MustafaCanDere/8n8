#!/usr/bin/env bash
# 8n8'i başlatır. İlk çalıştırmada gerekli paketi kurar.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js bulunamadı. https://nodejs.org adresinden LTS sürümünü kurup tekrar deneyin."
  read -r -p "Kapatmak için Enter'a basın..." _; exit 1
fi
if [ ! -d node_modules/@anthropic-ai/sdk ]; then
  echo "İlk kurulum yapılıyor (npm install)..."
  npm install --omit=dev || { read -r -p "Kurulum başarısız. Kapatmak için Enter'a basın..." _; exit 1; }
fi
node server.js
