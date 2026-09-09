"""Pacing and backoff for every tool call that drives the browser.

`SequentialToolExecutionMiddleware` already guarantees that only one tool call
touches the browser at a time. What it does not do is leave a gap between them,
and a burst of scrapes with no gap is the pattern that gets an account
restricted. That matters more here than it looks: reading one feed is a couple
of page loads, but a run that searches ten queries three pages deep and then
opens twenty profiles is closer to seventy-five — a different order of
magnitude against the same account.

Rate limiting was detected and then thrown away. `detect_rate_limit` raises,
`_RATE_LIMITED_MSG` comes back for the soft case, the extractor retries once
after five seconds — and the next call goes straight back in as if nothing had
happened. `penalize` is what makes being blocked change the server's behaviour
rather than only its error message.

There is no `wait` tool to sit out a cooldown with, and sleeping through one
inside a call would hit the 180s tool timeout anyway. So a cooling server
refuses instead: a caller that stops for the day is doing the right thing, and
retrying into a restriction is how a warning becomes a ban.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time

import mcp.types as mt

from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools import ToolResult

from linkedin_mcp_server.core.exceptions import RateLimitError

logger = logging.getLogger(__name__)

# LinkedIn is stricter about scraping than the other platforms here, and this
# floor is the main thing standing between a long run and a restricted account.
# Sixty tool calls at ~9s average is about nine minutes of pure waiting, which
# is a price worth paying for a job nobody is waiting on.
PACE_MIN_SECONDS = 6.0
PACE_JITTER_SECONDS = 6.0

# Deliberately harsher than a rate limit deserves, because the failure it is
# guarding against is not a slow run — it is losing the account.
BACKOFF_BASE_SECONDS = 60.0
BACKOFF_MAX_SECONDS = 30 * 60.0


class Throttle:
    """Paces browser-driving tool calls and backs off when LinkedIn pushes back."""

    def __init__(self) -> None:
        self._last = 0.0
        self._until = 0.0
        self._strikes = 0

    async def pace(self) -> None:
        """Block until enough time has passed since the previous call."""
        gap = PACE_MIN_SECONDS + random.random() * PACE_JITTER_SECONDS
        now = time.monotonic()
        wait = 0.0 if self._last == 0.0 else self._last + gap - now
        # Claim the slot before sleeping so concurrent waiters cannot all
        # measure the gap from the same starting point.
        self._last = now + max(0.0, wait)
        if wait > 0:
            await asyncio.sleep(wait)

    def cooling(self) -> str | None:
        """The reason to refuse this call, or None when it may proceed."""
        remaining = self._until - time.monotonic()
        if remaining <= 0:
            return None
        return (
            f"LinkedIn rate-limited this session — {int(remaining)}s of cooldown left "
            f"({self._strikes} in a row). This server will not retry into a "
            f"restriction: stop reading LinkedIn for now and report the run as "
            f"incomplete rather than working around this."
        )

    def penalize(self) -> None:
        self._strikes += 1
        wait = min(BACKOFF_BASE_SECONDS * 2 ** (self._strikes - 1), BACKOFF_MAX_SECONDS)
        self._until = time.monotonic() + wait
        logger.warning(
            "LinkedIn rate limit #%d — refusing tool calls for %.0fs",
            self._strikes,
            wait,
        )

    def succeed(self) -> None:
        self._strikes = 0
        self._until = 0.0


class ThrottleMiddleware(Middleware):
    """Applies the throttle to every tool call that drives the browser.

    Registered after ``SequentialToolExecutionMiddleware`` so it runs inside
    that lock: pacing outside the lock would let calls queue up and then fire
    back to back the moment it released, which is the burst it exists to stop.
    """

    # Nothing here touches LinkedIn, so nothing here should wait or be refused.
    _EXEMPT = frozenset({"close_session"})

    def __init__(self, throttle: Throttle | None = None) -> None:
        self._throttle = throttle or Throttle()

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        tool_name = context.message.name
        if tool_name in self._EXEMPT:
            return await call_next(context)

        cooling = self._throttle.cooling()
        if cooling:
            raise ToolError(cooling)

        await self._throttle.pace()

        try:
            result = await call_next(context)
        except RateLimitError:
            # Detected here since the beginning and acted on by nothing.
            self._throttle.penalize()
            raise

        # The soft case never raises: the extractor swallows it, retries once,
        # and hands back a sentinel as if it were content. Left unread, the run
        # keeps hammering a session LinkedIn has already started refusing.
        if "[Rate limited]" in str(result.structured_content):
            self._throttle.penalize()
            logger.warning("Soft rate limit in '%s' result", tool_name)
            return result

        self._throttle.succeed()
        return result
