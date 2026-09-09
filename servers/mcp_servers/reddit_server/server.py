"""Reddit tools over redditwarp, exposed as an MCP server.

Originally derived from Hawstein/mcp-server-reddit (MIT, Copyright (c) 2025
Hawstein); maintained here independently — no upstream sync.
"""

from enum import Enum
import json
import re
import redditwarp.SYNC
import redditwarp.models.subreddit
from mcp.server import MCPServer
from pydantic import BaseModel

# Workaround for redditwarp bug: Reddit sometimes omits 'active_user_count'
# from subreddit JSON, causing KeyError in Subreddit.__init__.
if not getattr(redditwarp.models.subreddit.Subreddit.__init__, '_patched', False):
    _original_subreddit_init = redditwarp.models.subreddit.Subreddit.__init__

    def _patched_subreddit_init(self, d, *args, **kwargs):
        if 'active_user_count' not in d:
            d = dict(d)
            d['active_user_count'] = None
        _original_subreddit_init(self, d, *args, **kwargs)

    _patched_subreddit_init._patched = True
    redditwarp.models.subreddit.Subreddit.__init__ = _patched_subreddit_init


class PostType(str, Enum):
    LINK = "link"
    TEXT = "text"
    GALLERY = "gallery"
    UNKNOWN = "unknown"


class SubredditInfo(BaseModel):
    name: str
    subscriber_count: int
    description: str | None


class Post(BaseModel):
    id: str
    title: str
    author: str
    score: int
    subreddit: str
    url: str
    created_at: str
    comment_count: int
    post_type: PostType
    content: str | None


class Comment(BaseModel):
    id: str
    author: str
    body: str
    score: int
    replies: list['Comment'] = []


class Moderator(BaseModel):
    name: str


class PostDetail(BaseModel):
    post: Post
    comments: list[Comment]


class RedditServer:
    def __init__(self):
        self.client = redditwarp.SYNC.Client()

    def _get_post_type(self, submission) -> PostType:
        """Helper method to determine post type"""
        if isinstance(submission, redditwarp.models.submission_SYNC.LinkPost):
            return PostType.LINK
        elif isinstance(submission, redditwarp.models.submission_SYNC.TextPost):
            return PostType.TEXT
        elif isinstance(submission, redditwarp.models.submission_SYNC.GalleryPost):
            return PostType.GALLERY
        return PostType.UNKNOWN

    # The type can actually be determined by submission.post_hint
    # - self for text
    # - image for image
    # - hosted:video for video
    def _get_post_content(self, submission) -> str | None:
        """Helper method to extract post content based on type"""
        if isinstance(submission, redditwarp.models.submission_SYNC.LinkPost):
            return submission.permalink
        elif isinstance(submission, redditwarp.models.submission_SYNC.TextPost):
            return submission.body
        elif isinstance(submission, redditwarp.models.submission_SYNC.GalleryPost):
            return str(submission.gallery_link)
        return None

    def _build_post(self, submission) -> Post:
        """Helper method to build Post object from submission"""
        return Post(
            id=submission.id36,
            title=submission.title,
            author=submission.author_display_name or '[deleted]',
            score=submission.score,
            subreddit=submission.subreddit.name,
            url=submission.permalink,
            created_at=submission.created_at.astimezone().isoformat(),
            comment_count=submission.comment_count,
            post_type=self._get_post_type(submission),
            content=self._get_post_content(submission)
        )

    def get_frontpage_posts(self, limit: int = 10) -> list[Post]:
        """Get hot posts from Reddit frontpage"""
        posts = []
        for subm in self.client.p.front.pull.hot(limit):
            posts.append(self._build_post(subm))
        return posts

    def get_subreddit_info(self, subreddit_name: str) -> SubredditInfo:
        """Get information about a subreddit"""
        subr = self.client.p.subreddit.fetch_by_name(subreddit_name)
        return SubredditInfo(
            name=subr.name,
            subscriber_count=subr.subscriber_count,
            description=subr.public_description
        )

    def _build_comment_tree(self, node, depth: int = 3) -> Comment | None:
        """Helper method to recursively build comment tree"""
        if depth <= 0 or not node:
            return None

        comment = node.value
        replies = []
        for child in node.children:
            child_comment = self._build_comment_tree(child, depth - 1)
            if child_comment:
                replies.append(child_comment)

        return Comment(
            id=comment.id36,
            author=comment.author_display_name or '[deleted]',
            body=comment.body,
            score=comment.score,
            replies=replies
        )

    def get_subreddit_hot_posts(self, subreddit_name: str, limit: int = 10) -> list[Post]:
        """Get hot posts from a specific subreddit"""
        posts = []
        for subm in self.client.p.subreddit.pull.hot(subreddit_name, limit):
            posts.append(self._build_post(subm))
        return posts

    def get_subreddit_new_posts(self, subreddit_name: str, limit: int = 10) -> list[Post]:
        """Get new posts from a specific subreddit"""
        posts = []
        for subm in self.client.p.subreddit.pull.new(subreddit_name, limit):
            posts.append(self._build_post(subm))
        return posts

    def get_subreddit_top_posts(self, subreddit_name: str, limit: int = 10, time: str = '') -> list[Post]:
        """Get top posts from a specific subreddit"""
        posts = []
        for subm in self.client.p.subreddit.pull.top(subreddit_name, limit, time=time):
            posts.append(self._build_post(subm))
        return posts

    def get_subreddit_rising_posts(self, subreddit_name: str, limit: int = 10) -> list[Post]:
        """Get rising posts from a specific subreddit"""
        posts = []
        for subm in self.client.p.subreddit.pull.rising(subreddit_name, limit):
            posts.append(self._build_post(subm))
        return posts

    def get_post_content(self, post_id: str, comment_limit: int = 10, comment_depth: int = 3) -> PostDetail:
        """Get detailed content of a specific post including comments"""
        submission = self.client.p.submission.fetch(post_id)
        post = self._build_post(submission)

        # Fetch comments
        comments = self.get_post_comments(post_id, comment_limit)
        
        return PostDetail(post=post, comments=comments)

    def get_post_comments(self, post_id: str, limit: int = 10) -> list[Comment]:
        """Get comments from a post"""
        comments = []
        tree_node = self.client.p.comment_tree.fetch(post_id, sort='top', limit=limit)
        for node in tree_node.children:
            comment = self._build_comment_tree(node)
            if comment:
                comments.append(comment)
        return comments

    def search_posts(self, query: str, subreddit_name: str = '', limit: int = 10,
                     sort: str = 'relevance', time: str = 'all') -> list[Post]:
        """Search for posts across Reddit, or within one subreddit if given"""
        posts = []
        for subm in self.client.p.submission.search(subreddit_name, query, limit, sort=sort, time=time):
            posts.append(self._build_post(subm))
        return posts


EXCERPT_CAP = 2000


def _excerpt(text: str | None) -> str:
    """One-line body excerpt for search results. A search tool that returns whole
    post bodies is unbounded — the longest measured here was 19,426 characters."""
    if not text:
        return ""
    text = " ".join(text.split())
    if len(text) <= EXCERPT_CAP:
        return text
    return f"{text[:EXCERPT_CAP]}… (full body {len(text)} chars — get_post to read it)"


def _post_id(url: str) -> str:
    """id36 out of a permalink; a bare id passes through."""
    m = re.search(r"/comments/([a-z0-9]+)", url)
    return m.group(1) if m else url.strip().strip("/").split("/")[-1]


def _render_posts(header: str, posts: list[Post], empty: str) -> str:
    """Shared rendering for anything that returns a list of posts. Feeds go through
    here too, not just search: a feed that returns whole bodies is just as unbounded."""
    if not posts:
        return empty
    lines = [f"{header}\n"]
    for i, post in enumerate(posts, 1):
        lines.append(f"{i}. {post.title}")
        lines.append(
            f"   @{post.author} · ↑{post.score} 💬{post.comment_count} · {post.created_at[:10]} · r/{post.subreddit}"
        )
        lines.append(f"   {post.url}")
        # For link and gallery posts `content` is just a URL again — no excerpt.
        if post.post_type is PostType.TEXT and (ex := _excerpt(post.content)):
            lines.append(f"   {ex}")
        lines.append("")
    return "\n".join(lines).rstrip()


def _render_results(query: str, posts: list[Post]) -> str:
    return _render_posts(
        f'{len(posts)} results for "{query}" · reddit',
        posts,
        f'no results for "{query}" · reddit',
    )


def _render_feed(label: str, posts: list[Post]) -> str:
    return _render_posts(f"{len(posts)} posts · {label}", posts, f"no posts · {label}")


def _render_comment(comment: Comment, depth: int = 0) -> list[str]:
    pad = "  " * depth
    body = " ".join((comment.body or "").split())
    out = [f"{pad}↑{comment.score} @{comment.author}: {body}"]
    for reply in comment.replies:
        out += _render_comment(reply, depth + 1)
    return out


def _render_post(detail: PostDetail) -> str:
    post = detail.post
    lines = [
        post.title,
        f"@{post.author} · ↑{post.score} 💬{post.comment_count} · {post.created_at[:10]} · r/{post.subreddit}",
        post.url,
        "-" * 60,
    ]
    if post.post_type is PostType.TEXT:
        lines.append(post.content or "(empty body)")
    elif post.content:
        lines.append(f"({post.post_type.value} post) {post.content}")
    lines += ["-" * 60, f"COMMENTS ({len(detail.comments)} of {post.comment_count})"]
    for comment in detail.comments:
        lines += _render_comment(comment)
    return "\n".join(lines)


def _dump(result) -> str:
    return json.dumps(result, default=lambda x: x.model_dump(), indent=2)


def _register_browse(mcp: MCPServer, reddit: RedditServer) -> None:
    """Director profile: find posts, never read them. Everything here returns a
    bounded line per post — title, author, engagement, URL, capped excerpt."""
    @mcp.tool()
    def get_frontpage_posts(limit: int = 10) -> str:
        """Get hot posts from Reddit frontpage.

        Args:
            limit: Number of posts to return (default 10, max 100).
        """
        return _render_feed("reddit frontpage (r/all, anonymous — not your subscriptions)", reddit.get_frontpage_posts(limit))

    @mcp.tool()
    def get_subreddit_info(subreddit_name: str) -> str:
        """Get information about a subreddit.

        Args:
            subreddit_name: Name of the subreddit (e.g. 'Python', 'news').
        """
        return _dump(reddit.get_subreddit_info(subreddit_name))

    @mcp.tool()
    def get_subreddit_hot_posts(subreddit_name: str, limit: int = 10) -> str:
        """Get hot posts from a specific subreddit.

        Args:
            subreddit_name: Name of the subreddit (e.g. 'Python', 'news').
            limit: Number of posts to return (default 10, max 100).
        """
        return _render_feed(f"r/{subreddit_name} · hot", reddit.get_subreddit_hot_posts(subreddit_name, limit))

    @mcp.tool()
    def get_subreddit_new_posts(subreddit_name: str, limit: int = 10) -> str:
        """Get new posts from a specific subreddit.

        Args:
            subreddit_name: Name of the subreddit (e.g. 'Python', 'news').
            limit: Number of posts to return (default 10, max 100).
        """
        return _render_feed(f"r/{subreddit_name} · new", reddit.get_subreddit_new_posts(subreddit_name, limit))

    @mcp.tool()
    def get_subreddit_top_posts(subreddit_name: str, limit: int = 10, time: str = "") -> str:
        """Get top posts from a specific subreddit.

        Args:
            subreddit_name: Name of the subreddit (e.g. 'Python', 'news').
            limit: Number of posts to return (default 10, max 100).
            time: Time filter — '', 'hour', 'day', 'week', 'month', 'year' or 'all'.
        """
        return _render_feed(f"r/{subreddit_name} · top", reddit.get_subreddit_top_posts(subreddit_name, limit, time))

    @mcp.tool()
    def get_subreddit_rising_posts(subreddit_name: str, limit: int = 10) -> str:
        """Get rising posts from a specific subreddit.

        Args:
            subreddit_name: Name of the subreddit (e.g. 'Python', 'news').
            limit: Number of posts to return (default 10, max 100).
        """
        return _render_feed(f"r/{subreddit_name} · rising", reddit.get_subreddit_rising_posts(subreddit_name, limit))

    @mcp.tool()
    def search(
        query: str,
        subreddit: str = "",
        limit: int = 10,
        sort: str = "relevance",
        time: str = "all",
    ) -> str:
        """Search posts across all of Reddit, or within a single subreddit.

        Returns one entry per post: title, author, engagement, date, URL and a body
        excerpt. Pass a URL to `get_post` to read the post and its comments.

        Args:
            query: Search query.
            subreddit: Limit the search to one subreddit. Omit to search all of Reddit.
            limit: Number of posts to return (default 10, max 100).
            sort: 'relevance', 'hot', 'top', 'new' or 'comments'.
            time: 'all', 'hour', 'day', 'week', 'month' or 'year'.
        """
        return _render_results(query, reddit.search_posts(query, subreddit, limit, sort, time))


def _register_read(mcp: MCPServer, reddit: RedditServer) -> None:
    """Explorer profile: the post body and its comment tree, both unbounded.
    This is the half that must not reach the main loop, so it is registered
    only when the server is started with --profile explorer."""
    @mcp.tool()
    def get_post(url: str, comment_limit: int = 10, comment_depth: int = 3) -> str:
        """Read one post in full: body and comment tree.

        Args:
            url: The post's URL, as returned by `search`.
            comment_limit: Number of top-level comments to return (default 10, max 100).
            comment_depth: Maximum depth of the comment tree (default 3, max 10).
        """
        return _render_post(reddit.get_post_content(_post_id(url), comment_limit, comment_depth))

    @mcp.tool()
    def get_post_comments(post_id: str, limit: int = 10) -> str:
        """Get comments from a post.

        Args:
            post_id: ID of the post.
            limit: Number of comments to return (default 10, max 100).
        """
        return _dump(reddit.get_post_comments(post_id, limit))


def build(profile: str = "director") -> MCPServer:
    mcp = MCPServer(name=f"reddit-{profile}")
    reddit = RedditServer()
    if profile == "director":
        _register_browse(mcp, reddit)
    else:
        _register_read(mcp, reddit)
    return mcp
