#!/bin/bash
# Undo scripts/install.sh. Leaves the repo untouched.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/.claude/agents"
SKILLS="$HOME/.claude/skills"

echo "==> unlinking agents"
for tpl in "$ROOT"/agents/*.md.in "$ROOT"/agents/*.md; do
  [ -e "$tpl" ] || continue
  name="$(basename "$tpl")"; name="${name%.md.in}"; name="${name%.md}"
  [ -L "$AGENTS/$name.md" ] && rm "$AGENTS/$name.md" && echo "    $name"
done

echo "==> unlinking skills"
for dir in "$ROOT"/skills/*/; do
  name="$(basename "$dir")"
  [ -L "$SKILLS/$name" ] && rm "$SKILLS/$name" && echo "    /$name"
done

echo "==> removing MCP servers"
for s in reddit x linkedin xiaohongshu; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 && echo "    $s"
done

rm -rf "$ROOT/build"
echo "Done. The repo itself is unchanged."
