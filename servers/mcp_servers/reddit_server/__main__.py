"""Reddit MCP server.

Two profiles over one codebase, same split as the firecrawl server: the director
browses and searches, the explorer reads bodies and comment trees.

    python -m mcp_servers.reddit_server --profile director
    python -m mcp_servers.reddit_server --profile explorer
"""

import argparse

from .server import build

parser = argparse.ArgumentParser(prog="reddit_server")
parser.add_argument("--profile", choices=("director", "explorer"), default="director")
build(parser.parse_args().profile).run("stdio")
