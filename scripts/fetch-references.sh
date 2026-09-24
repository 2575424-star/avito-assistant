#!/usr/bin/env sh
# Скачивает открытые проекты по Авито-чатам в ./references (папка в .gitignore)
# для сравнения с нашим кодом. Описание и выводы: docs/competitors.md
set -e
cd "$(dirname "$0")/.."
mkdir -p references
for repo in \
  marko1olo/avito-dental-ai-bot \
  elchin92/avito-mcp \
  MissiaL/avito-api \
  TripleA150/tg-support-bot \
  nikolaybiziaev-ship-it/avito-raw-export \
  ilyautov/avito-mcp-ru \
  18studio/avito_python_api
do
  dir="references/$(echo "$repo" | tr / _)"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull -q --ff-only && echo "обновлён $repo"
  else
    git clone -q --depth 1 "https://github.com/$repo.git" "$dir" && echo "скачан  $repo"
  fi
done
