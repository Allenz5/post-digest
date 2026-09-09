package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// 小红书上有一类笔记把整个论点放在图里，正文只剩话题标签。对这种笔记，
// 只返回文字等于什么都没返回——调用方会照着标题瞎猜，或者干脆弃掉。
//
// 图片带回来是有代价的：一张 1080x1440 大约 2000 tokens，与字节数无关，
// 只看像素。所以这里不无条件带图，只在正文托不住笔记的时候带。
// 正常图文笔记走原来的路径，一分钱不多花。
const descTextThreshold = 80

// 图片链接的签名只活大约一分钟（路径里那段 202608240339 就是分钟级时间戳），
// 所以抓取必须在这里当场做完。把链接当文本交给调用方是行不通的：
// 等它拿去用的时候早就 403 了。
const imageFetchTimeout = 20 * time.Second

// 小红书的话题有两种写法：#话题[话题]# 和裸的 #话题。两种都是索引，不是内容。
var hashtagRE = regexp.MustCompile(`#[^#\s]*(?:\[[^\]]*\]#)?`)

// descCarriesContent 判断正文本身是否撑得起这篇笔记。
func descCarriesContent(desc string) bool {
	stripped := hashtagRE.ReplaceAllString(desc, "")
	stripped = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, stripped)
	return len([]rune(stripped)) >= descTextThreshold
}

// fetchNoteImages 把笔记的图片抓回来转成 MCP image content。
// 并发抓取但按原顺序返回：图文笔记的图是有叙述顺序的，打乱就读不出论证了。
// 单张失败不影响其他张——宁可少一张，不要整个工具调用失败。
func fetchNoteImages(ctx context.Context, images []xiaohongshu.DetailImageInfo) []MCPContent {
	ctx, cancel := context.WithTimeout(ctx, imageFetchTimeout)
	defer cancel()

	out := make([]MCPContent, len(images))
	var wg sync.WaitGroup
	for i, img := range images {
		// urlPre 与 urlDefault 像素相同，只是压得更狠。token 成本只看像素，
		// 所以省下的那点带宽换不来任何东西，反而可能糊掉图里的字。
		url := img.URLDefault
		if url == "" {
			url = img.URLPre
		}
		if url == "" {
			continue
		}
		wg.Add(1)
		go func(i int, url string) {
			defer wg.Done()
			data, mime, err := fetchImage(ctx, url)
			if err != nil {
				logrus.WithError(err).Warnf("笔记图片抓取失败: %s", url)
				return
			}
			out[i] = MCPContent{
				Type:     "image",
				Data:     base64.StdEncoding.EncodeToString(data),
				MimeType: mime,
			}
		}(i, url)
	}
	wg.Wait()

	contents := make([]MCPContent, 0, len(out))
	for _, c := range out {
		if c.Type == "image" {
			contents = append(contents, c)
		}
	}
	return contents
}

func fetchImage(ctx context.Context, url string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", &imageError{url: url, status: resp.StatusCode}
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = "image/webp"
	}
	return data, mime, nil
}

type imageError struct {
	url    string
	status int
}

func (e *imageError) Error() string {
	return http.StatusText(e.status) + " (" + e.url + ")"
}
