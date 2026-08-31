package app

import (
	"fmt"
	"html"
	"io"
	"strconv"
	"strings"
	"unicode"

	xhtml "golang.org/x/net/html"
)

func parseHTML(raw string) (*xhtml.Node, error) {
	return xhtml.Parse(strings.NewReader(raw))
}

func attr(node *xhtml.Node, key string) string {
	if node == nil {
		return ""
	}
	for _, item := range node.Attr {
		if strings.EqualFold(item.Key, key) {
			return item.Val
		}
	}
	return ""
}

func hasAttr(node *xhtml.Node, key string) bool {
	if node == nil {
		return false
	}
	for _, item := range node.Attr {
		if strings.EqualFold(item.Key, key) {
			return true
		}
	}
	return false
}

func findFirst(root *xhtml.Node, predicate func(*xhtml.Node) bool) *xhtml.Node {
	if root == nil {
		return nil
	}
	if predicate(root) {
		return root
	}
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if found := findFirst(child, predicate); found != nil {
			return found
		}
	}
	return nil
}

func findAll(root *xhtml.Node, predicate func(*xhtml.Node) bool) []*xhtml.Node {
	var out []*xhtml.Node
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if node == nil {
			return
		}
		if predicate(node) {
			out = append(out, node)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return out
}

func nodeText(node *xhtml.Node) string {
	if node == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n.Type == xhtml.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == xhtml.ElementNode && (strings.EqualFold(n.Data, "br") || strings.EqualFold(n.Data, "div") || strings.EqualFold(n.Data, "p")) && b.Len() > 0 {
			b.WriteByte('\n')
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return cleanText(b.String())
}

func nodeLines(node *xhtml.Node) []string {
	if node == nil {
		return nil
	}
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n.Type == xhtml.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "br") {
			b.WriteByte('\n')
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
		if n.Type == xhtml.ElementNode && (strings.EqualFold(n.Data, "div") || strings.EqualFold(n.Data, "p")) {
			b.WriteByte('\n')
		}
	}
	walk(node)
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(b.String(), "\r", ""), "\n") {
		if line = cleanText(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func cleanText(value string) string {
	value = html.UnescapeString(strings.ReplaceAll(value, "\u00a0", " "))
	return strings.Join(strings.FieldsFunc(value, unicode.IsSpace), " ")
}

func hiddenValue(root *xhtml.Node, name string) string {
	node := findFirst(root, func(n *xhtml.Node) bool {
		return n.Type == xhtml.ElementNode && strings.EqualFold(n.Data, "input") && attr(n, "name") == name
	})
	return attr(node, "value")
}

func parsePositiveAttr(node *xhtml.Node, key string) int {
	n, err := strconv.Atoi(attr(node, key))
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// readLimited 读满 limit 字节就报错，而不是安静地截断。
// KKAP 全量开课安排 2026-08 已经是 9MB 并且逐年变大；如果哪天越过上限，
// 静默截断会喂给解析器半张表——行数可能仍然高于安全闸，于是坏数据一路发布出去。
// 宁可整轮失败留住旧数据，也不要发布一份看起来正常的残缺课表。
func readLimited(body io.Reader, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("响应超过 %d 字节上限，拒绝按截断内容解析", limit)
	}
	return raw, nil
}
