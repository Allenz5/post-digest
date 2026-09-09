.PHONY: setup build check clean rednote rednote-login x-login install uninstall schedule unschedule

# Four dependency systems, one per server runtime. `setup` brings all of them up
# from a fresh clone; `check` proves each server actually speaks MCP.

setup: .venv servers/linkedin/.venv servers/x/node_modules build

.venv:
	python3 -m venv .venv
	./.venv/bin/pip install -q -r requirements.txt

servers/linkedin/.venv:
	cd servers/linkedin && uv sync

servers/x/node_modules:
	cd servers/x && npm install

build: servers/x/dist servers/xiaohongshu/bin/xiaohongshu-mcp

servers/x/dist: servers/x/node_modules
	cd servers/x && npm run build

servers/xiaohongshu/bin/xiaohongshu-mcp:
	cd servers/xiaohongshu && go build -o bin/xiaohongshu-mcp .

# rednote speaks HTTP, not stdio — it has to be running before Claude Code
# can reach it. The other three are spawned on demand.
rednote:
	cd servers/xiaohongshu && ./bin/xiaohongshu-mcp -headless=true

# Same server with a window, for when a login needs watching rather than
# guessing. The QR itself comes back fine headless.
rednote-login:
	cd servers/xiaohongshu && ./bin/xiaohongshu-mcp -headless=false

# X keeps its session in AUTH_DIR. That path is pinned in mcp.json because the
# server's own default is relative and follows whatever cwd it is spawned with —
# which is how a login can look present and still not load.
x-login:
	cd servers/x && AUTH_DIR="$(CURDIR)/servers/x/.auth" npm run cli login

# Link everything into ~/.claude and register the director servers. Idempotent.
install: build
	@./scripts/install.sh

uninstall: unschedule
	@./scripts/uninstall.sh

# Run /feed_digest three times a day. Needs `make install` first (it renders the plist),
# and a repo that is NOT under ~/Desktop, ~/Documents or ~/Downloads — launchd is
# refused entry to those by TCC.
schedule:
	@cp build/com.post-digest.feed-digest.plist $(HOME)/Library/LaunchAgents/
	@launchctl bootout gui/$(shell id -u)/com.post-digest.feed-digest 2>/dev/null || true
	@launchctl bootstrap gui/$(shell id -u) $(HOME)/Library/LaunchAgents/com.post-digest.feed-digest.plist
	@echo "    scheduled com.post-digest.feed-digest"
	@echo "Fire one now with: launchctl kickstart -k gui/$(shell id -u)/com.post-digest.feed-digest"

unschedule:
	@launchctl bootout gui/$(shell id -u)/com.post-digest.feed-digest 2>/dev/null || true
	@rm -f $(HOME)/Library/LaunchAgents/com.post-digest.feed-digest.plist

check:
	@claude mcp list 2>&1 | grep -E 'reddit|^x:|linkedin|rednote' || echo "no servers found"

clean:
	rm -rf servers/x/dist servers/x/node_modules
	rm -rf servers/xiaohongshu/bin
	rm -rf servers/linkedin/.venv
	rm -rf .venv
	find . -name __pycache__ -not -path "./.venv/*" -exec rm -rf {} +
