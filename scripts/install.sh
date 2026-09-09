#!/bin/bash
# Install the toolkit into the user-level Claude Code directories.
#
# Everything real stays in this repo; only symlinks go into ~/.claude, so git
# remains the source of truth. The one thing that cannot be a symlink is the
# agent frontmatter: a user-level agent may declare its own MCP servers (which
# is the whole reason we are not a plugin), but neither ${HOME} nor ~ expands in
# that frontmatter — the command has to be an absolute path. So the agents are
# checked in as .md.in templates and rendered here.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/.claude/agents"
SKILLS="$HOME/.claude/skills"
BUILD="$ROOT/build/agents"

mkdir -p "$AGENTS" "$SKILLS" "$BUILD"

# launchd refuses to execute anything under these, and says only "Operation not
# permitted" with exit 126 when it happens. Better to fail here, loudly.
case "$ROOT/" in
  "$HOME"/Desktop/*|"$HOME"/Documents/*|"$HOME"/Downloads/*)
    echo "WARNING: $ROOT is under a TCC-protected directory."
    echo "         Skills and agents will work, but 'make schedule' will not:"
    echo "         launchd cannot execute files there. Move the repo to e.g."
    echo "         ~/workspace/ and re-run make install."
    echo ;;
esac

echo "==> rendering agent templates"
for tpl in "$ROOT"/agents/*.md.in; do
  name="$(basename "$tpl" .md.in)"
  sed "s|@@TOOLKIT_ROOT@@|$ROOT|g" "$tpl" > "$BUILD/$name.md"
  ln -sfn "$BUILD/$name.md" "$AGENTS/$name.md"
  echo "    $name"
done

echo "==> linking agents that need no rendering"
for src in "$ROOT"/agents/*.md; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  ln -sfn "$src" "$AGENTS/$name"
  echo "    ${name%.md}"
done

echo "==> linking skills"
for dir in "$ROOT"/skills/*/; do
  name="$(basename "$dir")"
  ln -sfn "${dir%/}" "$SKILLS/$name"
  echo "    /$name"
done

# Only the director profiles are registered globally. The explorer profiles are
# declared inside the agents that need them and exist nowhere else — that is the
# isolation: the main loop cannot read a page or a post body because it has no
# tool for it, not because it was told not to.
echo "==> registering director MCP servers (user scope)"
reg() {
  claude mcp remove --scope user "$1" >/dev/null 2>&1 || true
  shift
  claude mcp add --scope user "$@" >/dev/null
}

reg reddit reddit \
  -e "PYTHONPATH=$ROOT/servers" \
  -- "$ROOT/.venv/bin/python" -m mcp_servers.reddit_server --profile director
reg x x \
  -e "AUTH_DIR=$ROOT/servers/x/.auth" \
  -- node "$ROOT/servers/x/dist/mcp.js" --profile director
reg linkedin linkedin \
  -- "$ROOT/servers/linkedin/.venv/bin/linkedin-mcp-server" --transport stdio --log-level ERROR
claude mcp remove --scope user rednote >/dev/null 2>&1 || true
claude mcp add --scope user --transport http rednote http://localhost:18060/mcp >/dev/null
echo "    reddit x linkedin rednote"

echo "==> rendering the launchd plist"
sed -e "s|@@TOOLKIT_ROOT@@|$ROOT|g" -e "s|@@HOME@@|$HOME|g" -e "s|@@USER@@|$(id -un)|g" \
  "$ROOT/scripts/feed-digest.plist.in" > "$ROOT/build/com.post-digest.feed-digest.plist"
echo "    build/com.post-digest.feed-digest.plist  (run 'make schedule' to load it)"

cat <<EOF

Installed. Restart Claude Code, then:

  /feed_digest             screen the four social feeds into Notion

Isolation check — the main loop should NOT see any of these:
  mcp__x__get_post, mcp__reddit__get_post, mcp__rednote__get_post
EOF
