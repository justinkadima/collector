package vault

import (
	"regexp"
	"strings"
	"time"
)

// Events live in the page that owns them, in a fenced block whose info string
// is `events`:
//
//	```events
//	2026-11-24 09:30 Standup
//	Everyone in #eng, fifteen minutes.
//	```
//
// That is still an ordinary markdown code fence — an unknown language to any
// other renderer, nothing to lose when the file is opened in vim — and the
// calendar is a view over every page in the vault, not a store of its own.
// There is no second copy of an event anywhere.

// EventsLang is the fence language that marks an events block.
const EventsLang = "events"

// Event is one event: the line it was written on, its day, an optional time or
// time range, its title, and the description that follows it in the block —
// every line after it that is not another event. Line is 0-based within the
// page body, so the UI can scroll to it.
type Event struct {
	Date  string `json:"date"`
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	Title string `json:"title"`
	Desc  string `json:"desc,omitempty"`
	Line  int    `json:"line"`
}

var (
	eventOpenRe = regexp.MustCompile(`^\s*(` + "`{3,}" + `|~{3,})\s*` + EventsLang + `\s*$`)
	eventLineRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?)?\s+(\S.*)$`)
)

// ParseEvents returns every event written in the page body, in file order.
//
// One block is one event: the first line that parses is it, and everything
// after it that is not another event is its description — line breaks and all,
// because a description is prose. That is the whole grammar: a block with
// several event lines (an older page, or a hand-written one) is simply several
// events, each with the description that follows it. Lines before the first
// event belong to none of them and are ignored by the calendar, never guessed
// at.
func ParseEvents(body string) []Event {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	var out []Event
	for i := 0; i < len(lines); i++ {
		open := eventOpenRe.FindStringSubmatch(lines[i])
		if open == nil {
			continue
		}
		closer := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(open[1][:1]) + `{3,}\s*$`)
		cur := -1 // the event the next description line belongs to
		for i++; i < len(lines); i++ {
			if closer.MatchString(lines[i]) {
				break
			}
			if ev, ok := ParseEventLine(lines[i]); ok {
				ev.Line = i
				out = append(out, ev)
				cur = len(out) - 1
				continue
			}
			if cur < 0 {
				continue // text before the event belongs to nothing
			}
			text := strings.TrimSpace(lines[i])
			if text == "" && out[cur].Desc == "" {
				continue // leading blank lines do not start a description
			}
			if out[cur].Desc != "" {
				out[cur].Desc += "\n"
			}
			out[cur].Desc += text
		}
	}
	for i := range out {
		out[i].Desc = strings.TrimRight(out[i].Desc, "\n")
	}
	return out
}

// ParseEventLine reads one line of an events block: a date, an optional time or
// time range, then a title. A line without a title is not an event.
func ParseEventLine(line string) (Event, bool) {
	m := eventLineRe.FindStringSubmatch(strings.TrimSpace(line))
	if m == nil {
		return Event{}, false
	}
	if _, err := time.Parse("2006-01-02", m[1]); err != nil {
		return Event{}, false
	}
	title := strings.TrimSpace(m[4])
	if title == "" || strings.HasPrefix(title, "#") {
		return Event{}, false
	}
	ev := Event{Date: m[1], Title: title}
	if m[2] != "" {
		start, ok := clock(m[2])
		if !ok {
			return Event{}, false
		}
		ev.Start = start
		if m[3] != "" {
			end, ok := clock(m[3])
			if !ok {
				return Event{}, false
			}
			ev.End = end
		}
	}
	return ev, true
}

// clock normalises 9:30 to 09:30 and rejects impossible times.
func clock(s string) (string, bool) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return "", false
	}
	return t.Format("15:04"), true
}
