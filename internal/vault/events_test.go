package vault

import "testing"

// The events fence is a contract: the calendar, the page renderer and the
// index all read the same lines, so these cases are the format.
func TestParseEvents(t *testing.T) {
	body := "# Trip\n\n```events\n" +
		"2026-11-24 09:30 Standup\n" +
		"Everyone in #eng, fifteen minutes.\n" +
		"\n" +
		"# not a note once the event has started — part of the description\n" +
		"2026-11-24 14:00-15:00 Design review\n" +
		"Bring the deck.\n" +
		"Agenda: pricing and hiring\n" +
		"2026-11-26 Justin's birthday\n" +
		"\n" +
		"2026-11-27 9:05 Coffee with Sam\n" +
		"```\n\n" +
		"Outside the fence, 2026-11-30 10:00 Not an event\n" +
		"```events\n2026-12-01 08:00 Second block\n```\n"

	got := ParseEvents(body)
	want := []Event{
		{
			Date: "2026-11-24", Start: "09:30", Title: "Standup", Line: 3,
			Desc: "Everyone in #eng, fifteen minutes.\n\n# not a note once the event has started — part of the description",
		},
		{Date: "2026-11-24", Start: "14:00", End: "15:00", Title: "Design review", Desc: "Bring the deck.\nAgenda: pricing and hiring", Line: 7},
		{Date: "2026-11-26", Title: "Justin's birthday", Line: 10},
		{Date: "2026-11-27", Start: "09:05", Title: "Coffee with Sam", Line: 12},
		{Date: "2026-12-01", Start: "08:00", Title: "Second block", Line: 17},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d events, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// A line that looks like an event but is not (an impossible date, a bad time)
// is description text, not a second event: the block never guesses.
func TestParseEventsBadLineIsDescription(t *testing.T) {
	body := "```events\n2026-11-24 09:30 Standup\n2026-02-30 10:00 Impossible date\n2026-11-29\n```\n"
	got := ParseEvents(body)
	if len(got) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(got), got)
	}
	if got[0].Desc != "2026-02-30 10:00 Impossible date\n2026-11-29" {
		t.Errorf("desc = %q", got[0].Desc)
	}
}

// Text before the first event belongs to nothing, and is dropped rather than
// attached to a block that does not exist.
func TestParseEventsDescriptionBeforeEvent(t *testing.T) {
	got := ParseEvents("```events\nAgenda for the week\n2026-11-24 Standup\n```\n")
	if len(got) != 1 || got[0].Desc != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestParseEventsUnterminatedFence(t *testing.T) {
	// A half-typed block still counts: the calendar should not blink out while
	// the user is mid-line.
	got := ParseEvents("```events\n2026-11-24 09:30 Standup\n")
	if len(got) != 1 || got[0].Title != "Standup" {
		t.Fatalf("got %+v", got)
	}
}

func TestParseEventsTildeAndNoBody(t *testing.T) {
	if got := ParseEvents("~~~events\n~~~\n"); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
	if got := ParseEvents(""); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseEventLine(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want Event
	}{
		{"2026-11-24 Lunch", true, Event{Date: "2026-11-24", Title: "Lunch"}},
		{"2026-11-24 12:00 Lunch", true, Event{Date: "2026-11-24", Start: "12:00", Title: "Lunch"}},
		{"  2026-11-24   12:00   Lunch  ", true, Event{Date: "2026-11-24", Start: "12:00", Title: "Lunch"}},
		{"2026-11-24 12:00 - 13:30 Lunch", true, Event{Date: "2026-11-24", Start: "12:00", End: "13:30", Title: "Lunch"}},
		{"2026-11-24 24:00 Late", false, Event{}},
		{"24-11-2026 Lunch", false, Event{}},
		{"2026-11-24", false, Event{}},
		{"", false, Event{}},
		{"2026-11-24 12:00 # note", false, Event{}},
	}
	for _, c := range cases {
		got, ok := ParseEventLine(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("ParseEventLine(%q) = %+v, %v; want %+v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}
