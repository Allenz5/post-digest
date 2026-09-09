package main

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// 研究路径 MCP 工具的渲染。reddit、x、xiaohongshu 三个 server 的 search 返回同样
// 的几行——标题、作者+互动+日期、URL、摘要——调用方不用关心是哪个平台。这里的搜索
// 卡片不含正文，所以没有摘要那一行。
//
// 原先 dump 的 JSON 里 43% 是封面图和头像 URL，对调用方毫无用处。

const excerptCap = 2000

func excerpt(s string) string {
	flat := strings.Join(strings.Fields(s), " ")
	if len(flat) <= excerptCap {
		return flat
	}
	return fmt.Sprintf("%s… (全文 %d 字符)", flat[:excerptCap], len(flat))
}

// noteURL 把寻址一篇笔记所需的两个值折进一个标识符，这样调用方传 URL 的方式与
// reddit、x 和普通网页完全一致。
func noteURL(id, token string) string {
	if token == "" {
		return "https://www.xiaohongshu.com/explore/" + id
	}
	return "https://www.xiaohongshu.com/explore/" + id + "?xsec_token=" + url.QueryEscape(token)
}

// parseNoteURL 是 noteURL 的逆运算；直接传笔记 id 也接受。
func parseNoteURL(raw string) (id, token string) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Path == "" {
		return strings.TrimSpace(raw), ""
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	id = segments[len(segments)-1]
	return id, parsed.Query().Get("xsec_token")
}

func day(msSinceEpoch int64) string {
	if msSinceEpoch <= 0 {
		return ""
	}
	return time.UnixMilli(msSinceEpoch).Format("2006-01-02")
}

// renderFeedList 渲染笔记列表。search 和首页推荐共用——推荐流直接吐原始 JSON
// 会有几万字符，和搜索返回整段正文是同一个问题。
func renderFeedList(header string, feeds []xiaohongshu.Feed, empty string) string {
	if len(feeds) == 0 {
		return empty
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", header)
	for i, feed := range feeds {
		card := feed.NoteCard
		interact := card.InteractInfo
		fmt.Fprintf(&b, "%d. %s\n", i+1, card.DisplayTitle)
		// A search card carries no publish time — only the detail page does.
		// 推荐流的卡片只带点赞数，评论和收藏是空的——空字段不打，否则看着像坏了。
		stats := ""
		for _, kv := range [][2]string{
			{"♥", interact.LikedCount}, {"💬", interact.CommentCount}, {"⭐", interact.CollectedCount},
		} {
			if kv[1] != "" && kv[1] != "0" {
				stats += " " + kv[0] + kv[1]
			}
		}
		fmt.Fprintf(&b, "   @%s ·%s\n", card.User.Nickname, stats)
		fmt.Fprintf(&b, "   %s\n\n", noteURL(feed.ID, feed.XsecToken))
	}
	return strings.TrimRight(b.String(), "\n")
}

func renderSearchResults(query string, feeds []xiaohongshu.Feed) string {
	return renderFeedList(
		fmt.Sprintf("%d results for %q · xiaohongshu", len(feeds), query),
		feeds,
		fmt.Sprintf("no results for %q · xiaohongshu", query),
	)
}

// renderFeeds 首页推荐流。
func renderFeeds(feeds []xiaohongshu.Feed) string {
	return renderFeedList(
		fmt.Sprintf("%d posts · xiaohongshu 首页推荐", len(feeds)),
		feeds,
		"no posts · xiaohongshu 首页推荐",
	)
}

func renderComment(b *strings.Builder, comment xiaohongshu.Comment, depth int) {
	fmt.Fprintf(b, "%s♥%s @%s: %s\n",
		strings.Repeat("  ", depth), comment.LikeCount, comment.UserInfo.Nickname, excerpt(comment.Content))
	for _, sub := range comment.SubComments {
		renderComment(b, sub, depth+1)
	}
}

// attached 是随这段文字一起返回的图片张数。区分"有图但没带"和"图在下面"
// 是给调用方看的：前者意味着还有没读到的东西，后者意味着已经全在手里了。
func renderFeedDetail(link string, detail *xiaohongshu.FeedDetailResponse, attached int) string {
	note := detail.Note
	interact := note.InteractInfo

	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", note.Title)
	meta := fmt.Sprintf("@%s · ♥%s 💬%s ⭐%s", note.User.Nickname,
		interact.LikedCount, interact.CommentCount, interact.CollectedCount)
	if d := day(note.Time); d != "" {
		meta += " · " + d
	}
	if note.IPLocation != "" {
		meta += " · " + note.IPLocation
	}
	fmt.Fprintf(&b, "%s\n%s\n%s\n", meta, link, strings.Repeat("-", 60))
	if note.Desc != "" {
		fmt.Fprintf(&b, "%s\n", note.Desc)
	}
	if n := len(note.ImageList); n > 0 {
		if attached > 0 {
			fmt.Fprintf(&b, "(%d images, %d attached below — the note's content is in them, not in the text above)\n", n, attached)
		} else {
			fmt.Fprintf(&b, "(%d images)\n", n)
		}
	}

	// 页面只加载一屏评论；hasMore 是调用方判断"这是取样而非全部"的依据。
	fmt.Fprintf(&b, "%s\nCOMMENTS (%s of %s%s)\n", strings.Repeat("-", 60),
		fmt.Sprint(len(detail.Comments.List)), interact.CommentCount,
		map[bool]string{true: ", more not loaded", false: ""}[detail.Comments.HasMore])
	for _, comment := range detail.Comments.List {
		renderComment(&b, comment, 0)
	}
	return strings.TrimRight(b.String(), "\n")
}
